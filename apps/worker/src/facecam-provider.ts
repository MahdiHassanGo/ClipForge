import type {
  FaceCamDetectionProvider,
  FaceCamDetectionResult,
  FaceCamRegion,
  MediaProbeResult,
} from "@clipforge/core";
import { resolveFfmpegPath, runExecFile } from "./ffmpeg-binaries.js";

type CornerKey = "top_left" | "top_right" | "bottom_left" | "bottom_right";

interface CornerBox {
  corner: CornerKey;
  x: number;
  y: number;
  width: number;
  height: number;
}

const CORNERS: readonly CornerBox[] = [
  { corner: "top_left", x: 0.02, y: 0.03, width: 0.23, height: 0.24 },
  { corner: "top_right", x: 0.75, y: 0.03, width: 0.23, height: 0.24 },
  { corner: "bottom_left", x: 0.02, y: 0.72, width: 0.23, height: 0.24 },
  { corner: "bottom_right", x: 0.75, y: 0.72, width: 0.23, height: 0.24 },
];

interface RegionStats {
  avgMotion: number;
  avgSat: number;
  avgLuma: number;
  samples: number;
}

async function measureRegionStats(
  videoFilePath: string,
  durationSec: number,
  cropExpr: string,
): Promise<RegionStats> {
  // Sample up to ~20s spread from 10% into the video for fast, reliable corner inspection
  const seekStart = Math.min(Math.max(0, durationSec * 0.1), Math.max(0, durationSec - 5));
  const sampleDuration = Math.min(20, Math.max(3, durationSec - seekStart));

  const { stderr } = await runExecFile(
    resolveFfmpegPath(),
    [
      "-v",
      "info",
      "-ss",
      String(seekStart),
      "-t",
      String(sampleDuration),
      "-i",
      videoFilePath,
      "-vf",
      `fps=1,${cropExpr},scale=96:54,signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF,metadata=mode=print:key=lavfi.signalstats.SATAVG,metadata=mode=print:key=lavfi.signalstats.YAVG`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 45_000 },
  );

  let motionSum = 0;
  let motionCount = 0;
  let satSum = 0;
  let satCount = 0;
  let lumaSum = 0;
  let lumaCount = 0;

  for (const line of stderr.split("\n")) {
    const ydif = /lavfi\.signalstats\.YDIF=([0-9.]+)/.exec(line);
    if (ydif?.[1]) {
      motionSum += Number(ydif[1]);
      motionCount++;
      continue;
    }
    const sat = /lavfi\.signalstats\.SATAVG=([0-9.]+)/.exec(line);
    if (sat?.[1]) {
      satSum += Number(sat[1]);
      satCount++;
      continue;
    }
    const yavg = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (yavg?.[1]) {
      lumaSum += Number(yavg[1]);
      lumaCount++;
    }
  }

  return {
    avgMotion: motionCount > 0 ? motionSum / motionCount : 0,
    avgSat: satCount > 0 ? satSum / satCount : 0,
    avgLuma: lumaCount > 0 ? lumaSum / lumaCount : 0,
    samples: Math.max(motionCount, lumaCount),
  };
}

/**
 * Heuristic face-cam presence and corner-location detector behind FaceCamDetectionProvider.
 * Compares temporal motion & tonal independence of the 4 standard streamer webcam corners
 * against the central gameplay viewport. Users can always toggle or refine the box in the UI.
 */
export class FfmpegFaceCamDetectionProvider implements FaceCamDetectionProvider {
  readonly name = "ffmpeg_corner_heuristic_v1";

  async detect(params: {
    videoFilePath: string;
    probe: MediaProbeResult;
    workDir: string;
  }): Promise<FaceCamDetectionResult> {
    // Only run corner webcam detection on landscape / standard gaming streams
    if (params.probe.width < params.probe.height) {
      return {
        detected: false,
        region: null,
        method: `${this.name}:vertical_source_skipped`,
      };
    }

    try {
      const center = await measureRegionStats(
        params.videoFilePath,
        params.probe.durationSec,
        "crop=iw*0.44:ih*0.44:iw*0.28:ih*0.28",
      );

      const candidates: Array<{ box: CornerBox; score: number }> = [];

      for (const box of CORNERS) {
        const cropExpr = `crop=iw*${box.width}:ih*${box.height}:iw*${box.x}:ih*${box.y}`;
        const stats = await measureRegionStats(
          params.videoFilePath,
          params.probe.durationSec,
          cropExpr,
        );

        if (stats.samples < 2) continue;

        // A live webcam typically has:
        // 1) Moderate continuous motion (head/mouth movement: YDIF ~1.2..14) rather than static HUD (YDIF < 0.4) or pure high-speed game panning
        // 2) Non-black lighting (YAVG 35..220) and realistic chroma (SATAVG 12..110)
        // 3) Distinct temporal/tonal profile compared to the central gameplay viewport
        const liveMotionFit =
          stats.avgMotion >= 0.8 && stats.avgMotion <= 18
            ? 0.45
            : stats.avgMotion > 18
              ? 0.15
              : 0;
        const lightingFit = stats.avgLuma >= 32 && stats.avgLuma <= 225 ? 0.25 : 0;
        const chromaFit = stats.avgSat >= 10 && stats.avgSat <= 125 ? 0.15 : 0;
        const independence =
          Math.abs(stats.avgLuma - center.avgLuma) > 12 ||
          Math.abs(stats.avgMotion - center.avgMotion) > 2.5
            ? 0.2
            : 0;

        const score = Math.min(1, liveMotionFit + lightingFit + chromaFit + independence);
        candidates.push({ box, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      const runnerUp = candidates[1];

      // Require clear signal AND distinction from uniform full-screen footage
      if (best && best.score >= 0.72 && (!runnerUp || best.score - runnerUp.score >= 0.08)) {
        const region: FaceCamRegion = {
          x: best.box.x,
          y: best.box.y,
          width: best.box.width,
          height: best.box.height,
          corner: best.box.corner,
          confidence: Math.round(best.score * 100) / 100,
          enabled: true,
        };
        return {
          detected: true,
          region,
          method: this.name,
        };
      }

      return {
        detected: false,
        region: null,
        method: this.name,
      };
    } catch {
      return {
        detected: false,
        region: null,
        method: `${this.name}:fallback_none`,
      };
    }
  }
}
