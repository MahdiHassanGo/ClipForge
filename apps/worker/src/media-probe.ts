import type { MediaProbeResult } from "@clipforge/core";
import { resolveFfprobePath, runExecFile } from "./ffmpeg-binaries.js";

interface FfprobeOutput {
  format?: {
    duration?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: string;
  }>;
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw || raw === "0/0") return 30;
  const parts = raw.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const fps = num / den;
      if (fps > 1 && fps <= 240) return Math.round(fps * 100) / 100;
    }
  }
  const single = Number(raw);
  return Number.isFinite(single) && single > 1 ? single : 30;
}

export async function probeMediaFile(filePath: string): Promise<MediaProbeResult> {
  const { stdout } = await runExecFile(
    resolveFfprobePath(),
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeoutMs: 30_000 },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");

  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error("Uploaded file does not contain a readable video stream.");
  }

  const rawDuration =
    Number(parsed.format?.duration) || Number(videoStream.duration) || 0;
  if (!Number.isFinite(rawDuration) || rawDuration < 1) {
    throw new Error("Video duration could not be determined or is shorter than 1 second.");
  }

  return {
    durationSec: Math.round(rawDuration * 100) / 100,
    width: videoStream.width,
    height: videoStream.height,
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
  };
}
