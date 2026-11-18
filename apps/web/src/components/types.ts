import type {
  AnalysisConfig,
  CandidateStatus,
  CaptionCue,
  CaptionStyle,
  ExportPreset,
  FaceCamRegion,
  JobStatus,
  LayoutMode,
  MetadataSource,
  RenderStatus,
  SceneEventType,
  SignalBreakdown,
  StreamType,
} from "@clipforge/core/client";

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface CapabilitiesDto {
  youtubeApiConfigured: boolean;
  whisperConfigured: boolean;
  sttProviderLabel: string;
  storageProvider: string;
  maxUploadBytes: number;
  defaultAnalysisConfig: AnalysisConfig;
}

export interface CandidateClipDto {
  id: string;
  jobId: string;
  rank: number;
  title: string;
  startSec: number;
  endSec: number;
  originalStartSec: number;
  originalEndSec: number;
  score: number;
  confidence: number;
  signalBreakdown: SignalBreakdown;
  reason: string;
  transcriptExcerpt: string;
  status: CandidateStatus;
  layoutMode: LayoutMode;
  faceCamCropJson: FaceCamRegion | null;
  captionLanguage: string;
  captionStyle: CaptionStyle;
  captionsEnabled: boolean;
  captionsJson: CaptionCue[];
  hasUnreviewedCaptions: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SceneEventDto {
  id: string;
  timestampSec: number;
  endSec: number | null;
  type: SceneEventType;
  score: number;
}

export interface RenderExportDto {
  id: string;
  jobId: string;
  clipId: string;
  preset: ExportPreset;
  status: RenderStatus;
  startSec: number;
  endSec: number;
  layoutMode: LayoutMode;
  captionStyle: CaptionStyle;
  captionLanguage: string;
  progressPct: number;
  progressMessage: string | null;
  outputFileName: string | null;
  outputFileSizeBytes: number | null;
  outputDurationSec: number | null;
  width: number;
  height: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  completedAt: string | null;
  clip?: {
    id: string;
    title: string;
    rank: number;
  };
}

export interface ClipJobSummaryDto {
  id: string;
  status: JobStatus;
  youtubeUrl: string;
  youtubeVideoId: string;
  youtubeTitle: string | null;
  youtubeChannel: string | null;
  youtubeThumbnailUrl: string | null;
  youtubeDurationSec: number | null;
  youtubeStreamType: StreamType;
  metadataSource: MetadataSource;
  metadataNotice: string | null;
  sourceFileName: string | null;
  sourceFileSizeBytes: number | null;
  mediaDurationSec: number | null;
  progressPct: number;
  progressMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: {
    candidates: number;
    renderExports: number;
  };
}

export interface ClipJobDetailDto extends ClipJobSummaryDto {
  sourceStorageKey: string | null;
  sourceMimeType: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  mediaFps: number | null;
  mediaHasAudio: boolean | null;
  analysisConfigJson: AnalysisConfig | null;
  faceCamDetected: boolean;
  faceCamRegionJson: FaceCamRegion | null;
  speechProviderUsed: string | null;
  analysisSummary: string | null;
  failedFromStatus: JobStatus | null;
  retryCount: number;
  candidates: CandidateClipDto[];
  sceneEvents: SceneEventDto[];
  renderExports: RenderExportDto[];
}
