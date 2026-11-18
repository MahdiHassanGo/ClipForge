-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'uploading', 'analyzing', 'candidates_ready', 'rendering', 'complete', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "StreamType" AS ENUM ('regular_video', 'live_stream', 'archived_stream', 'upcoming_stream', 'unknown');

-- CreateEnum
CREATE TYPE "MetadataSource" AS ENUM ('youtube_data_api', 'oembed', 'none');

-- CreateEnum
CREATE TYPE "SceneEventType" AS ENUM ('scene_cut', 'motion_burst', 'audio_reaction', 'speech_peak', 'silence_to_burst');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('suggested', 'selected', 'discarded');

-- CreateEnum
CREATE TYPE "LayoutMode" AS ENUM ('split_cam_top', 'pip_overlay', 'gameplay_focus');

-- CreateEnum
CREATE TYPE "CaptionStyle" AS ENUM ('bold_gaming', 'clean_minimal', 'boxed_high_contrast');

-- CreateEnum
CREATE TYPE "ExportPreset" AS ENUM ('youtube_shorts', 'tiktok', 'instagram_reels');

-- CreateEnum
CREATE TYPE "RenderStatus" AS ENUM ('queued', 'rendering', 'complete', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "youtubeUrl" TEXT NOT NULL,
    "youtubeVideoId" TEXT NOT NULL,
    "youtubeTitle" TEXT,
    "youtubeChannel" TEXT,
    "youtubeThumbnailUrl" TEXT,
    "youtubeDurationSec" INTEGER,
    "youtubeStreamType" "StreamType" NOT NULL DEFAULT 'unknown',
    "metadataSource" "MetadataSource" NOT NULL DEFAULT 'none',
    "metadataNotice" TEXT,
    "sourceProvider" TEXT NOT NULL DEFAULT 'authorized_upload',
    "sourceStorageKey" TEXT,
    "sourceFileName" TEXT,
    "sourceMimeType" TEXT,
    "sourceFileSizeBytes" BIGINT,
    "mediaDurationSec" DOUBLE PRECISION,
    "mediaWidth" INTEGER,
    "mediaHeight" INTEGER,
    "mediaFps" DOUBLE PRECISION,
    "mediaHasAudio" BOOLEAN,
    "analysisConfigJson" JSONB,
    "faceCamDetected" BOOLEAN NOT NULL DEFAULT false,
    "faceCamRegionJson" JSONB,
    "speechProviderUsed" TEXT,
    "analysisSummary" TEXT,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "failedFromStatus" "JobStatus",
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "workerLockedAt" TIMESTAMP(3),
    "workerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ClipJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "confidence" DOUBLE PRECISION NOT NULL,
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "wordsJson" JSONB,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "timestampSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION,
    "type" "SceneEventType" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "metadataJson" JSONB,

    CONSTRAINT "SceneEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateClip" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "originalStartSec" DOUBLE PRECISION NOT NULL,
    "originalEndSec" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "signalBreakdown" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "transcriptExcerpt" TEXT NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'suggested',
    "layoutMode" "LayoutMode" NOT NULL DEFAULT 'gameplay_focus',
    "faceCamCropJson" JSONB,
    "captionLanguage" TEXT NOT NULL DEFAULT 'en',
    "captionStyle" "CaptionStyle" NOT NULL DEFAULT 'bold_gaming',
    "captionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "captionsJson" JSONB NOT NULL,
    "hasUnreviewedCaptions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderExport" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "preset" "ExportPreset" NOT NULL,
    "status" "RenderStatus" NOT NULL DEFAULT 'queued',
    "startSec" DOUBLE PRECISION NOT NULL,
    "endSec" DOUBLE PRECISION NOT NULL,
    "layoutMode" "LayoutMode" NOT NULL,
    "captionStyle" "CaptionStyle" NOT NULL,
    "captionLanguage" TEXT NOT NULL,
    "captionsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "faceCamCropJson" JSONB,
    "captionsJson" JSONB NOT NULL,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "outputStorageKey" TEXT,
    "outputFileName" TEXT,
    "outputFileSizeBytes" BIGINT,
    "outputDurationSec" DOUBLE PRECISION,
    "width" INTEGER NOT NULL DEFAULT 1080,
    "height" INTEGER NOT NULL DEFAULT 1920,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "workerLockedAt" TIMESTAMP(3),
    "workerId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RenderExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "ClipJob_userId_createdAt_idx" ON "ClipJob"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ClipJob_status_workerLockedAt_idx" ON "ClipJob"("status", "workerLockedAt");

-- CreateIndex
CREATE INDEX "TranscriptSegment_jobId_startSec_idx" ON "TranscriptSegment"("jobId", "startSec");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_jobId_segmentIndex_key" ON "TranscriptSegment"("jobId", "segmentIndex");

-- CreateIndex
CREATE INDEX "SceneEvent_jobId_timestampSec_idx" ON "SceneEvent"("jobId", "timestampSec");

-- CreateIndex
CREATE INDEX "CandidateClip_jobId_rank_idx" ON "CandidateClip"("jobId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "RenderExport_idempotencyKey_key" ON "RenderExport"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RenderExport_userId_createdAt_idx" ON "RenderExport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderExport_jobId_status_idx" ON "RenderExport"("jobId", "status");

-- CreateIndex
CREATE INDEX "RenderExport_status_workerLockedAt_idx" ON "RenderExport"("status", "workerLockedAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneEvent" ADD CONSTRAINT "SceneEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateClip" ADD CONSTRAINT "CandidateClip_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderExport" ADD CONSTRAINT "RenderExport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderExport" ADD CONSTRAINT "RenderExport_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "CandidateClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderExport" ADD CONSTRAINT "RenderExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
