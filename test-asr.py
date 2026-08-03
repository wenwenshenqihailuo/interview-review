"""
测试 fun-asr-flash-2026-06-15 模型
用法: python test-asr.py
"""
import requests
import base64
import os

API_KEY = "sk-ws-H.EIEHEPE.BWY7.MEQCIAPP5ikUVARpIFd1EMJRgORY9415SRJUuvkC5aQbit3TAiAxvSYCfkh3qoVzLOOsTDkO1yEosLvXdwSSAt-sQWkDQg"
MODEL = "fun-asr-flash-2026-06-15"
FILE = "C:/Users/macob/Desktop/录音 2.m4a"  # 改这里测试不同文件

# ---- 辅助 ----
def test_model(model_id, file_path):
    print(f"\n{'='*50}")
    print(f"测试模型: {model_id}")
    print(f"文件: {file_path}")
    print(f"大小: {os.path.getsize(file_path)/1048576:.1f} MB")
    print(f"{'='*50}")

    # 读文件
    with open(file_path, "rb") as f:
        data = f.read()
    b64 = base64.b64encode(data).decode()
    mime = "audio/mp4" if file_path.endswith(".m4a") else "audio/mpeg"

    body = {
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": f"data:{mime};base64,{b64}"
                        }
                    }
                ]
            }
        ]
    }

    print(f"body 大小: {len(str(body))/1048576:.1f} MB")
    print("发送请求...")

    try:
        resp = requests.post(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json"
            },
            json=body,
            timeout=120
        )
        print(f"HTTP {resp.status_code}")

        data = resp.json()
        if "error" in data:
            print(f"❌ 错误: {data['error']['message']}")
        elif "choices" in data:
            text = data["choices"][0]["message"]["content"]
            print(f"✅ 成功! {len(text)} 字")
            print("---内容---")
            print(text[:500])
        else:
            print(f"⚠️ 未知返回: {str(data)[:300]}")

    except Exception as e:
        print(f"❌ 请求失败: {e}")

# ---- 转小文件测试 ----
def test_small():
    """先取 3 分钟音频测试"""
    import subprocess
    ff = "C:/Users/macob/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe"
    out = "C:/Users/macob/AppData/Local/Temp/test_3min.mp3"

    # 从原始视频提取 2 分钟 mp3（API 限制 ~3 分钟）
    src = "C:/Users/macob/Desktop/飞书会议 2026-07-20 15-59-53.mp4"
    if not os.path.exists(src):
        # 没有视频就用 m4a 文件切小
        src = FILE
        subprocess.run([ff, "-y", "-i", src, "-ss", "0", "-t", "120",
                       "-acodec", "libmp3lame", "-b:a", "16k", "-ar", "16000", "-ac", "1", out],
                      capture_output=True, timeout=30)
    else:
        subprocess.run([ff, "-y", "-i", src, "-ss", "0", "-t", "120",
                       "-vn", "-acodec", "libmp3lame", "-b:a", "16k", "-ar", "16000", "-ac", "1", out],
                      capture_output=True, timeout=30)
    return out

# ---- 主流程 ----
if __name__ == "__main__":
    # 测试1: 用小文件
    small = test_small()
    if os.path.exists(small):
        test_model(MODEL, small)

    # 测试2: 用原始 m4a
    if os.path.exists(FILE):
        test_model(MODEL, FILE)
