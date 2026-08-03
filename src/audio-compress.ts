/**
 * 音频压缩：本地 ffmpeg
 */
import { exec } from "child_process";
const fs = require("fs");
const path = require("path");
const os = require("os");

// 查找 ffmpeg 路径（与生产版一致）
function findFfmpeg(): Promise<string | null> {
  const paths = process.platform === "darwin"
    ? ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
    : ["ffmpeg"];

  return new Promise((resolve) => {
    function tryNext(i: number) {
      if (i >= paths.length) return resolve(null);
      exec(`"${paths[i]}" -version`, (err) => {
        if (!err) resolve(paths[i]);
        else tryNext(i + 1);
      });
    }
    tryNext(0);
  });
}

let ffmpegPath: string | null = null;

export function getFfmpegPath(): Promise<string | null> {
  if (ffmpegPath) return Promise.resolve(ffmpegPath);
  return findFfmpeg().then(p => { ffmpegPath = p; return p; });
}

export function checkLocalFfmpeg(): Promise<boolean> {
  return findFfmpeg().then(p => { ffmpegPath = p; return !!p; });
}

function localFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  const ff = ffmpegPath || "ffmpeg";
  const safeIn = inputPath.replace(/"/g, '\\"');
  const safeOut = outputPath.replace(/"/g, '\\"');
  const cmd = `"${ff}" -i "${safeIn}" -vn -acodec libmp3lame -b:a 16k -ar 16000 -ac 1 -y "${safeOut}"`;
  return new Promise((resolve, reject) => {
    exec(cmd, (err: any, _stdout: string, stderr: string) => {
      if (err) reject(new Error(stderr?.substring(0, 200) || err.message));
      else resolve();
    });
  });
}

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp3`);
}

const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"];

export function isVideoFile(filePath: string): boolean {
  const ext = (path.extname(filePath) || "").toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

export async function compressMedia(
  inputPath: string,
  onLog?: (msg: string) => void
): Promise<{ success: boolean; outputPath: string; error?: string }> {
  const outPath = tempPath("ir_compress");
  const ext = (path.extname(inputPath) || "").toLowerCase();

  // 只有 mp3 直传；其他格式全部走 ffmpeg 转 mp3（与生产版一致）
  if (ext === ".mp3") {
    return { success: true, outputPath: inputPath };
  }

  // 视频需要 ffmpeg 提取音频
  const hasFfmpeg = await checkLocalFfmpeg();
  if (!hasFfmpeg) {
    return {
      success: false, outputPath: "",
      error: `处理此文件需要 FFmpeg，系统中未检测到。\n\n安装命令：\nWindows：winget install ffmpeg\nMac：brew install ffmpeg\n\n安装后重启 Obsidian。\n或直接上传 mp3 格式文件，不需要 FFmpeg。`
    };
  }

  try {
    onLog?.("压缩中...");
    await localFfmpeg(inputPath, outPath);
    onLog?.(`✅ 压缩完成: ${(fs.statSync(outPath).size / 1048576).toFixed(1)}MB`);
    return { success: true, outputPath: outPath };
  } catch (e: any) {
    try { fs.unlinkSync(outPath); } catch {}
    return { success: false, outputPath: "", error: e.message };
  }
}

export function cleanupTemp(filePath: string): void {
  if (!filePath || !filePath.includes("ir_")) return;
  try { fs.unlinkSync(filePath); } catch {}
}

export { checkLocalFfmpeg as checkFfmpeg };

