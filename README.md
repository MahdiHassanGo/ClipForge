# ClipForge

**AI-powered gaming video clipping studio** that turns long-form gaming VODs and recordings into punchy **9:16 vertical highlights** with synced captions, face-cam framing, and platform-friendly MP4 presets for **YouTube Shorts**, **TikTok**, and **Instagram Reels**.

![ClipForge 9:16 Studio Preview](./docs/clipforge-studio-preview.jpg)

---

## Highlights

- **Synchronized Multimodal Moment Detection (No Fake RAG)** — Combines word-level speech transcription, baseline-relative audio reaction contrast (never loudness-only), FFmpeg scene-cut & gameplay motion intensity, and face-cam corner detection to surface the strongest moments with clear, human-readable explanations.
- **Real-Time Live Stream Ingest & Live Chat Velocity Spikes** — Paste an ongoing YouTube or Twitch live URL or direct `.m3u8` HLS manifest. ClipForge uses commercial-grade **Audio-First Ingestion** (~1MB/min) + **Live Chat Velocity (MPS & Hype Keyword Density)** tracking to find clutch moments in real time, and selectively slices *only* a synchronized 60s high-res buffer without downloading multi-gigabyte streams!
- **Dual HLS Manifest Muxing & 100% Synced Audio** — Seamlessly resolves and muxes separate video-only (`sgovp`) and audio-only (`sgoap`) live HLS manifests with `-c:v copy -c:a aac -b:a 192k`. Zero audio drift, crystal-clear streamer voice, and full gameplay sound in both player preview and rendered 9:16 exports.
- **Multi-Moment Multimodal AI Scoring** — Extracts **3 to 5 distinct highlight candidates** from every captured stream window. Ranks moments as `Selected` (top clutch plays) and `Suggested`, with transparent multi-signal score breakdowns:
  - 💬 **Live Chat Velocity** (Messages-Per-Second spikes & hype keyword density)
  - 🎙️ **Vocal Excitement** (relative contrast & silence-to-burst)
  - 🎮 **Gameplay Motion Intensity** (action peaks & camera panning)
  - 🎬 **Scene Transitions** (scene cuts & visual shifts)
  - 🎯 **Face-Cam Framing** (corner webcam detection for split-screen 9:16)
- **Context-Preserving Clip Boundaries** — Automatically preserves lead-in setup and complete post-peak reactions/punchlines instead of cutting mid-sentence.
- **100% Free Speech-to-Text Support** — Works with **Local Offline Whisper (`whisper.cpp`)** on Apple Silicon/CPU, **Groq Free Tier (`whisper-large-v3-turbo`)**, any self-hosted Whisper server, optional OpenAI Whisper, or zero-key manual caption mode (never invents words when confidence is low).
- **Interactive 9:16 Review & Editing Studio** — Playable HTTP `Range`-streaming preview player, timeline event markers (audio reactions, gameplay motion, scene cuts), start/end boundary trimmers, editable synced captions with low-confidence review flags, and configurable vertical layouts (`Split Cam Top`, `Face-Cam PiP`, `Gameplay Focus`).
- **Platform-Friendly MP4 Exports** — Isolated FFmpeg background rendering for **YouTube Shorts**, **TikTok**, and **Instagram Reels** (1080×1920 H.264/AAC) with platform UI safe margins. Local MP4 download only — never auto-publishes.
- **Honest Source-Access Architecture** — Validates YouTube URLs and fetches permitted metadata via official YouTube Data API v3 or official oEmbed, then ingests user-authorized uploaded video files behind a pluggable `MediaIngestionProvider` interface. Never scrapes or downloads arbitrary YouTube streams.
- **Production-Grade Persistence & Auth** — PostgreSQL + Prisma schema and migrations, typed job state machine (`queued → uploading → analyzing → candidates_ready → rendering → complete` with `failed`/`cancelled` & deterministic retry rules), idempotent background worker leases, configurable local/S3 object storage, and per-user session authentication with strict ownership checks.

---

## Architecture

