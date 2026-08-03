/**
 * ASR 转写 + Q&A 排版（走代理服务器）
 */
import { requestUrl } from "obsidian";
import { getFfmpegPath } from "./audio-compress";

interface ProxyConfig {
  licenseKey: string;
  proxyUrl: string;
  model: string;
  asrProxyUrl: string;
}

export interface TranscriptionSentence {
  begin_time: number;
  end_time: number;
  text: string;
}

export interface TranscriptionResult {
  sentences: TranscriptionSentence[];
  markdown: string;
  duration: number;
}

interface ProxyConfig {
  licenseKey: string;
  proxyUrl: string;
  model: string;
  asrProxyUrl: string;
}

// 每片 body 上限（base64 后约 10MB，API 限制 20MB）
const MAX_CHUNK_RAW = 7 * 1024 * 1024; // 7MB raw → ~9MB base64 → ~10MB body

// fun-asr-flash 同步接口单次最长 5 分钟，取 4 分钟安全值
const MAX_CHUNK_SEC = 240;

/**
 * 用 ffprobe 获取音频时长（秒），失败返回 null
 */
async function getAudioDuration(filePath: string, ffmpegPath: string): Promise<number | null> {
  const { execSync } = require("child_process");
  const ffprobePath = ffmpegPath.replace(/ffmpeg/, "ffprobe");
  try {
    const output = execSync(
      `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: "utf8", timeout: 5000 }
    );
    return parseFloat(output.trim()) || null;
  } catch {
    return null;
  }
}

/**
 * 用 ffmpeg -c copy 按时间切片，不重编码，返回临时文件路径数组
 */
async function splitByTime(
  filePath: string,
  durationSec: number,
  chunkSec: number,
  ext: string,
  ffmpegPath: string
): Promise<string[]> {
  const path = require("path");
  const os = require("os");
  const { execSync } = require("child_process");

  const totalChunks = Math.ceil(durationSec / chunkSec);
  const chunks: string[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const startTime = i * chunkSec;
    const outPath = path.join(os.tmpdir(), `ir_chunk_${Date.now()}_${i}.${ext}`);
    // -c copy 不重编码，瞬间完成，保持原始音质
    execSync(
      `"${ffmpegPath}" -y -i "${filePath}" -ss ${startTime} -t ${chunkSec} -c copy "${outPath}"`,
      { timeout: 30000, stdio: "pipe" }
    );
    chunks.push(outPath);
  }

  return chunks;
}

async function callProxy(base64: string, mime: string, fmt: string, config: ProxyConfig): Promise<string> {
  const isFlash = config.model.includes("fun-asr-flash");
  const body = isFlash
    ? JSON.stringify({
        model: config.model,
        input: {
          messages: [{
            role: "user",
            content: [{
              type: "input_audio",
              input_audio: { data: `data:${mime};base64,${base64}` },
            }],
          }],
        },
        parameters: { format: fmt, sample_rate: 16000 },
      })
    : JSON.stringify({
        model: config.model,
        messages: [{
          role: "user",
          content: [{
            type: "input_audio",
            input_audio: { data: `data:${mime};base64,${base64}` },
          }],
        }],
      });

  const response = await requestUrl({
    url: `${config.asrProxyUrl}/api/transcribe`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.licenseKey,
    },
    body,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ASR请求失败 (HTTP ${response.status}): ${response.text?.substring(0, 200) || ""}`);
  }
  const data = response.json;
  if (data.error) throw new Error(`ASR错误: ${data.error}`);
  const text = data.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("ASR返回空内容，可能是音频格式不受支持或文件损坏，请尝试上传 mp3/wav 格式。");
  return text;
}

