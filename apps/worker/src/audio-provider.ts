import { spawn } from "node:child_process";
import type {
  AudioAnalysisProvider,
  AudioAnalysisResult,
  AudioTimelinePoint,
  SceneEventData,
} from "@clipforge/core";
import { resolveFfmpegPath } from "./ffmpeg-binaries.js";

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Extracts raw 8kHz mono s16le PCM via FFmpeg stream and computes per-second
 * RMS dB, peak dB, relative reaction contrast (z-score + onset delta), and
 * silence-to-burst transitions. Explicitly avoids ranking purely by raw loudness.
 */
export class FfmpegAudioAnalysisProvider implements AudioAnalysisProvider {
  readonly name = "ffmpeg_pcm_dynamics_v1";

  async analyze(params: {
    videoFilePath: string;
    durationSec: number;
    hasAudio: boolean;
  }): Promise<AudioAnalysisResult> {
    const totalSeconds = Math.max(1, Math.ceil(params.durationSec));
    if (!params.hasAudio) {
      return {
        timeline: Array.from({ length: totalSeconds }, (_, second) => ({
          second,
          rmsDb: -90,
          peakDb: -90,
          reactionScore: 0,
          isSilenceToBurst: false,
        })),
        events: [],
      };
    }

    const sampleRate = 8000;
    const perSecondStats = await extractPerSecondPcmStats(
      params.videoFilePath,
      sampleRate,
    );

    if (perSecondStats.length === 0) {
      return { timeline: [], events: [] };
    }

    // Compute robust baseline (median & std-dev of active RMS dB) so constant loudness scores low
    const rmsValues = perSecondStats.map((s) => s.rmsDb);
    const sorted = [...rmsValues].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? -35;
    const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = Math.max(2.0, absDevs[Math.floor(absDevs.length / 2)] ?? 4.0);
    const robustStd = mad * 1.4826;

    const timeline: AudioTimelinePoint[] = [];
    const events: SceneEventData[] = [];

    for (let i = 0; i < perSecondStats.length; i++) {
      const cur = perSecondStats[i]!;
      const prev1 = perSecondStats[Math.max(0, i - 1)]!;
      const prev2 = perSecondStats[Math.max(0, i - 2)]!;
      const prev3 = perSecondStats[Math.max(0, i - 3)]!;
      const priorAvg = (prev1.rmsDb + prev2.rmsDb + prev3.rmsDb) / 3;

      // Relative lift above whole-video baseline
      const zScore = (cur.rmsDb - median) / robustStd;
      // Sudden local onset jump compared to the previous 3 seconds
      const onsetDeltaDb = cur.rmsDb - priorAvg;
      // Dynamic crest factor (voice excitement/laughter has punchier crest than flat game noise)
      const crestDb = Math.max(0, cur.peakDb - cur.rmsDb);
      const crestNorm = clamp01((crestDb - 6) / 14);

      const isSilenceToBurst =
        priorAvg < median - 3 && onsetDeltaDb >= 7.5 && cur.rmsDb > -42;

      const zNorm = clamp01((zScore - 0.35) / 2.6);
      const onsetNorm = clamp01((onsetDeltaDb - 2.0) / 12.0);
      const reactionScore = clamp01(
        zNorm * 0.42 + onsetNorm * 0.43 + crestNorm * 0.15,
      );

      timeline.push({
        second: i,
        rmsDb: round2(cur.rmsDb),
        peakDb: round2(cur.peakDb),
        reactionScore: round2(reactionScore),
        isSilenceToBurst,
      });

      if (isSilenceToBurst) {
        events.push({
          timestampSec: i,
          type: "silence_to_burst",
          score: round2(clamp01(reactionScore + 0.18)),
          metadata: {
            rmsDb: round2(cur.rmsDb),
            onsetDeltaDb: round2(onsetDeltaDb),
          },
        });
      } else if (reactionScore >= 0.62) {
        events.push({
          timestampSec: i,
          type: "audio_reaction",
          score: round2(reactionScore),
          metadata: {
            rmsDb: round2(cur.rmsDb),
            zScore: round2(zScore),
            onsetDeltaDb: round2(onsetDeltaDb),
          },
        });
      }
    }

    return { timeline, events };
  }
}

function extractPerSecondPcmStats(
  videoFilePath: string,
  sampleRate: number,
): Promise<Array<{ rmsDb: number; peakDb: number }>> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const proc = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        videoFilePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const bytesPerSecond = sampleRate * 2;
    const stats: Array<{ rmsDb: number; peakDb: number }> = [];
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";

    const processSecondBuffer = (buf: Buffer) => {
      const sampleCount = Math.floor(buf.length / 2);
      if (sampleCount === 0) return;
      let sumSq = 0;
      let peak = 0;
      for (let off = 0; off < sampleCount * 2; off += 2) {
        const sample = buf.readInt16LE(off) / 32768;
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        sumSq += sample * sample;
      }
      const rms = Math.sqrt(sumSq / sampleCount);
      const rmsDb = rms > 1e-6 ? 20 * Math.log10(rms) : -90;
      const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -90;
      stats.push({ rmsDb, peakDb });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= bytesPerSecond) {
        processSecondBuffer(pending.subarray(0, bytesPerSecond));
        pending = pending.subarray(bytesPerSecond);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (pending.length >= 4) {
        processSecondBuffer(pending);
      }
      if (code !== 0 && stats.length === 0) {
        reject(new Error(`Audio extraction failed (exit ${code}): ${stderr.slice(-500)}`));
        return;
      }
      resolve(stats);
    });
  });
}
