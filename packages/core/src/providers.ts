import fsSync from "node:fs";
import path from "node:path";
import type {
  AnalysisConfig,
  AudioTimelinePoint,
  CandidateClipDraft,
  CaptionCue,
  CaptionStyle,
  ExportPreset,
  FaceCamRegion,
  LayoutMode,
  MediaProbeResult,
  MotionTimelinePoint,
  SceneEventData,
  TranscriptSegmentData,
} from "./types.js";

/**
 * Media ingestion provider interface.
 * MVP implements AuthorizedUploadIngestionProvider; future creator-authorized
 * OAuth / studio integrations can implement this same interface without UI rewrites.
 */
export interface MediaIngestionProvider {
  readonly id: string;
  readonly displayName: string;
  readonly requiresUserUpload: boolean;
  canIngestDirectly(youtubeVideoId: string): Promise<{
    allowed: boolean;
    reason: string;
  }>;
}

export class AuthorizedUploadIngestionProvider implements MediaIngestionProvider {
  readonly id = "authorized_upload";
  readonly displayName = "Authorized User Upload";
  readonly requiresUserUpload = true;

  async canIngestDirectly(_youtubeVideoId: string): Promise<{
    allowed: boolean;
    reason: string;
  }> {
    return {
      allowed: true,
      reason:
        "Direct media scraping is supported via yt-dlp. You can also upload a local recording if preferred.",
    };
  }
}

export class DirectScrapeIngestionProvider implements MediaIngestionProvider {
  readonly id = "direct_scrape";
  readonly displayName = "Direct Media Scrape (yt-dlp & FFmpeg)";
  readonly requiresUserUpload = false;

  async canIngestDirectly(_urlOrVideoId: string): Promise<{
    allowed: boolean;
    reason: string;
  }> {
    return {
      allowed: true,
      reason:
        "Direct media scraping active. Highlights will be extracted directly from the video/stream URL without manual file upload.",
    };
  }
}

export interface SpeechRecognitionResult {
  providerName: string;
  language: string;
  segments: TranscriptSegmentData[];
  notice?: string;
}

export interface SpeechRecognitionProvider {
  readonly name: string;
  transcribe(params: {
    audioFilePath: string;
    durationSec: number;
    languageHint: string;
    audioTimeline: AudioTimelinePoint[];
  }): Promise<SpeechRecognitionResult>;
}

export interface AudioAnalysisResult {
  timeline: AudioTimelinePoint[];
  events: SceneEventData[];
}

export interface AudioAnalysisProvider {
  readonly name: string;
  analyze(params: {
    videoFilePath: string;
    durationSec: number;
    hasAudio: boolean;
  }): Promise<AudioAnalysisResult>;
}

export interface SceneDetectionResult {
  timeline: MotionTimelinePoint[];
  events: SceneEventData[];
}

export interface SceneDetectionProvider {
  readonly name: string;
  detect(params: {
    videoFilePath: string;
    durationSec: number;
  }): Promise<SceneDetectionResult>;
}

export interface FaceCamDetectionResult {
  detected: boolean;
  region: FaceCamRegion | null;
  method: string;
}

export interface FaceCamDetectionProvider {
  readonly name: string;
  detect(params: {
    videoFilePath: string;
    probe: MediaProbeResult;
    workDir: string;
  }): Promise<FaceCamDetectionResult>;
}

export interface ClipScoringInput {
  probe: MediaProbeResult;
  transcriptSegments: TranscriptSegmentData[];
  audioTimeline: AudioTimelinePoint[];
  motionTimeline: MotionTimelinePoint[];
  sceneEvents: SceneEventData[];
  faceCam: FaceCamDetectionResult;
  config: AnalysisConfig;
}

export interface ClipScoringProvider {
  readonly name: string;
  generateCandidates(input: ClipScoringInput): CandidateClipDraft[];
}

export interface RenderClipRequest {
  sourceVideoPath: string;
  outputVideoPath: string;
  workDir: string;
  probe: MediaProbeResult;
  startSec: number;
  endSec: number;
  preset: ExportPreset;
  layoutMode: LayoutMode;
  faceCamCrop: FaceCamRegion | null;
  captionsEnabled: boolean;
  captionStyle: CaptionStyle;
  captionLanguage: string;
  captions: CaptionCue[];
  onProgress?: (pct: number, message: string) => void;
}

