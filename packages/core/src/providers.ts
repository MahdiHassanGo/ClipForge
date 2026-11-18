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
      allowed: false,
      reason:
        "Direct YouTube media download is intentionally disabled. Upload your authorized video file to analyze and clip.",
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
