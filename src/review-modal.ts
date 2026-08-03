import { App, Modal, Notice, Setting } from "obsidian";
import type InterviewReviewPlugin from "../main";
import { transcribeFile } from "./aliyun-stt";
import { analyzeTranscriptStream, InterviewMeta } from "./qwen-api";
import { saveReport, saveTranscript } from "./report-generator";
import { compressMedia, cleanupTemp } from "./audio-compress";
import { openFilePicker, getFileSize, formatFileSize, validateMediaFile, isVideoFile } from "./file-utils";

type Step = "idle" | "compressing" | "transcribing" | "analyzing" | "done" | "error";

const STAGES = [
  { key: "compressing", icon: "🗜️",  label: "压缩中",  desc: "提取音频并压缩" },
  { key: "transcribing", icon: "🎤",  label: "转写中", desc: "语音转文字" },
  { key: "analyzing",   icon: "🧠",  label: "分析中", desc: "AI 生成复盘报告" },
];

export class ReviewModal extends Modal {
  plugin: InterviewReviewPlugin;

  private filePath = "";
  private transcriptText = "";
  private useFileMode = true;
  private company = ""; private position = ""; private round = "初面";
  private type = "技术面"; private language = "中英混合"; private selfFeeling = "";
  private jobDesc = ""; private recruitType = "社招"; private recruitSeason = "秋招"; private interviewDate = "";

  private step: Step = "idle";
  private progressPercent = 0;
  private errorMessage = "";
  private analysisReport = "";
  private isProcessing = false;
  private stats = { originalSize: "", compressedSize: "", wordCount: 0, durationMin: 0 };

  private stageEls: Map<string, HTMLElement> = new Map();
  private progressFillEl!: HTMLDivElement;
  private progressLabelEl!: HTMLDivElement;
  private statsEl!: HTMLDivElement;
  private logEl!: HTMLDivElement;