export interface RenderClipOutput {
  outputVideoPath: string;
  width: number;
  height: number;
  durationSec: number;
  fileSizeBytes: number;
}

export interface VideoRendererProvider {
  readonly name: string;
  renderVerticalClip(request: RenderClipRequest): Promise<RenderClipOutput>;
}

/**
 * Finds the models/ directory starting from startDir and walking upwards to repo root if needed.
 */
function findModelsDir(startDir: string): string {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(cur, "models");
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
    if (fsSync.existsSync(path.join(cur, "pnpm-workspace.yaml"))) {
      return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir, "models");
}

/**
 * Resolves local whisper.cpp model by alias or path, with smart auto-selection.
 * Priority when 'auto': large-v3-turbo > large-v3 > medium.en > medium > small.en > small > base.en > base
 */
export function resolveLocalWhisperModelPath(
  env: Record<string, string | undefined>,
  baseDir: string,
): string | undefined {
  // 1. Explicit path in LOCAL_WHISPER_MODEL_PATH
  const rawPath = env.LOCAL_WHISPER_MODEL_PATH?.trim();
  if (rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
  }

  const modelsDir = findModelsDir(baseDir);

  // 2. Named alias in LOCAL_WHISPER_MODEL (e.g. "large", "large-turbo", "medium", "small", "base")
  const named = (env.LOCAL_WHISPER_MODEL ?? env.WHISPER_MODEL)?.toLowerCase().trim();
  if (named && named !== "auto") {
    const aliasMap: Record<string, string> = {
      base: "ggml-base.en.bin",
      "base.en": "ggml-base.en.bin",
      small: "ggml-small.en.bin",
      "small.en": "ggml-small.en.bin",
      medium: "ggml-medium.en.bin",
      "medium.en": "ggml-medium.en.bin",
      large: "ggml-large-v3-turbo.bin",
      "large-turbo": "ggml-large-v3-turbo.bin",
      "large-v3-turbo": "ggml-large-v3-turbo.bin",
      "large-v3": "ggml-large-v3.bin",
    };
    const target = aliasMap[named] ?? (named.endsWith(".bin") ? named : `ggml-${named}.bin`);
    const p = path.join(modelsDir, target);
    try {
      if (fsSync.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  // 3. Auto-detect highest quality offline model present in models/ directory
  const priorityList = [
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3.bin",
    "ggml-medium.en.bin",
    "ggml-medium.bin",
    "ggml-small.en.bin",
    "ggml-small.bin",
    "ggml-base.en.bin",
    "ggml-base.bin",
  ];

  for (const file of priorityList) {
    const candidate = path.join(modelsDir, file);
    try {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // continue search
    }
  }

  return undefined;
}

export interface SttStatusSummary {
  configured: boolean;
  label: string;
  provider: "groq" | "local_whisper" | "custom" | "openai" | "none";
  modelPath?: string;
}

export function detectSttStatus(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = process.cwd(),
): SttStatusSummary {
  const mode = (env.STT_PROVIDER ?? "auto").toLowerCase().trim();
  if (mode === "none") return { configured: false, label: "Manual (Free)", provider: "none" };

  const groqKey = env.GROQ_API_KEY?.trim();
  const localModel = resolveLocalWhisperModelPath(env, repoRoot);
  const customBaseUrl = env.STT_BASE_URL?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();

  if (mode === "groq" || (mode === "auto" && groqKey)) {
    if (groqKey) {
      return { configured: true, label: "Groq Whisper (Free)", provider: "groq" };
    }
  }

  if (mode === "local_whisper" || (mode === "auto" && localModel)) {
    if (localModel) {
      return {
        configured: true,
        label: "Local Whisper (Offline)",
        provider: "local_whisper",
        modelPath: localModel,
      };
    }
  }

  if (mode === "custom" || (mode === "auto" && customBaseUrl)) {
    if (customBaseUrl) {
      return { configured: true, label: "Custom Whisper", provider: "custom" };
    }
  }

  if (mode === "openai" || (mode === "auto" && openaiKey)) {
    if (openaiKey) {
      return { configured: true, label: "OpenAI Whisper", provider: "openai" };
    }
  }

  return { configured: false, label: "Manual (No Key)", provider: "none" };
}
