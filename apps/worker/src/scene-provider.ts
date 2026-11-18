import type {
  MotionTimelinePoint,
  SceneDetectionProvider,
  SceneDetectionResult,
  SceneEventData,
} from "@clipforge/core";
import { resolveFfmpegPath, runExecFile } from "./ffmpeg-binaries.js";

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Uses FFmpeg scene-change detection and frame-difference luminance (tblend + signalstats)
 * sampled at 2fps (downscaled for speed) to detect real scene cuts and gameplay motion bursts.
 */
export class FfmpegSceneDetectionProvider implements SceneDetectionProvider {
  readonly name = "ffmpeg_scene_motion_v1";

  async detect(params: {
    videoFilePath: string;
    durationSec: number;
  }): Promise<SceneDetectionResult> {
    const totalSeconds = Math.max(1, Math.ceil(params.durationSec));
    const ffmpeg = resolveFfmpegPath();

    // Pass 1: Scene cuts via select='gt(scene,0.22)',showinfo
    const cutSeconds = new Map<number, number>();
    try {
      const { stderr } = await runExecFile(
        ffmpeg,
        [
          "-v",
          "info",
          "-i",
          params.videoFilePath,
          "-vf",
          "fps=2,scale=320:-2,select='gt(scene,0.22)',showinfo",
          "-an",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 240_000 },
      );

      const ptsRegex = /pts_time:([0-9.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = ptsRegex.exec(stderr)) !== null) {
        const ts = Number(match[1]);
        if (Number.isFinite(ts) && ts >= 0) {
          const sec = Math.min(totalSeconds - 1, Math.floor(ts));
          cutSeconds.set(sec, (cutSeconds.get(sec) ?? 0) + 1);
        }
      }
    } catch {
      // Continue with motion pass even if scene filter produced no output
    }

    // Pass 2: Gameplay motion intensity via frame-to-frame difference (tblend + signalstats)
    const rawMotionBySecond = new Array<number>(totalSeconds).fill(0);
    const sampleCountBySecond = new Array<number>(totalSeconds).fill(0);

    try {
      const { stderr } = await runExecFile(
        ffmpeg,
        [
          "-v",
          "info",
          "-i",
          params.videoFilePath,
          "-vf",
          "fps=2,scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG",
          "-an",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 240_000 },
      );

      // Parse pairs of pts_time and lavfi.signalstats.YAVG from ffmpeg metadata output
      const lines = stderr.split("\n");
      let currentPts = 0;
      for (const line of lines) {
        const ptsMatch = /pts_time:([0-9.]+)/.exec(line);
        if (ptsMatch?.[1]) {
          currentPts = Number(ptsMatch[1]);
          continue;
        }
        const yavgMatch = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
        if (yavgMatch?.[1]) {
          const yavg = Number(yavgMatch[1]);
          if (Number.isFinite(yavg) && Number.isFinite(currentPts)) {
            const sec = Math.min(totalSeconds - 1, Math.max(0, Math.floor(currentPts)));
            rawMotionBySecond[sec] = (rawMotionBySecond[sec] ?? 0) + yavg;
            sampleCountBySecond[sec] = (sampleCountBySecond[sec] ?? 0) + 1;
          }
        }
      }
    } catch {
      // fallback gracefully to cut-only motion estimate
    }

    const avgMotion = rawMotionBySecond.map((sum, idx) => {
      const count = sampleCountBySecond[idx] ?? 0;
      return count > 0 ? sum / count : 0;
    });

    const nonZero = avgMotion.filter((v) => v > 0).sort((a, b) => a - b);
    const p50 = nonZero[Math.floor(nonZero.length * 0.5)] ?? 8;
    const p95 = Math.max(p50 + 4, nonZero[Math.floor(nonZero.length * 0.95)] ?? 28);

    const timeline: MotionTimelinePoint[] = [];
    const events: SceneEventData[] = [];

    for (let sec = 0; sec < totalSeconds; sec++) {
      const raw = avgMotion[sec] ?? 0;
      const cutCount = cutSeconds.get(sec) ?? 0;
      const normalizedMotion =
        raw > 0
          ? clamp01((raw - p50 * 0.45) / Math.max(4, p95 - p50 * 0.45))
          : cutCount > 0
            ? 0.6
            : 0;

      timeline.push({
        second: sec,
        motionScore: round2(normalizedMotion),
        sceneCut: cutCount > 0,
      });

      if (cutCount > 0) {
        events.push({
          timestampSec: sec,
          type: "scene_cut",
          score: round2(clamp01(0.7 + Math.min(0.25, cutCount * 0.1))),
          metadata: { cutCount },
        });
      }

      if (normalizedMotion >= 0.72) {
        events.push({
          timestampSec: sec,
          type: "motion_burst",
          score: round2(normalizedMotion),
          metadata: { rawDiffYavg: round2(raw) },
        });
      }
    }

    return { timeline, events };
  }
}
