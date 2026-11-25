import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXPORT_PRESETS,
  generateAssSubtitles,
  type CaptionCue,
  type FaceCamRegion,
  type RenderClipOutput,
  type RenderClipRequest,
  type VideoRendererProvider,
} from "@clipforge/core";
import { getAvailableFfmpegFilters, resolveFfmpegPath } from "./ffmpeg-binaries.js";

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function makeEven(n: number, minVal = 2): number {
  const rounded = Math.max(minVal, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function computePixelCrop(
  region: FaceCamRegion,
  srcWidth: number,
  srcHeight: number,
): { x: number; y: number; w: number; h: number } {
  const x = makeEven(clamp(region.x, 0, 0.9) * srcWidth, 0);
  const y = makeEven(clamp(region.y, 0, 0.9) * srcHeight, 0);
  const maxW = Math.max(16, srcWidth - x);
  const maxH = Math.max(16, srcHeight - y);
  const w = makeEven(Math.min(maxW, clamp(region.width, 0.08, 1) * srcWidth), 16);
  const h = makeEven(Math.min(maxH, clamp(region.height, 0.08, 1) * srcHeight), 16);
  return { x, y, w, h };
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

function buildDrawtextChain(params: {
  cues: CaptionCue[];
  clipStartSec: number;
  clipEndSec: number;
  safeMarginBottomPx: number;
  style: RenderClipRequest["captionStyle"];
}): string {
  const clipDur = Math.max(0.1, params.clipEndSec - params.clipStartSec);
  const active = params.cues
    .filter((c) => c.text.trim() && !c.text.startsWith("[Speech activity detected"))
    .slice(0, 80);

  if (active.length === 0) return "";

  const fontSize = params.style === "bold_gaming" ? 54 : 46;
  const yExpr = `h-${params.safeMarginBottomPx}-text_h`;
  const boxOpts =
    params.style === "boxed_high_contrast"
      ? ":box=1:boxcolor=black@0.75:boxborderw=14"
      : ":borderw=4:bordercolor=black@0.9";

  const parts: string[] = [];
  for (const cue of active) {
    const start = Math.max(0, cue.startSec - params.clipStartSec);
    const end = Math.min(clipDur, cue.endSec - params.clipStartSec);
    if (end <= start + 0.05) continue;
    const text =
      params.style === "bold_gaming" ? cue.text.trim().toUpperCase() : cue.text.trim();
    parts.push(
      `drawtext=text='${escapeDrawtext(text)}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=${yExpr}${boxOpts}:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
    );
  }
  return parts.join(",");
}

export class FfmpegVideoRendererProvider implements VideoRendererProvider {
  readonly name = "ffmpeg_vertical_9x16_v1";

  async renderVerticalClip(request: RenderClipRequest): Promise<RenderClipOutput> {
    const spec = EXPORT_PRESETS[request.preset];
    const W = spec.width; // 1080
    const H = spec.height; // 1920
    const clipDuration = Math.max(1, request.endSec - request.startSec);

    await fs.mkdir(request.workDir, { recursive: true });
    await fs.mkdir(path.dirname(request.outputVideoPath), { recursive: true });

    const filters = await getAvailableFfmpegFilters();
    const hasUsableCaptions =
      request.captionsEnabled &&
      request.captions.some(
        (c) => c.text.trim().length > 0 && !c.text.startsWith("[Speech activity detected"),
      );

    let captionFilterSuffix = "";
    let assFileName: string | null = null;

    if (hasUsableCaptions) {
      if (filters.has("ass")) {
        assFileName = "captions.ass";
        const assContent = generateAssSubtitles({
          cues: request.captions,
          clipStartSec: request.startSec,
          clipEndSec: request.endSec,
          style: request.captionStyle,
          preset: request.preset,
        });
        await fs.writeFile(path.join(request.workDir, assFileName), assContent, "utf8");
        captionFilterSuffix = `,ass=${assFileName}`;
      } else if (filters.has("drawtext")) {
        const dt = buildDrawtextChain({
          cues: request.captions,
          clipStartSec: request.startSec,
          clipEndSec: request.endSec,
          safeMarginBottomPx: spec.safeMarginBottomPx,
          style: request.captionStyle,
        });
        if (dt) {
          captionFilterSuffix = `,${dt}`;
        }
      }
    }

    const useFaceCam =
      Boolean(request.faceCamCrop && request.faceCamCrop.enabled !== false) &&
      (request.layoutMode === "split_cam_top" || request.layoutMode === "pip_overlay");

    let filterComplex: string;

    if (useFaceCam && request.faceCamCrop && request.layoutMode === "split_cam_top") {
      // Split layout: Face-cam on top (1080x576, 30%), Gameplay on bottom (1080x1344, 70%)
      const topH = 576;
      const botH = H - topH; // 1344
      const crop = computePixelCrop(
        request.faceCamCrop,
        request.probe.width,
        request.probe.height,
      );

      filterComplex = [
        `[0:v]split=3[cam_src][bg_src][fg_src]`,
        // Top: cropped face cam scaled to fill 1080x576 cleanly + subtle bottom border
        `[cam_src]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${topH},drawbox=x=0:y=${topH - 4}:w=${W}:h=4:color=0x1e293b@1:t=fill[top]`,
        // Bottom ambient backdrop so gameplay preserves HUD visibility instead of harsh side-clipping
        `[bg_src]scale=${W}:${botH}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${botH},boxblur=18:2,eq=brightness=-0.12[bot_bg]`,
        // Gameplay foreground scaled cleanly to full 1080px width (slight vertical lift away from Shorts/TikTok bottom bar)
        `[fg_src]scale=${W}:-2:flags=lanczos[bot_fg]`,
        `[bot_bg][bot_fg]overlay=(W-w)/2:(H-h)/2-90[bot]`,
        `[top][bot]vstack=inputs=2,fps=${spec.fps},format=yuv420p${captionFilterSuffix}[vout]`,
      ].join(";");
    } else if (useFaceCam && request.faceCamCrop && request.layoutMode === "pip_overlay") {
      // Gameplay focus + framed face-cam overlay in upper safe zone (avoids HUD & platform UI)
      const crop = computePixelCrop(
        request.faceCamCrop,
        request.probe.width,
        request.probe.height,
      );
      const pipW = 360;
      const pipH = 264;
      const border = 6;

      filterComplex = [
        `[0:v]split=3[cam_src][bg_src][fg_src]`,
        `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.14[bg]`,
        `[fg_src]scale=${W}:-2:flags=lanczos[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2+40[base]`,
        `[cam_src]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${pipW}:${pipH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${pipW}:${pipH},pad=${pipW + border * 2}:${pipH + border * 2}:${border}:${border}:color=0x38bdf8[cam]`,
        `[base][cam]overlay=56:210,fps=${spec.fps},format=yuv420p${captionFilterSuffix}[vout]`,
      ].join(";");
    } else if (request.layoutMode === "podcast_center_fill") {
      // Podcast / Talking-Head Center Fill: full-bleed 9:16 center crop with no blur bars
      filterComplex = [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${spec.fps},format=yuv420p${captionFilterSuffix}[vout]`,
      ].join(";");
    } else {
      // Gameplay / Full-Frame 16:9 Fit: blurred ambient 9:16 fill + crisp wide frame centered above bottom UI safe zone
      filterComplex = [
        `[0:v]split=2[bg_src][fg_src]`,
        `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H},boxblur=22:2,eq=brightness=-0.14[bg]`,
        `[fg_src]scale=${W}:-2:flags=lanczos[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2-60,fps=${spec.fps},format=yuv420p${captionFilterSuffix}[vout]`,
      ].join(";");
    }

    const args: string[] = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      request.startSec.toFixed(3),
      "-t",
      clipDuration.toFixed(3),
      "-i",
      request.sourceVideoPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
    ];

    if (request.probe.hasAudio) {
      args.push(
        "-map",
        "0:a:0?",
        "-c:a",
        "aac",
        "-b:a",
        spec.audioBitrate,
        "-ar",
        "48000",
        "-ac",
        "2",
      );
    } else {
      args.push("-an");
    }

    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-maxrate",
      spec.videoBitrate,
      "-bufsize",
      "16M",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      request.outputVideoPath,
    );

    request.onProgress?.(10, `Rendering 9:16 ${spec.label} video...`);

    await runFfmpegWithProgress({
      args,
      cwd: request.workDir,
      expectedDurationSec: clipDuration,
      onProgress: (pct) => {
        const mapped = Math.min(95, Math.max(10, Math.round(10 + pct * 0.85)));
        request.onProgress?.(mapped, `Encoding ${spec.label} (${mapped}%)`);
      },
    });

    const stat = await fs.stat(request.outputVideoPath);
    if (stat.size < 1024) {
      throw new Error("Rendered MP4 output appears corrupted or empty.");
    }

    request.onProgress?.(100, "Render complete.");
    return {
      outputVideoPath: request.outputVideoPath,
      width: W,
      height: H,
      durationSec: Math.round(clipDuration * 100) / 100,
      fileSizeBytes: stat.size,
    };
  }
}

function runFfmpegWithProgress(params: {
  args: string[];
  cwd: string;
  expectedDurationSec: number;
  onProgress?: (pct0to100: number) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), params.args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let lastReportedPct = -1;

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.startsWith("out_time_us=")) {
          const us = Number(line.slice("out_time_us=".length));
          if (Number.isFinite(us) && params.expectedDurationSec > 0) {
            const pct = Math.min(
              100,
              Math.max(0, Math.round((us / 1_000_000 / params.expectedDurationSec) * 100)),
            );
            if (pct - lastReportedPct >= 5) {
              lastReportedPct = pct;
              params.onProgress?.(pct);
            }
          }
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg render failed (exit ${code}): ${stderr.slice(-800)}`));
        return;
      }
      resolve();
    });
  });
}
