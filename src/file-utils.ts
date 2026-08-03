/**
 * 文件选择 + 格式验证
 */
const AUDIO_EXT = [".mp3",".wav",".m4a",".flac",".ogg",".wma",".aac"];
const VIDEO_EXT = [".mp4",".avi",".mov",".mkv",".webm",".flv",".wmv"];
const ALL = [...AUDIO_EXT, ...VIDEO_EXT];

export function isVideoFile(p: string) { const e = p.toLowerCase().slice(p.lastIndexOf(".")); return VIDEO_EXT.includes(e); }
export function isSupportedMedia(p: string) { const e = p.toLowerCase().slice(p.lastIndexOf(".")); return ALL.includes(e); }
export function getFileSize(p: string) { return require("fs").statSync(p).size; }
export function formatFileSize(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)}KB`;
  if (b < 1073741824) return `${(b/1048576).toFixed(1)}MB`;
  return `${(b/1073741824).toFixed(1)}GB`;
}

export function validateMediaFile(p: string): string|null {
  const fs = require("fs");
  if (!fs.existsSync(p)) return "文件不存在";
  if (!isSupportedMedia(p)) return `不支持格式，支持: ${ALL.join(",")}`;
  if (getFileSize(p) === 0) return "文件为空";
  return null;
}

/**
 * 打开文件选择对话框
 * 优先用 Electron 原生 dialog，兜底用 DOM input
 */
export async function openFilePicker(): Promise<string|null> {
  // 方案A：Electron 原生对话框（Obsidian 桌面端）
  try {
    const { dialog } = require("@electron/remote") || {};
    if (dialog) {
      const result = await dialog.showOpenDialog({
        title: "选择面试录音/视频",
        filters: [
          { name: "音视频文件", extensions: [...AUDIO_EXT.map(e=>e.slice(1)), ...VIDEO_EXT.map(e=>e.slice(1))] },
          { name: "所有文件", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths?.length) return null;
      return result.filePaths[0];
    }
  } catch {}

  // 方案B：DOM input（必须挂到 body 上）
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ALL.join(",");
    input.style.position = "fixed";
    input.style.top = "-9999px";
    input.style.left = "-9999px";
    document.body.appendChild(input);

    input.onchange = () => {
      const f = input.files?.[0];
      document.body.removeChild(input);
      resolve((f as any)?.path || null);
    };

    // 用户取消（focus 丢失 = 取消选择）
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      setTimeout(() => {
        if (input.files?.length === 0 && document.body.contains(input)) {
          document.body.removeChild(input);
          resolve(null);
        }
      }, 500);
    };
    window.addEventListener("focus", onFocus);

    input.click();
  });
}
