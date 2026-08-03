# 面试复盘助手

> Obsidian 插件 —— 录音转文字 + AI 深度分析，一键生成面试复盘报告。

一个阿里云百炼 API Key 即可使用，无需额外部署。

## 功能

- **🎙️ 语音转文字**：支持 MP3 / WAV / M4A / AAC / FLAC / OGG 等音频格式，以及 MP4 / MOV / AVI / MKV / WebM / FLV / WMV 等视频格式。自动提取音频、智能分段，不限时长。
- **🧠 AI 复盘分析**：六维度评分（技术深度、表达清晰度、回答结构、语言能力、软技能、综合表现），逐题拆解（总结 → 亮点 → 改进点 → 建议思路 → 优先级），支持粘贴 JD 做针对性评估。
- **📝 结构化报告**：短/中/长期可执行的改进计划，报告持久化保存在 Obsidian vault 中。
- **🔑 授权管理**：License Key 机制，支持配额管理和客户自助注册。

## 安装

1. 下载插件文件，放入 Obsidian vault 的 `.obsidian/plugins/interview-review/` 目录
2. 确保系统已安装 [FFmpeg](https://ffmpeg.org/)（用于音视频处理）
3. 在插件设置中填入阿里云百炼 API Key
4. 启用插件即可使用

## 使用

- 点击左侧 Ribbon 栏的 🎤 图标，或使用命令面板搜索「复盘面试录音/视频」
- 选择录音/视频文件，插件会自动转写并生成分析报告
- 也可以直接粘贴已有的文字稿进行复盘分析

## 构建

```bash
npm install
npm run build
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 插件运行时 | Obsidian API (TypeScript) |
| 构建工具 | esbuild + tsc |
| 语音识别 | 阿里云百炼 qwen3-asr-flash |
| AI 分析 | 阿里云百炼 qwen-plus |
| 音频处理 | FFmpeg |

## 许可

MIT
