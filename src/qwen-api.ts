/**
 * AI 分析（走代理服务器）
 */
export interface InterviewMeta {
  company: string; position: string; round: string;
  type: string; language: string; selfFeeling: string;
  jobDesc: string; recruitType: string; recruitSeason: string; interviewDate: string;
}

interface ProxyConfig {
  licenseKey: string;
  proxyUrl: string;
  model: string;
}

function buildSystemPrompt(meta: InterviewMeta): string {
  const recruitInfo = meta.recruitType === "校招"
    ? `校招 · ${meta.recruitSeason}`
    : "社招";

  return `你是资深面试教练，请对以下面试录音转写文字稿进行全面的复盘分析。

## 面试背景
- 公司：${meta.company||"未提供"} | 职位：${meta.position||"未提供"}
- 轮次：${meta.round||"未提供"} | 类型：${meta.type||"未提供"} | 语言：${meta.language||"中英混合"}
- 招聘类型：${recruitInfo} | 面试时间：${meta.interviewDate||"未提供"}
- 自评：${meta.selfFeeling||"未提供"}
${meta.jobDesc ? `- 岗位描述：${meta.jobDesc}` : ""}

## 文字稿处理规则（重要）
1. 可以删除开头的寒暄打招呼内容（如"你好""听得到吗"等），但不能修改任何实际对话语句
2. 需要区分**面试官**和**面试者**的发言，用以下格式标注：
   **面试官：** [原话，不修改]
   **面试者：** [原话，不修改]
3. 不要改写、润色、总结任何对话——保留原始口语表达
4. 如果语音识别有歧义，保留原样，不要猜测修正

## 输出框架
### 一、总体评分（6维度1-10分）
### 二、逐题分析（回答摘要→亮点→改进→建议思路→优先级）
### 三、语言表达分析
### 四、回答结构分析
### 五、技术/专业深度分析（对照岗位JD）
### 六、沟通与软技能分析
### 七、核心问题清单（🟢🟡🔴）
### 八、改进建议（短期/中期/长期）
### 九、亮点总结（3-5个）
### 十、行动计划

请具体引用原话，给出可操作建议。中文输出。`;
}

function buildUserMessage(transcript: string, meta: InterviewMeta): string {
  return `以下是面试录音转写文字稿，请按分析框架进行复盘：

---

${transcript}

---

请开始分析。先输出整理后的Q&A对话（可删除开头的寒暄），然后输出复盘报告。`;
}

// ========== 对外接口 ==========

export interface AnalysisResult {
  report: string;
  metadata: { model: string };
}

export async function* analyzeTranscriptStream(
  transcript: string,
  meta: InterviewMeta,
  config: ProxyConfig
): AsyncGenerator<string> {
  // 长文本分片并行分析，每片最多 4000 字
  const MAX_INPUT = 4000;
  const parts: string[] = [];
  for (let i = 0; i < transcript.length; i += MAX_INPUT) {
    parts.push(transcript.substring(i, i + MAX_INPUT));
  }

  if (parts.length === 1) {
    yield* streamSingle(buildSystemPrompt(meta), parts[0], config);
    return;
  }

  // 并行：所有片同时分析
  yield "分析中...\n";
  const results = await Promise.all(
    parts.map((part, i) =>
      i === 0
        ? callNonStream(buildSystemPrompt(meta) + "\n注意：这是对话前半部分。", part, config)
        : callNonStream("这是对话后半部分，继续分析并给出总结。", part, config)
    )
  );
  yield results.join("\n\n");
}

async function callNonStream(
  systemPrompt: string,
  userContent: string,
  config: ProxyConfig
): Promise<string> {
  const response = await fetch(`${config.proxyUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.licenseKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });
  if (!response.ok) throw new Error(`API错误: ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function* streamSingle(
  systemPrompt: string,
  userContent: string,
  config: ProxyConfig
): AsyncGenerator<string> {
  const response = await fetch(`${config.proxyUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.licenseKey },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API错误: ${response.status} ${err}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取流式响应");

  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data: ")) continue;
      const d = s.slice(6);
      if (d === "[DONE]") return;
      try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) yield c; } catch {}
    }
  }
}
