/**
 * 面试复盘助手 - Obsidian 插件（千问版）
 *
 * 阿里云百炼 一个 API Key 搞定：
 * 1. qwen3-asr-flash → 语音转文字
 * 2. qwen-plus → AI 复盘分析
 * 3. 视频自动压缩 → 报告写入 vault
 */

import { App, Plugin, PluginManifest } from "obsidian";
import { InterviewReviewSettings, DEFAULT_SETTINGS, InterviewReviewSettingTab } from "./src/settings";
import { ReviewModal } from "./src/review-modal";
// AdminPanel 移到独立 admin.html 文件，不打进插件

export default class InterviewReviewPlugin extends Plugin {
  settings!: InterviewReviewSettings;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new InterviewReviewSettingTab(this.app, this));
    // 管理面板已独立为 admin.html，客户插件内不可见

    this.addCommand({
      id: "review-interview",
      name: "复盘面试录音/视频",
      callback: () => new ReviewModal(this.app, this).open(),
    });

    this.addCommand({
      id: "review-transcript",
      name: "复盘已有文字稿",
      callback: () => new ReviewModal(this.app, this).open(),
    });

    this.addRibbonIcon("mic", "面试复盘助手", () => new ReviewModal(this.app, this).open());

    console.log("面试复盘助手（千问版）已加载");
  }

  onunload(): void {
    console.log("面试复盘助手已卸载");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