```text
ClipForge/
├── packages/
│   ├── core/          # Domain types, Zod schemas, typed job & render state machine,
│   │                  # YouTube URL validator & permitted metadata provider, scrypt/session auth,
│   │                  # local/S3 object storage providers, multimodal scoring & ASS caption engine
│   └── db/            # Prisma schema, PostgreSQL migrations, Prisma client singleton
├── apps/
│   ├── web/           # Next.js App Router, React, TypeScript, Tailwind CSS, shadcn/ui,
│   │                  # REST API routes, streaming uploads with magic-byte checks, Range streaming
│   └── worker/        # Standalone background worker: FFprobe, PCM audio reaction analysis,
│                      # Groq / local whisper.cpp / OpenAI / fallback STT, scene & motion detection,
│                      # heuristic face-cam detection, isolated FFmpeg 9:16 renderer, temp cleanup
├── docs/              # Documentation assets & screenshots
├── docker-compose.yml # Optional PostgreSQL 16 service
└── .env.example       # Documented environment variables (placeholders only)
```

### Job Lifecycle & Live Ingestion Pipeline

```text
(Pre-recorded VOD)
queued ──▶ uploading ──▶ analyzing ───────┐
  │            │             │            ▼
  │            │             │   candidates_ready ──▶ rendering ──▶ complete
  │            │             │            ▲                 │
  ▼            ▼             ▼            │                 ▼
(Ongoing Live Stream)                     │               failed
live_monitoring ──────────────────────────┘
```

#### Real-Time Ongoing Live Stream Clipping Pipeline

When pasting an active live stream, ClipForge does not download multi-gigabyte video files:

```text
[ Ongoing Stream / YouTube Live / Twitch / .m3u8 ]
       │
       ▼ (Step A: Dual Manifest Resolution)
[ HLS Master Manifest (.m3u8) ]
       ├── Video Manifest (sgovp / 1080p60 chunks)
       └── Audio Manifest (sgoap / 64–128kbps AAC/Opus) ──► (Step B: Pulled in real-time at ~1MB/min)
                                                                 │
                                                                 ▼
                                                      [ Local whisper.cpp / Groq Word Timestamps ]
                                                      [ PCM Audio Dynamics & Silence-to-Burst ]
                                                      [ Step C: Live Chat Velocity Spikes (MPS) ]
                                                                 │
                                                                 ▼
                                               (Excitement & Hype Peak Detected)
                                                                 │
                                                                 ▼ (Step D: Selective Video Slicing)
                                                      [ Fetch 60s High-Res 1080p60 Buffer ]
                                                      [ Mux Synced Stereo AAC Audio @ 192kbps ]
                                                      [ Gameplay Motion & Scene Transitions ]
                                                      [ Corner Face-Cam Detection & Framing ]
                                                                 │
                                                                 ▼
                                             [ 3–5 Ranked Highlight Moments Ready in Studio ]
```

- All job progress, transcript segments, scene events, candidate clips, and render exports persist in PostgreSQL — you can refresh or close the tab and resume at any time.
- Failed uploads, analyses, and individual MP4 renders have deterministic retry paths that never bypass missing-media checks.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Web App | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, Lucide Icons |
| Validation & Core | Zod, strict TypeScript (`@clipforge/core` + browser-safe `@clipforge/core/client`) |
| Persistence | PostgreSQL 15+, Prisma ORM (SQL migrations included) |
| Media & Rendering | Isolated Node worker, FFmpeg / FFprobe (`ffmpeg-static` / system FFmpeg), ASS burned captions |
| Speech-to-Text | Local `whisper.cpp` (free & offline), Groq Whisper (free tier), custom Whisper API, or OpenAI Whisper |
| Object Storage | Local disk storage (default) or S3-compatible storage (AWS S3, Cloudflare R2, MinIO) |
| Testing | Vitest unit tests (URL parsing, state transitions, auth/ownership, upload validation, scoring & captions) |

---

## Quick Start

### Prerequisites

- **Node.js 20+** and **pnpm 10+**
- **PostgreSQL 15+** (local Postgres or Docker via `docker compose up -d`)
- **FFmpeg / FFprobe** (auto-resolved from `FFMPEG_PATH`, system `PATH`, or bundled `ffmpeg-static` / `ffprobe-static`)

### 1. Clone & Install

```bash
git clone https://github.com/MahdiHassanGo/ClipForge.git
cd ClipForge
pnpm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your local database URL and session secret:

```bash
cp .env.example .env
```

Generate a random `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

### 3. Choose a Free Speech-to-Text Option (Optional)

With `STT_PROVIDER="auto"` (default), pick whichever option fits best:

