import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { LiveManifestResult } from "@clipforge/core";

const execFileAsync = promisify(execFile);

let cachedYtDlpPath: string | null = null;

export function resolveYtDlpPath(): string | null {
  if (cachedYtDlpPath) return cachedYtDlpPath;

  const envPath = process.env.YTDLP_PATH?.trim();
  if (envPath && isExecutable(envPath)) {
    cachedYtDlpPath = envPath;
    return envPath;
  }

  const candidates = [
    "/opt/anaconda3/bin/yt-dlp",
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];

  for (const c of candidates) {
    if (isExecutable(c)) {
      cachedYtDlpPath = c;
      return c;
    }
  }

  return "yt-dlp";
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step A: Extract the rolling live HLS/DASH manifest (.m3u8).
 * Supports:
 *  1. Direct .m3u8 HLS URLs (from any CDN, OBS, Kick, or self-hosted server)
 *  2. YouTube live URLs (extracts live HLS playlist via yt-dlp)
 *  3. Twitch live URLs (extracts live HLS playlist via yt-dlp)
 */
export async function resolveLiveManifest(
  urlOrManifest: string,
): Promise<LiveManifestResult> {
  const trimmed = urlOrManifest.trim();

  // 1. Direct HLS manifest URL
  if (trimmed.includes(".m3u8") || trimmed.includes("/hls/")) {
    return {
      isLive: true,
      videoManifestUrl: trimmed,
      audioManifestUrl: trimmed,
      sourceType: "hls",
    };
  }

  const isYouTube =
    trimmed.includes("youtube.com") || trimmed.includes("youtu.be");
  const isTwitch = trimmed.includes("twitch.tv");

  if (!isYouTube && !isTwitch) {
    throw new Error(
      "Unsupported stream format. Please provide a YouTube live URL, Twitch live URL, or direct .m3u8 HLS playlist.",
    );
  }

  const ytdlpBin = resolveYtDlpPath();
  if (!ytdlpBin) {
    throw new Error(
      "yt-dlp is required to extract live HLS streams from YouTube or Twitch. Please install yt-dlp (e.g. brew install yt-dlp or pip install yt-dlp).",
    );
  }

  try {
    const nodeBin = process.execPath;
    const { stdout } = await execFileAsync(
      ytdlpBin,
      ["--js-runtimes", `node:${nodeBin}`, "-g", trimmed],
      { timeout: 25_000, maxBuffer: 10 * 1024 * 1024 },
    );

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"));

    if (lines.length === 0) {
      throw new Error("No live HLS stream manifests were returned for this URL.");
    }

    const videoManifestUrl = lines[0]!;
    const audioManifestUrl = lines[1] ?? lines[0]!;

    return {
      isLive: true,
      videoManifestUrl,
      audioManifestUrl,
      sourceType: isYouTube ? "youtube_live" : "twitch_live",
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve live stream manifest: ${msg.slice(0, 300)}`);
  }
}
