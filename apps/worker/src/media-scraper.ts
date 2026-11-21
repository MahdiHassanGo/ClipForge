import { spawn } from "node:child_process";
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
 * Spawns yt-dlp with live stdout/stderr streaming, real-time download progress parsing,
 * activity-based timeout protection, and robust error extraction.
 */
function runSpawnYtDlp(params: {
  bin: string;
  args: string[];
  workDir: string;
  inactivityTimeoutMs?: number;
  totalTimeoutMs?: number;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const {
    bin,
    args,
    workDir,
    inactivityTimeoutMs = 180_000,
    totalTimeoutMs = 1_800_000,
    onProgress,
  } = params;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutTail = "";
    let stderrTail = "";
    let lastProgressReportTime = 0;
    let isFinished = false;

    let inactivityTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;

    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (isFinished) return;
        cleanup();
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 3_000);
        reject(
          new Error(
            `yt-dlp download stalled: no network activity received for ${Math.round(inactivityTimeoutMs / 1000)}s.`,
          ),
        );
      }, inactivityTimeoutMs);
    };

    const cleanup = () => {
      isFinished = true;
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (totalTimer) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
    };

    totalTimer = setTimeout(() => {
      if (isFinished) return;
      cleanup();
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 3_000);
      reject(
        new Error(
          `yt-dlp download timed out after overall limit of ${Math.round(totalTimeoutMs / 1000)}s.`,
        ),
      );
    }, totalTimeoutMs);

    resetInactivityTimer();

    child.stdout.on("data", (chunk: Buffer) => {
      resetInactivityTimer();
      const text = chunk.toString();
      stdoutTail = (stdoutTail + text).slice(-8000);

      // Parse yt-dlp download progress: e.g. [download]  12.3% of 3.00GiB at 14.50MiB/s ETA 03:20
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const match =
          /\[download\]\s+([\d.]+)%\s+of\s+([~]?[\d.]+[A-Za-z]+)(?:\s+at\s+([\d.]+[A-Za-z/]+))?(?:\s+ETA\s+([\d:]+))?/.exec(
            line,
          );
        if (match) {
          const now = Date.now();
          // Throttle progress updates to at most once per 1.5 seconds to avoid flooding
          if (now - lastProgressReportTime >= 1500) {
            lastProgressReportTime = now;
            const pct = match[1];
            const size = match[2];
            const rate = match[3] ? ` at ${match[3]}` : "";
            const eta = match[4] ? ` (ETA ${match[4]})` : "";
            onProgress?.(`Downloading media: ${pct}% of ${size}${rate}${eta}`);
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      resetInactivityTimer();
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-8000);
    });

    child.on("error", (err) => {
      if (isFinished) return;
      cleanup();
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (isFinished) return;
      cleanup();

      if (code === 0) {
        resolve();
        return;
      }

      const errDetails =
        stderrTail.trim() ||
        stdoutTail
          .split("\n")
          .filter((l) => l.includes("ERROR") || l.includes("WARNING"))
          .slice(-5)
          .join(" ") ||
        stdoutTail.slice(-400) ||
        `Exited with code ${code} (${signal ?? "no signal"})`;

      reject(new Error(`yt-dlp failed (exit ${code}): ${errDetails.slice(-800)}`));
    });
  });
}

/**
 * Directly scrapes and downloads media from any URL (YouTube video/VOD/archived livestream,
 * Twitch stream/VOD, Kick, podcast audio, or direct URL) into a standard MP4 file.
 * Automatically fetches native auto-captions/subtitles when available.
 * If the source is audio-only (e.g. podcast audio), synthesizes a clean 1080x1920
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
    "--newline",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--concurrent-fragments",
    "4",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt",
    "-f",
    "bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best[ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url,
  ];

  try {
    await runSpawnYtDlp({
      bin: ytdlpBin,
      args: ytdlpArgs,
      workDir,
      onProgress,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("yt-dlp scrape failed", { url, error: errorMsg });
    throw new Error(`Failed to scrape media from link: ${errorMsg.slice(-500)}`);
  }

  // Find the scraped media file in workDir (excluding subtitles and partial downloads)
  const dirFiles = await fs.readdir(workDir);
  const mediaCandidates = dirFiles.filter(
    (f) =>
      f.startsWith("scraped_source.") &&
      !f.endsWith(".vtt") &&
      !f.endsWith(".part") &&
      !f.endsWith(".ytdl"),
  );

  if (mediaCandidates.length === 0) {
    throw new Error("yt-dlp finished but no output media file was created.");
  }

  // Prefer .mp4 if multiple files were created during remuxing
  const chosenFile =
    mediaCandidates.find((f) => f.endsWith(".mp4")) ??
    mediaCandidates.find((f) => f.endsWith(".mkv") || f.endsWith(".webm")) ??
    mediaCandidates[0]!;

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