- **Option A — Local Offline Whisper (`whisper.cpp`, 100% Free & Unlimited)**
  ```bash
  brew install whisper-cpp
  mkdir -p models
  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
  Then set in `.env`:
  ```env
  LOCAL_WHISPER_BIN="whisper-cli"
  LOCAL_WHISPER_MODEL_PATH="./models/ggml-base.en.bin"
  ```

- **Option B — Groq Free Whisper (`whisper-large-v3-turbo`, No Credit Card)**
  Get a free API key at https://console.groq.com/keys and set in `.env`:
  ```env
  GROQ_API_KEY="gsk_your_free_key_here"
  ```

- **Option C — Zero Setup (Manual Caption Mode)**
  Leave both blank. Audio dynamics, motion, scene cuts, face-cam detection, and 9:16 rendering still run normally, and speech-activity intervals are flagged for manual caption editing rather than fabricating words.

### 4. Start PostgreSQL & Apply Migrations

If using Docker for PostgreSQL:

```bash
docker compose up -d
```

Generate Prisma Client and apply migrations:

```bash
pnpm db:generate
pnpm db:migrate:deploy
```

### 5. Run Web App & Background Worker

Start both together:

```bash
pnpm dev
```

Or in separate terminals:

```bash
pnpm dev:web     # Next.js web app & API on http://localhost:3000
pnpm dev:worker  # Background analysis & FFmpeg 9:16 render worker
```

Open **http://localhost:3000**, create your account, paste a YouTube URL to inspect metadata, upload your authorized gaming recording, and start clipping.

---

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Random 32+ byte secret for HMAC session hashing |
| `YOUTUBE_API_KEY` | Optional (Free) | YouTube Data API v3 key for live/archived stream detection & duration (falls back to free official oEmbed) |
| `STT_PROVIDER` | No | `auto` (default), `groq`, `local_whisper`, `custom`, `openai`, or `none` |
| `GROQ_API_KEY` | Optional (Free) | Free Groq API key for fast `whisper-large-v3-turbo` word-level transcription |
| `LOCAL_WHISPER_MODEL_PATH` | Optional (Free) | Path to local `whisper.cpp` ggml model (e.g. `./models/ggml-base.en.bin`) |
| `LOCAL_WHISPER_BIN` | No | Path/name of `whisper-cli` binary (default `whisper-cli`) |
| `STT_BASE_URL` / `STT_API_KEY` | Optional | Custom self-hosted OpenAI-compatible Whisper endpoint |
| `OPENAI_API_KEY` | Optional (Paid) | Optional OpenAI Whisper key |
| `STORAGE_PROVIDER` | No | `local` (default) or `s3` |
| `LOCAL_STORAGE_DIR` | No | Local object storage directory (default `./storage`) |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Only if `STORAGE_PROVIDER=s3` | S3-compatible object storage credentials |
| `MAX_UPLOAD_BYTES` | No | Max upload size in bytes (default `1073741824` = 1 GiB) |
| `CLIP_DEFAULT_MIN_SECONDS`, `CLIP_DEFAULT_MAX_SECONDS`, `CLIP_DEFAULT_TARGET_SECONDS`, `CLIP_SCORE_THRESHOLD`, `CLIP_MAX_CANDIDATES` | No | Configurable clip selection defaults (20–60s, target 35s) |

---

## Scripts

```bash
pnpm dev               # Run web app + background worker in parallel
pnpm build             # Build core, db, worker, and Next.js production bundle
pnpm typecheck         # Strict TypeScript check across all workspace packages
pnpm lint              # Lint/type-check workspace packages
pnpm test              # Run Vitest unit test suites
pnpm db:migrate:deploy # Apply Prisma PostgreSQL migrations
```

---

## Source-Access Policy & Limitations

- **Commercial-Grade Live Manifest Slicing:** For active live streams, ClipForge connects to rolling HLS manifests (`.m3u8`) via standard HTTP chunk retrieval, extracting low-bitrate audio and selective 60s video buffers upon peak excitement without scraping or hoarding multi-gigabyte recordings.
- **Pre-recorded VODs require authorized uploads:** Direct scraping of full archived YouTube VODs is prohibited. Content creators upload their own high-res gameplay recordings or stream files.
- **No automatic social publishing:** Exports generate downloadable platform-ready 1080×1920 MP4 files for manual review and upload to YouTube Shorts, TikTok, or Instagram Reels.
- **Heuristic face-cam detection:** Automatically detects common landscape streamer corner webcams, with full per-clip manual corner presets and coordinate overrides in the studio UI.
