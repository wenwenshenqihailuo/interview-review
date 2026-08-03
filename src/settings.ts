import { App, PluginSettingTab, Setting } from "obsidian";
import type InterviewReviewPlugin from "../main";

export interface InterviewReviewSettings {
  licenseKey: string;
  proxyUrl: string;
  asrProxyUrl: string;
  asrModel: string;
  chatModel: string;
  reportFolder: string;
  autoOpenReport: boolean;
  enableAnalysis: boolean;
  lastReport: string;
}

export const DEFAULT_SETTINGS: InterviewReviewSettings = {
  licenseKey: "",
  proxyUrl: "https://interview-proxy-zuoftlbtnc.cn-hangzhou.fcapp.run",
  asrProxyUrl: "https://intervioftlbtnc-lpezrcpxip.cn-hangzhou.fcapp.run",
  asrModel: "fun-asr-flash-2026-06-15",
  chatModel: "qwen-plus",
  reportFolder: "面试复盘",
  autoOpenReport: true,
  enableAnalysis: true,
  lastReport: "",
};

export class InterviewReviewSettingTab extends PluginSettingTab {
  plugin: InterviewReviewPlugin;

  constructor(app: App, plugin: InterviewReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // ffmpeg 检测
    const { checkLocalFfmpeg } = await import("./audio-compress");
    const hasFfmpeg = await checkLocalFfmpeg();
    if (!hasFfmpeg) {
      const warn = containerEl.createDiv({ cls: "review-warn" });
      warn.createSpan({ text: "⚠️ 未检测到 FFmpeg，视频文件无法压缩。安装命令：Windows 终端输入 winget install ffmpeg，Mac 终端输入 brew install ffmpeg，安装后重启 Obsidian。音频文件不受影响。" });
    }

    new Setting(containerEl)
      .setName("许可证 Key")
      .addText((t) =>
        t.setPlaceholder("粘贴你的许可证 Key...")
          .setValue(this.plugin.settings.licenseKey)
          .onChange(async (v) => { this.plugin.settings.licenseKey = v.trim(); await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("AI 复盘分析")
      .addToggle((t) => t.setValue(this.plugin.settings.enableAnalysis)
        .onChange(async (v) => { this.plugin.settings.enableAnalysis = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("报告文件夹")
      .addText((t) => t.setPlaceholder("面试复盘").setValue(this.plugin.settings.reportFolder)
        .onChange(async (v) => { this.plugin.settings.reportFolder = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("自动打开报告")
      .addToggle((t) => t.setValue(this.plugin.settings.autoOpenReport)
        .onChange(async (v) => { this.plugin.settings.autoOpenReport = v; await this.plugin.saveSettings(); }));
  }
}