  constructor(app: App, plugin: InterviewReviewPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("interview-review-modal");
    contentEl.createEl("h2", { text: "🎯 面试复盘助手" });

    // === 许可证检查 ===
    if (!this.plugin.settings.licenseKey) {
      const warn = contentEl.createDiv({ cls: "review-warn" });
      warn.createSpan({ text: "⚠️ " });
      warn.createSpan({ text: "请先填入许可证 Key：设置 → 第三方插件 → 面试复盘助手 → ⚙️" });
    }

    // === 输入方式 ===
    new Setting(contentEl).setName("输入方式").addDropdown((d) =>
      d.addOption("file", "📁 录音/视频文件").addOption("paste", "📝 粘贴文字稿")
        .setValue(this.useFileMode ? "file" : "paste")
        .onChange((v) => {
          // 保存当前文字再切换
          if (this.useFileMode !== (v === "file")) {
            this.transcriptText = this.transcriptText; // 保底
          }
          this.useFileMode = v === "file";
          this.rerender();
        }));

    // === 文件选择 ===
    if (this.useFileMode) {
      const fc = contentEl.createDiv({ cls: "review-section" });
      new Setting(fc).setName("选择文件").setDesc(
        this.filePath
          ? `✅ 已选: ${this.filePath.split(/[/\\]/).pop()} (${formatFileSize(getFileSize(this.filePath))})`
          : "支持 mp3, wav, m4a, mp4, mov, avi, mkv 等格式")
        .addButton((b) => b.setButtonText("选择文件").setCta().onClick(async () => {
          const p = await openFilePicker();
          if (!p) return;
          const e = validateMediaFile(p);
          if (e) { new Notice(`❌ ${e}`); return; }
          this.filePath = p; this.step = "idle"; this.errorMessage = ""; this.rerender();
        }));
      if (this.filePath) {
        const sz = getFileSize(this.filePath);
        const isVideo = isVideoFile(this.filePath);
        if (isVideo && sz > 1.5 * 1024 * 1024 * 1024) {
          fc.createDiv({ cls: "review-warn" }).setText(
            `⚠️ 文件 ${formatFileSize(sz)} 超过内置解码器限制（1.5GB）\n请用手机录成音频再上传，或在电脑安装 ffmpeg 后重试`
          );
        } else if (isVideo) {
          fc.createDiv({ cls: "review-hint" }).setText(
            "💡 视频将通过 FFmpeg 压缩后转写"
          );
        }
      }
    } else {
      const pc = contentEl.createDiv({ cls: "review-section" });
      new Setting(pc).setName("面试文字稿").addTextArea((ta) => {
        ta.setPlaceholder("面试官：请做自我介绍...\n我：...").setValue(this.transcriptText)
          .onChange((v) => { this.transcriptText = v; });
        ta.inputEl.rows = 8; ta.inputEl.style.width = "100%";
      });
    }

    // === 面试信息 ===
    const ms = contentEl.createDiv({ cls: "review-section" });
    ms.createEl("h3", { text: "面试信息" });
    new Setting(ms).setName("公司").addText((t) => t.setPlaceholder("字节跳动").onChange((v) => this.company = v));
    new Setting(ms).setName("职位").addText((t) => t.setPlaceholder("前端工程师").onChange((v) => this.position = v));
    new Setting(ms).setName("轮次").addDropdown((d) =>
      d.addOption("初面","初面").addOption("二面","二面").addOption("三面","三面").addOption("终面","终面").addOption("HR面","HR面")
        .setValue(this.round).onChange((v) => this.round = v));
    new Setting(ms).setName("类型").addDropdown((d) =>
      d.addOption("技术面","技术面").addOption("行为面","行为面").addOption("综合面","综合面").addOption("系统设计面","系统设计面")
        .setValue(this.type).onChange((v) => this.type = v));
    new Setting(ms).setName("语言").addDropdown((d) =>
      d.addOption("中文","中文").addOption("英文","英文").addOption("中英混合","中英混合")
        .setValue(this.language).onChange((v) => this.language = v));
    new Setting(ms).setName("自评").addText((t) => t.setPlaceholder("整体感觉怎么样？").onChange((v) => this.selfFeeling = v));
    new Setting(ms).setName("招聘类型").addDropdown((d) =>
      d.addOption("社招","社招").addOption("校招","校招").setValue(this.recruitType)
        .onChange((v) => { this.recruitType = v; this.rerender(); }));
    if (this.recruitType === "校招") {
      new Setting(ms).setName("招聘季节").addDropdown((d) =>
        d.addOption("秋招","秋招").addOption("春招","春招").setValue(this.recruitSeason)
          .onChange((v) => this.recruitSeason = v));
    }
    new Setting(ms).setName("面试时间").addText((t) => t.setPlaceholder("如: 2026-07-28").onChange((v) => this.interviewDate = v));
    new Setting(ms).setName("岗位描述").addTextArea((ta) => {
      ta.setPlaceholder("粘贴岗位JD，帮助AI更好分析...").onChange((v) => this.jobDesc = v);
      ta.inputEl.rows = 3; ta.inputEl.style.width = "100%";
    });

    // === 开始按钮（允许 error 后重试）===
    const canGo = this.useFileMode ? this.filePath !== "" : this.transcriptText.trim() !== "";
    const btnDisabled = !canGo || this.step === "compressing" || this.step === "transcribing" || this.step === "analyzing";
    new Setting(contentEl).addButton((b) => {
      b.setButtonText(this.step === "error" ? "🔄 重试" : "🚀 开始复盘").setCta()
        .setDisabled(btnDisabled)
        .onClick(() => this.start());
    });

    // === 错误提示 ===
    if (this.step === "error" && this.errorMessage) {
      const errEl = contentEl.createDiv({ cls: "review-error-box" });
      errEl.createSpan({ text: `❌ ${this.errorMessage}` });
    }

    // === 进度面板 ===
    if (this.step !== "idle" && this.step !== "error") {
      this.renderProgressPanel(contentEl);
    }

    // === 完成（上次报告） ===
    const lastReport = this.analysisReport || this.plugin.settings.lastReport;
    if (this.step === "done" || (this.step === "idle" && lastReport)) {
      if (!this.analysisReport) this.analysisReport = lastReport;
      const done = contentEl.createDiv({ cls: "review-done" });
      done.createEl("div", { cls: "review-done-icon", text: "🎉" });
      done.createEl("h3", { text: "上次复盘结果" });
      done.createEl("p", { text: `共 ${this.analysisReport.length} 字 · 已保存到 vault` });
      done.createEl("button", { text: "🗑️ 清除", cls: "btn btn-sm" }).onclick = async () => {
        this.analysisReport = "";
        this.plugin.settings.lastReport = "";
        await this.plugin.saveSettings();
        this.rerender();
      };
    }
  }

