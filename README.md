# Interview Review Assistant

> AI-powered interview analysis — upload recordings, get professional review reports in your Obsidian vault.

Powered by **Fun-ASR-Flash** (world's #1 speech recognition model) and **Qwen-Plus** for deep analytical insights, running on a fully serverless Alibaba Cloud infrastructure.

---

## Architecture

```
Obsidian Plugin (TypeScript)
    │
    ├── Transcription ──── FC Proxy (512MB) ──── DashScope fun-asr-flash
    │
    └── Analysis / Auth ── FC Proxy (128MB) ──── DashScope qwen-plus
                                  │
                                  └── NAS (Key Persistence)
```

## Features

### Speech-to-Text
- 6 audio formats (MP3 / WAV / M4A / AAC / FLAC / OGG) & 7 video formats (MP4 / MOV / AVI / MKV / WebM / FLV / WMV)
- Auto audio extraction and compression via FFmpeg
- Time-based intelligent chunking for recordings of any length
- Both synchronous (≤5 min) and chunked streaming modes

### AI Review Analysis
- **6-dimension scoring**: Technical depth, communication clarity, answer structure, language proficiency, soft skills, overall performance
- **Per-question breakdown**: Summary → Highlights → Improvements → Suggested approach → Priority ranking
- **JD-aware evaluation**: Paste the job description for targeted feedback
- **Structured report**: Short / Mid / Long-term actionable improvement plans
- Streaming response for real-time progress feedback

### License & Quota System
- Cryptographically-random license key generation
- Usage-based quota with renewal and batch operations
- Customer self-registration portal (3 free trial uses)
- Admin dashboard with key lifecycle management
- NAS-persisted data (survives cold starts and deployments)

### Plugin Experience
- Multi-stage progress visualization
- Persistent reports (survive modal close and app restart)
- FFmpeg auto-detection with platform-specific guidance
- Dual input mode: file upload or paste transcript
- AI analysis toggle (transcription-only mode saves quota)

---

## Project Structure

```
├── src/                          # Obsidian Plugin (TypeScript)
│   ├── main.ts                   # Entry point: commands, ribbon, settings
│   ├── settings.ts               # License key, model config, paths
│   ├── aliyun-stt.ts             # ASR pipeline: chunking, proxy, cleanup
│   ├── qwen-api.ts               # Streaming AI analysis via qwen-plus
│   ├── audio-compress.ts         # FFmpeg detection & audio extraction
│   ├── review-modal.ts           # Main UI: file picker, progress, save
│   ├── file-utils.ts             # File validation, size formatting
│   └── report-generator.ts       # Vault writer with frontmatter
│
├── worker-aliyun/                # Alibaba Cloud FC Functions
│   ├── index.js                  # API proxy, key management, admin panel
│   └── asr-proxy.js              # ASR-dedicated endpoint (512MB)
│
├── admin.html                    # Standalone admin dashboard
├── admin-cli.mjs                 # CLI key management
├── customer.html                 # Customer self-registration page
├── server.mjs                    # Local development server
│
├── main.ts / manifest.json       # Plugin entry & manifest
├── esbuild.config.mjs            # Build configuration
└── tsconfig.json                 # TypeScript configuration
```

---

## Quick Start

### Prerequisites
- Node.js 18+ / npm
- Alibaba Cloud FC (Function Compute)
- DashScope API Key (Model Studio)
- Obsidian ≥ 1.4.0

### Build
```bash
npm install
npm run build
```

### Deploy Functions
Deploy `worker-aliyun/index.js` and `worker-aliyun/asr-proxy.js` to separate FC functions:
- **Main function** (128MB): API proxy, key management, admin panel — mount NAS at `/mnt/interview_proxy/`
- **ASR function** (512MB): Dedicated transcription endpoint for large payloads

### Local Admin
```bash
node server.mjs
# Admin panel:  http://localhost:8888/admin
# Customer page: http://localhost:8888/customer
```

---

## API Reference

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/transcribe` | License Key | Speech-to-text via fun-asr-flash |
| `POST /api/chat` | License Key | AI analysis via qwen-plus |
| `GET /api/quota` | License Key | Query remaining quota |
| `POST /api/review-complete` | License Key | Report quota consumption |
| `GET/POST /admin/*` | Admin Key | Key generation & management |
| `POST /customer/register` | Public | Self-service registration |
| `POST /customer/find-key` | Public | Look up key by email |
| `POST /customer/quota` | Public | Query quota by key |

**Model routing**: The proxy auto-detects the model and routes to the correct DashScope endpoint — multimodal-generation for `fun-asr-flash`, compatible-mode for legacy models.

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Plugin Runtime | Obsidian API (TypeScript) |
| Build System | esbuild + tsc |
| Speech Recognition | DashScope fun-asr-flash-2026-06-15 |
| AI Analysis | DashScope qwen-plus |
| Serverless | Alibaba Cloud FC (Node.js 18) |
| Persistence | Alibaba Cloud NAS |
| Audio Processing | FFmpeg (system-level) |
