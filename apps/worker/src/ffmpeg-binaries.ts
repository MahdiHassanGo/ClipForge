import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;
let cachedFilters: Set<string> | null = null;

function isExecutable(filePath: string | undefined | null): filePath is string {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const envPath = process.env.FFMPEG_PATH?.trim();
  if (isExecutable(envPath)) {
    cachedFfmpegPath = envPath;
    return envPath;
  }

  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (isExecutable(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  try {
    const staticPath = require("ffmpeg-static") as string | null;
    if (isExecutable(staticPath)) {
      cachedFfmpegPath = staticPath;
      return staticPath;
    }
  } catch {
    // fall through
  }

  cachedFfmpegPath = "ffmpeg";
  return cachedFfmpegPath;
}

export function resolveFfprobePath(): string {
  if (cachedFfprobePath) return cachedFfprobePath;

  const envPath = process.env.FFPROBE_PATH?.trim();
  if (isExecutable(envPath)) {
    cachedFfprobePath = envPath;
    return envPath;
  }

  for (const candidate of ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]) {
    if (isExecutable(candidate)) {
      cachedFfprobePath = candidate;
      return candidate;
    }
  }

  try {
    const staticMod = require("ffprobe-static") as { path?: string };
    if (isExecutable(staticMod?.path)) {
      cachedFfprobePath = staticMod.path;
      return staticMod.path;
    }
  } catch {
    // fall through
  }

  cachedFfprobePath = "ffprobe";
  return cachedFfprobePath;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export function runExecFile(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const errMessage = stderr?.trim() || error.message;
        reject(new Error(`Command ${bin} failed: ${errMessage.slice(-800)}`));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

export async function getAvailableFfmpegFilters(): Promise<Set<string>> {
  if (cachedFilters) return cachedFilters;
  const filters = new Set<string>();
  try {
    const { stdout } = await runExecFile(resolveFfmpegPath(), ["-hide_banner", "-filters"], {
      timeoutMs: 15_000,
    });
    for (const line of stdout.split("\n")) {
      const match = /^\s*[T.S.C.]{3}\s+([a-zA-Z0-9_]+)\s+/.exec(line);
      if (match?.[1]) {
        filters.add(match[1]);
      }
    }
  } catch {
    // ignore
  }
  cachedFilters = filters;
  return filters;
}