export async function transcribeFile(
  filePath: string,
  config: ProxyConfig,
  onProgress?: (stage: string, percent: number) => void
): Promise<TranscriptionResult> {
  const fs = require("fs");
  const path = require("path");

  const sizeMB = (fs.statSync(filePath).size / 1048576).toFixed(1);
  onProgress?.(`读取文件 (${sizeMB}MB)...`, 5);

  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
    aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg",
  };
  const mime = mimeMap[ext] || "audio/wav";

  const fileSize = fs.statSync(filePath).size;
  const fileBuffer = fs.readFileSync(filePath);

  // 尝试获取音频时长，判断是否需要时间维度切片
  let duration: number | null = null;
  try {
    const ffmpegPath = await getFfmpegPath();
    if (ffmpegPath) {
      duration = await getAudioDuration(filePath, ffmpegPath);
    }
  } catch { /* 无 ffmpeg 则跳过 */ }

  // 转写
  let rawText = "";
  let tempFiles: string[] = [];

  if (duration && duration > MAX_CHUNK_SEC) {
    // ---- 时间维度切片（ffmpeg -c copy，不重编码）----
    const chunkCount = Math.ceil(duration / MAX_CHUNK_SEC);
    onProgress?.(`音频 ${Math.round(duration)}秒，切分 ${chunkCount} 段...`, 8);

    const ffmpegPath = await getFfmpegPath();
    tempFiles = await splitByTime(filePath, duration, MAX_CHUNK_SEC, ext, ffmpegPath!);

    for (let i = 0; i < tempFiles.length; i++) {
      const chunkBuf = fs.readFileSync(tempFiles[i]);
      const base64 = chunkBuf.toString("base64");
      const pct = 10 + Math.floor((i / tempFiles.length) * 80);
      onProgress?.(`转写 ${i + 1}/${tempFiles.length}...`, pct);
      rawText += await callProxy(base64, mime, ext, config) + "\n";
    }
  } else {
    // ---- 时长未知或 ≤ 4 分钟：沿用字节切片 ----
    const totalChunks = Math.ceil(fileBuffer.length / MAX_CHUNK_RAW);

    // m4a/wav 等容器格式被字节切片后会损坏，超大文件无 ffmpeg 时直接报错
    const CONTAINER_FORMATS = ["m4a", "wav"];
    if (totalChunks > 1 && CONTAINER_FORMATS.includes(ext)) {
      throw new Error(
        `文件过大（${sizeMB}MB）且未检测到 FFmpeg，无法切片。\n\n` +
        "请安装 FFmpeg：Windows 终端输入 winget install ffmpeg，Mac 终端输入 brew install ffmpeg，安装后重启 Obsidian。\n" +
        "或先将文件转换为 mp3 格式再上传。"
      );
    }

    if (totalChunks <= 1) {
      onProgress?.("转写中...", 20);
      const base64 = fileBuffer.toString("base64");
      rawText = await callProxy(base64, mime, ext, config);
    } else {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * MAX_CHUNK_RAW;
        const end = Math.min(start + MAX_CHUNK_RAW, fileBuffer.length);
        const chunk = fileBuffer.slice(start, end);
        const base64 = Buffer.from(chunk).toString("base64");
        const pct = 10 + Math.floor((i / totalChunks) * 80);
        onProgress?.(`转写 ${i + 1}/${totalChunks}...`, pct);
        rawText += await callProxy(base64, mime, ext, config) + "\n";
      }
    }
  }

  // 清理临时切片文件
  for (const tf of tempFiles) {
    try { fs.unlinkSync(tf); } catch {}
  }

  // 后处理：删寒暄 + 分说话人（不修改对话内容）
  onProgress?.("整理格式...", 82);
  const cleanedText = await cleanupTranscript(rawText, config);

  return buildResult(cleanedText, fileSize / 2000, onProgress);
}

/**
 * 轻量后处理：只删除开头寒暄 + 区分说话人，不修改任何对话字句
 */
async function cleanupTranscript(rawText: string, config: ProxyConfig): Promise<string> {
  // 文字太长时分片处理，每片最多 3000 字
  const MAX_CHARS = 5000;
  if (rawText.length <= MAX_CHARS) {
    try {
      const r = await cleanupChunk(rawText, config, true);
      return r.replace(/(?<!\*\*)面试官：/g, "**面试官：**").replace(/(?<!\*\*)面试者：/g, "**面试者：**");
    } catch { return rawText; }
  }

  const chunks: string[] = [];
  for (let i = 0; i < rawText.length; i += MAX_CHARS) {
    chunks.push(rawText.substring(i, i + MAX_CHARS));
  }

  // 并行处理所有片
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      cleanupChunk(chunk, config, i === 0).catch(() => chunk)
    )
  );

  // 代码兜底：强制所有标签加粗
  return results.join("\n")
    .replace(/(?<!\*\*)面试官：/g, "**面试官：**")
    .replace(/(?<!\*\*)面试者：/g, "**面试者：**");
}

async function cleanupChunk(rawText: string, config: ProxyConfig, isFirstChunk: boolean): Promise<string> {
  const prompt = isFirstChunk
    ? `你是文字稿整理工具。只做两件事：1.删除开头寒暄问候（网络调试、互相打招呼），直到面试官正式自我介绍或提问为止 2.用「**面试官：**」「**面试者：**」标注（必须加粗）。禁止修改任何对话原句，禁止删除口语词。直接输出，不加分析。`
    : `你是文字稿整理工具。只做一件事：用「**面试官：**」「**面试者：**」标注（必须加粗）。禁止修改任何对话原句。续接部分。`;

  const response = await requestUrl({
    url: `${config.proxyUrl}/api/chat`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.licenseKey,
    },
    body: JSON.stringify({
      model: "qwen-plus",
      messages: [{ role: "system", content: prompt }, { role: "user", content: rawText }],
      max_tokens: 8192,
    }),
  });

  const data = response.json;
  if (data.error) return rawText;
  return data.choices?.[0]?.message?.content || rawText;
}

function buildResult(rawText: string, durationSec: number, onProgress?: (s: string, p: number) => void): TranscriptionResult {
  const chunks = rawText.split(/(?<=[。！？.!?\n])/).map((s: string) => s.trim()).filter((s: string) => s.length > 0);
  const sentences: TranscriptionSentence[] = chunks.map((text: string, i: number) => ({
    begin_time: i * 5000, end_time: (i + 1) * 5000, text,
  }));
  const lines = ["# 面试文字稿\n"];
  for (const s of sentences) {
    const m = Math.floor(s.begin_time / 60000);
    const sec = Math.floor((s.begin_time % 60000) / 1000);
    lines.push(`[${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}] ${s.text}\n`);
  }
  onProgress?.("转写完成！", 100);
  return { sentences, markdown: lines.join("\n"), duration: Math.round(durationSec * 1000) };
}

