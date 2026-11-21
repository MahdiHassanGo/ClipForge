import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@clipforge/core";
import { resolveFfmpegPath, resolveFfprobePath, runExecFile } from "./ffmpeg-binaries.js";
import { resolveYtDlpPath } from "./live-manifest-resolver.js";

const logger = createLogger("clipforge-media-scraper");

export interface ScrapeMediaParams {
  url: string;
  workDir: string;
  jobId: string;
  userId: string;
  onProgress?: (message: string) => void;
}

interface FfprobeStreamInfo {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeStreamOutput {
  streams?: FfprobeStreamInfo[];
}

/**
 * Directly scrapes and downloads media from any URL (YouTube video/VOD/archived livestream,
 * Twitch stream/VOD, Kick, podcast audio, or direct URL) into a standard MP4 file.
 * If the source is audio-only (e.g. podcast audio), automatically synthesizes a clean 1080x1920
 * vertical video canvas so downstream video probes, audio waveform, and 9:16 rendering succeed.
 */
export async function scrapeMediaFromUrl(params: ScrapeMediaParams): Promise<string> {
  const { url, workDir, jobId, onProgress } = params;
  onProgress?.("Resolving media scraper and binaries...");

  const ytdlpBin = resolveYtDlpPath();
  if (!ytdlpBin) {
    throw new Error(
      "yt-dlp is required for direct media scraping but was not found in PATH or standard directories.",
    );
  }

  const ffmpegBin = resolveFfmpegPath();
  const ffprobeBin = resolveFfprobePath();
  const nodeBin = process.execPath;

  await fs.mkdir(workDir, { recursive: true });

  onProgress?.("Downloading media stream via yt-dlp...");
  logger.info("Starting direct media scrape", { jobId, url });

  const outputTemplate = path.join(workDir, "scraped_source.%(ext)s");
  const ytdlpArgs = [
    "--js-runtimes",
    `node:${nodeBin}`,
    "--ffmpeg-location",
    ffmpegBin,
    "--no-playlist",
    "--force-overwrites",
    "--no-warnings",
    "--max-filesize",
    "2G",
    "-f",
    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url,
  ];

  try {
    await runExecFile(ytdlpBin, ytdlpArgs, { timeoutMs: 360_000 });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("yt-dlp scrape failed", { url, error: errorMsg });
    throw new Error(`Failed to scrape media from link: ${errorMsg.slice(-500)}`);
  }

  // Find the scraped file in workDir
  const dirFiles = await fs.readdir(workDir);
  const candidates = dirFiles.filter((f) => f.startsWith("scraped_source."));
  if (candidates.length === 0) {
    throw new Error("yt-dlp finished but no output media file was created.");
  }

  // Prefer .mp4 if multiple files were created during remuxing
  const chosenFile =
    candidates.find((f) => f.endsWith(".mp4")) ??
    candidates.find((f) => f.endsWith(".mkv") || f.endsWith(".webm")) ??
    candidates[0]!;

  const downloadedFilePath = path.join(workDir, chosenFile);

  onProgress?.("Verifying streams & audio tracks...");
  // Check whether the downloaded media has video or is audio-only (e.g. podcast)
  let hasVideo = false;
  try {
    const { stdout: probeOut } = await runExecFile(
      ffprobeBin,
      ["-v", "quiet", "-print_format", "json", "-show_streams", downloadedFilePath],
      { timeoutMs: 15_000 },
    );
    const parsedProbe = JSON.parse(probeOut) as FfprobeStreamOutput;
    hasVideo = Boolean(parsedProbe.streams?.some((s) => s.codec_type === "video"));
  } catch {
    hasVideo = false;
  }

  // If audio-only (podcast, song, speech link), wrap into an instant 1080x1920 video canvas
  if (!hasVideo) {
    onProgress?.("Audio podcast detected — wrapping into 1080x1920 video canvas for clipping...");
    const canvasMp4 = path.join(workDir, "scraped_source_podcast.mp4");
    await runExecFile(
      ffmpegBin,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x0f1117:s=1080x1920:r=30",
        "-i",
        downloadedFilePath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        canvasMp4,
      ],
      { timeoutMs: 180_000 },
    );
    return canvasMp4;
  }

  // If it's already an MP4, return it
  if (downloadedFilePath.endsWith(".mp4")) {
    return downloadedFilePath;
  }

  // If video is webm or mkv, remux to mp4 container
  onProgress?.("Remuxing into standard MP4 container...");
  const mp4Path = path.join(workDir, "scraped_source.mp4");
  await runExecFile(
    ffmpegBin,
    ["-y", "-i", downloadedFilePath, "-c:v", "copy", "-c:a", "aac", mp4Path],
    { timeoutMs: 120_000 },
  );

  return mp4Path;
}
