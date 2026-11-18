import fs from "node:fs";
import path from "node:path";
import {
  createObjectStorageFromEnv,
  getDefaultAnalysisConfig,
  getMaxUploadBytes,
  type ObjectStorageProvider,
} from "@clipforge/core";

let cachedRepoRoot: string | null = null;
let cachedStorage: ObjectStorageProvider | null = null;

export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRepoRoot = process.cwd();
  return cachedRepoRoot;
}

export function getObjectStorage(): ObjectStorageProvider {
  if (!cachedStorage) {
    cachedStorage = createObjectStorageFromEnv(process.env, getRepoRoot());
  }
  return cachedStorage;
}

export function getUploadTempDir(): string {
  const configured = process.env.TEMP_WORK_DIR ?? "./tmp/clipforge-worker";
  const base = path.isAbsolute(configured)
    ? configured
    : path.resolve(getRepoRoot(), configured);
  return path.join(base, "uploads");
}

export interface AppCapabilities {
  youtubeApiConfigured: boolean;
  whisperConfigured: boolean;
  sttProviderLabel: string;
  storageProvider: string;
  maxUploadBytes: number;
  defaultAnalysisConfig: ReturnType<typeof getDefaultAnalysisConfig>;
}

function detectSttStatus(): { configured: boolean; label: string } {
  const mode = (process.env.STT_PROVIDER ?? "auto").toLowerCase().trim();
  if (mode === "none") return { configured: false, label: "Manual (Free)" };
  if ((mode === "groq" || mode === "auto") && process.env.GROQ_API_KEY?.trim()) {
    return { configured: true, label: "Groq Whisper (Free)" };
  }
  if (
    (mode === "local_whisper" || mode === "auto") &&
    process.env.LOCAL_WHISPER_MODEL_PATH?.trim()
  ) {
    return { configured: true, label: "Local Whisper (Offline)" };
  }
  if ((mode === "custom" || mode === "auto") && process.env.STT_BASE_URL?.trim()) {
    return { configured: true, label: "Custom Whisper" };
  }
  if ((mode === "openai" || mode === "auto") && process.env.OPENAI_API_KEY?.trim()) {
    return { configured: true, label: "OpenAI Whisper" };
  }
  return { configured: false, label: "Manual (No Key)" };
}

export function getAppCapabilities(): AppCapabilities {
  const stt = detectSttStatus();
  return {
    youtubeApiConfigured: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
    whisperConfigured: stt.configured,
    sttProviderLabel: stt.label,
    storageProvider: (process.env.STORAGE_PROVIDER ?? "local").toLowerCase(),
    maxUploadBytes: getMaxUploadBytes(),
    defaultAnalysisConfig: getDefaultAnalysisConfig(),
  };
}
