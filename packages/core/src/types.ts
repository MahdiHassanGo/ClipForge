export type JobStatus =
  | "queued"
  | "uploading"
  | "analyzing"
  | "candidates_ready"
  | "rendering"
  | "complete"
  | "failed"
  | "cancelled";

export type RenderStatus =
  | "queued"
  | "rendering"
  | "complete"
  | "failed"
  | "cancelled";

export type StreamType =
  | "regular_video"
  | "live_stream"
  | "archived_stream"
  | "upcoming_stream"
  | "unknown";

export type MetadataSource = "youtube_data_api" | "oembed" | "none";

export type SceneEventType =
  | "scene_cut"
  | "motion_burst"
  | "audio_reaction"
  | "speech_peak"
  | "silence_to_burst";

export type CandidateStatus = "suggested" | "selected" | "discarded";

export type LayoutMode = "split_cam_top" | "pip_overlay" | "gameplay_focus";

export type CaptionStyle =
  | "bold_gaming"
  | "clean_minimal"
  | "boxed_high_contrast";

export type ExportPreset = "youtube_shorts" | "tiktok" | "instagram_reels";

export interface FaceCamRegion {
  /** Normalized 0..1 coordinates relative to source video dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right" | "custom";
  confidence: number;
  enabled?: boolean;
}

export interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
  confidence: number;
  lowConfidence: boolean;
}

export interface TranscriptSegmentData {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  language: string;
  confidence: number;
  lowConfidence: boolean;
  needsReview: boolean;
  words: TranscriptWord[];
}

export interface CaptionCue {
  id: string;
  /** Seconds relative to source video timeline */
  startSec: number;
  endSec: number;
  text: string;
  confidence: number;
  needsReview: boolean;
}

export interface SceneEventData {
  timestampSec: number;
  endSec?: number;
  type: SceneEventType;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface AudioTimelinePoint {
  second: number;
  rmsDb: number;
  peakDb: number;
  /** Relative contrast score (0..1), NOT raw loudness */
  reactionScore: number;
  isSilenceToBurst: boolean;
}

export interface MotionTimelinePoint {
  second: number;
  motionScore: number;
  sceneCut: boolean;
}

export interface SignalBreakdown {
  speechScore: number;
  reactionScore: number;
  motionScore: number;
  sceneScore: number;
  faceCamBonus: number;
  contextScore: number;
}

export interface AnalysisConfig {
  minClipSec: number;
  maxClipSec: number;
  targetClipSec: number;
  scoreThreshold: number;
  maxCandidates: number;
  captionLanguage: string;
}

export interface MediaProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export interface CandidateClipDraft {
  rank: number;
  title: string;
  startSec: number;
  endSec: number;
  score: number;
  confidence: number;
  signalBreakdown: SignalBreakdown;
  reason: string;
  transcriptExcerpt: string;
  layoutMode: LayoutMode;
  faceCamCrop: FaceCamRegion | null;
  captionLanguage: string;
  captionStyle: CaptionStyle;
  captions: CaptionCue[];
  hasUnreviewedCaptions: boolean;
}

export interface YouTubeParsedUrl {
  videoId: string;
  canonicalUrl: string;
  inputKind: "watch" | "short_link" | "live" | "shorts" | "embed";
}

export interface YouTubeMetadataResult {
  videoId: string;
  canonicalUrl: string;
  title: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  streamType: StreamType;
  metadataSource: MetadataSource;
  notice: string;
  mediaAccessAvailable: false;
  mediaAccessReason: string;
}
