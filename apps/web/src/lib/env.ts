import fs from "node:fs";
import path from "node:path";
import {
  createObjectStorageFromEnv,
  detectSttStatus,
  getDefaultAnalysisConfig,
  getMaxUploadBytes,
  type ObjectStorageProvider,
} from "@clipforge/core";

let cachedRepoRoot: string | null = null;
let cachedStorage: ObjectStorageProvider | null = null;
let lastEnvMtime = 0;

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

/**
 * Synchronize process.env with the monorepo root .env file whenever the file changes.
 * This guarantees that when users add or modify keys in .env (e.g. GROQ_API_KEY, YOUTUBE_API_KEY),
 * the changes take effect immediately without requiring a full Next.js server restart.
 */
export function syncEnvFile(): void {
  try {
    const root = getRepoRoot();
    const envPath = path.join(root, ".env");
    if (!fs.existsSync(envPath)) return;
    const stats = fs.statSync(envPath);
    if (stats.mtimeMs <= lastEnvMtime) return;
    lastEnvMtime = stats.mtimeMs;

    const content = fs.readFileSync(envPath, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // Ignore filesystem read errors in restricted sandbox environments
  }
}

export function getObjectStorage(): ObjectStorageProvider {
  syncEnvFile();
  if (!cachedStorage) {
    cachedStorage = createObjectStorageFromEnv(process.env, getRepoRoot());
  }
  return cachedStorage;
}

export function getUploadTempDir(): string {
  syncEnvFile();
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

export function getAppCapabilities(): AppCapabilities {
  syncEnvFile();
  const repoRoot = getRepoRoot();
  const stt = detectSttStatus(process.env, repoRoot);
  return {
    youtubeApiConfigured: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
    whisperConfigured: stt.configured,
    sttProviderLabel: stt.label,
    storageProvider: (process.env.STORAGE_PROVIDER ?? "local").toLowerCase(),
    maxUploadBytes: getMaxUploadBytes(),
    defaultAnalysisConfig: getDefaultAnalysisConfig(),
  };
}