  private renderProgressPanel(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "review-progress-panel" });

    // 阶段指示器
    const stageRow = panel.createDiv({ cls: "review-stages" });
    this.stageEls.clear();
    STAGES.forEach((st, i) => {
      const el = stageRow.createDiv({ cls: "review-stage" });
      el.createSpan({ cls: "review-stage-icon", text: st.icon });
      el.createSpan({ cls: "review-stage-label", text: st.label });
      this.stageEls.set(st.key, el);
      if (i < STAGES.length - 1) stageRow.createSpan({ cls: "review-stage-arrow", text: "→" });
    });

    // 进度条
    const barWrap = panel.createDiv({ cls: "review-bar-wrap" });
    const bar = barWrap.createDiv({ cls: "review-bar" });
    this.progressFillEl = bar.createDiv({ cls: "review-bar-fill" });
    this.progressLabelEl = barWrap.createDiv({ cls: "review-bar-label" });
    if (this.progressPercent > 0) {
      this.progressFillEl.style.width = `${this.progressPercent}%`;
      this.progressLabelEl.setText(`${this.progressPercent}%`);
    }

    // 统计
    this.statsEl = panel.createDiv({ cls: "review-stats" });

    // 日志
    this.logEl = panel.createDiv({ cls: "review-log" });
  }

  private updateStage(activeKey: string, status: "active" | "done" | "error" = "active"): void {
    STAGES.forEach((st) => {
      const el = this.stageEls.get(st.key);
      if (!el) return;
      el.removeClass("stage-active", "stage-done", "stage-error");
      const iconEl = el.querySelector(".review-stage-icon");
      if (st.key === activeKey) {
        el.addClass(status === "error" ? "stage-error" : "stage-active");
        if (iconEl) iconEl.textContent = status === "error" ? "❌" : st.icon;
      } else if (STAGES.findIndex(s => s.key === st.key) < STAGES.findIndex(s => s.key === activeKey)) {
        el.addClass("stage-done");
        if (iconEl) iconEl.textContent = "✅";
      }
    });
  }

  private updateProgress(pct: number, label: string): void {
    this.progressPercent = pct;
    if (this.progressFillEl) this.progressFillEl.style.width = `${pct}%`;
    if (this.progressLabelEl) this.progressLabelEl.setText(`${label} (${pct}%)`);
  }

  private log(msg: string, type: "info" | "success" | "error" = "info"): void {
    if (!this.logEl) return;
    const l = this.logEl.createDiv({ cls: `review-log-line log-${type}` });
    l.setText(`${type === "success" ? "✅" : type === "error" ? "❌" : "▸"} ${msg}`);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ========== 主流程 ==========

  private async start(): Promise<void> {
    // 立即扣 1 次配额
    try {
      const { requestUrl } = require("obsidian");
      await requestUrl({
        url: `${this.plugin.settings.proxyUrl}/api/review-complete`,
        method: "POST",
        headers: { "x-api-key": (this.plugin.settings.licenseKey || "").trim() },
      });
    } catch (e: any) {
      new Notice("❌ 配额不足或无有效许可证");
      return;
    }

    this.isProcessing = true;
    this.step = "compressing";
    this.progressPercent = 0;
    this.errorMessage = "";
    this.analysisReport = "";
    this.stats = { originalSize: "", compressedSize: "", wordCount: 0, durationMin: 0 };
    this.rerender();

    try {
      const meta: InterviewMeta = {
        company: this.company, position: this.position, round: this.round,
        type: this.type, language: this.language, selfFeeling: this.selfFeeling,
        jobDesc: this.jobDesc, recruitType: this.recruitType,
        recruitSeason: this.recruitSeason, interviewDate: this.interviewDate,
      };
      if (!this.plugin.settings.licenseKey) throw new Error("许可证 Key 未配置。请到设置页面填入。");

      const proxyConfig = {
        licenseKey: (this.plugin.settings.licenseKey || "").trim(),
        proxyUrl: this.plugin.settings.proxyUrl,
        asrProxyUrl: this.plugin.settings.asrProxyUrl,
        model: this.plugin.settings.asrModel,
      };

      let transcript: string;

      if (this.useFileMode) {
        let audioPath = this.filePath;
        const fileSize = getFileSize(this.filePath);
        const isVideo = isVideoFile(this.filePath);
        const ext = this.filePath.toLowerCase().slice(this.filePath.lastIndexOf("."));
        const needCompress = isVideo || ext !== ".mp3";

        // === 阶段1：压缩 ===
        if (needCompress) {
          this.updateStage("compressing", "active");
          this.updateProgress(5, "启动压缩...");
          this.log(`原始文件: ${formatFileSize(fileSize)}${isVideo ? " (视频)" : ""}`, "info");

          const result = await compressMedia(this.filePath, (msg) => {
            this.log(msg, msg.includes("✅") ? "success" : msg.includes("❌") ? "error" : "info");
            if (msg.includes("压缩中")) this.updateProgress(12, "压缩中...");
          });

          if (!result.success) {
            if (fileSize > 50 * 1024 * 1024) {
              throw new Error(`视频过大且无法压缩。请安装 ffmpeg 或先用其他工具将视频转为 mp3 音频再上传。`);
            }
            this.log(`⚠️ 压缩跳过，直接上传（文件较小）`, "info");
          } else {
            audioPath = result.outputPath;
            const newSize = getFileSize(audioPath);
            this.stats.originalSize = formatFileSize(fileSize);
            this.stats.compressedSize = formatFileSize(newSize);
            this.log(`压缩完成: ${formatFileSize(newSize)} (${(fileSize/newSize).toFixed(0)}x)`, "success");
          }

          this.updateStage("compressing", "done");
        this.updateProgress(20, "压缩完成");
        }

        // === 阶段2：转写 ===
        this.step = "transcribing";
        this.updateStage("transcribing", "active");

        const t = await transcribeFile(audioPath, proxyConfig,
          (s, p) => {
            this.updateProgress(20 + Math.floor(p * 0.5), "语音转文字中...");
          }
        );

        transcript = t.markdown;
        this.stats.wordCount = transcript.length;
        this.stats.durationMin = Math.round(t.duration / 60000);

        this.updateStage("transcribing", "done");
        this.updateProgress(70, "转写完成");
        this.log(`转写完成: ${t.sentences.length}句, 约${this.stats.durationMin}分钟, ${transcript.length}字`, "success");

        // 清理临时压缩文件
        if (audioPath !== this.filePath) {
          cleanupTemp(audioPath);
          this.log("临时文件已清理", "info");
        }

        try { await saveTranscript(this.app, transcript, { company: this.company }, this.plugin.settings.reportFolder); } catch { }

      } else {
        transcript = this.transcriptText.trim();
        this.updateStage("compressing", "done");
        this.updateStage("transcribing", "done");
        this.updateProgress(70, "跳过转录");
        this.log("使用粘贴的文字稿", "info");
      }

      // === 阶段3：AI 分析（可关闭） ===
      if (this.plugin.settings.enableAnalysis) {
        this.step = "analyzing";
        this.updateStage("analyzing", "active");
        this.updateProgress(72, "AI 分析中...");
        const chatConfig = {
          licenseKey: (this.plugin.settings.licenseKey || "").trim(),
          proxyUrl: this.plugin.settings.proxyUrl,
          model: this.plugin.settings.chatModel,
        };
        this.log("AI 分析中...", "info");

        let accumulated = "";
        let lastSave = 0;
        for await (const c of analyzeTranscriptStream(transcript, meta, chatConfig)) {
          accumulated += c;
          this.analysisReport = accumulated;
          // 每 500 字保存一次，退出也能看到部分结果
          if (accumulated.length - lastSave > 500) {
            this.plugin.settings.lastReport = accumulated;
            this.plugin.saveSettings();
            lastSave = accumulated.length;
          }
          if (accumulated.length % 200 < 20) {
            this.updateProgress(72 + Math.min(accumulated.length / 150, 25), `分析中...${accumulated.length}字`);
          }
        }
        this.analysisReport = accumulated;

        this.updateStage("analyzing", "done");
        this.updateProgress(97, "分析完成");
        this.log(`分析完成: 报告 ${accumulated.length} 字`, "success");

        // 保存报告
        this.updateProgress(99, "保存报告中...");
        await saveReport(this.app, this.analysisReport, meta, {
          reportFolder: this.plugin.settings.reportFolder,
          autoOpenReport: this.plugin.settings.autoOpenReport,
        });
      } else {
        this.updateStage("analyzing", "done");
        this.updateProgress(100, "转录完成");
      }

      this.step = "done";
      this.isProcessing = false;
      this.plugin.settings.lastReport = this.analysisReport;
      await this.plugin.saveSettings();
      this.updateProgress(100, "完成！🎉");
      this.rerender();

    } catch (e: any) {
      this.isProcessing = false;
      // 清理临时文件
      const tmpPath = this.filePath?.replace(/\.[^.]+$/, "") + "_compressed.mp3";
      cleanupTemp(tmpPath);
      this.step = "error";
      this.errorMessage = e.message || String(e);
      this.log(this.errorMessage, "error");
      this.rerender();
    }
  }

  onClose(): void {
    if (this.isProcessing) {
      new Notice("⏳ 正在处理中，请等待完成...");
      return; // 阻止关闭
    }
    this.contentEl.empty();
  }
  private rerender() { this.onOpen(); }
}
