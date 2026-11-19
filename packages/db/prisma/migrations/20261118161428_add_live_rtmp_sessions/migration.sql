-- CreateEnum
CREATE TYPE "LiveSessionStatus" AS ENUM ('waiting', 'live', 'ended', 'error');

-- AlterTable
ALTER TABLE "ClipJob" ADD COLUMN     "liveChunkIndex" INTEGER,
ADD COLUMN     "liveSessionId" TEXT;

-- CreateTable
CREATE TABLE "LiveSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "LiveSessionStatus" NOT NULL DEFAULT 'waiting',
    "streamKeyHash" TEXT NOT NULL,
    "streamKeyLast4" TEXT NOT NULL,
    "chunkDurationSec" INTEGER NOT NULL DEFAULT 180,
    "youtubeUrl" TEXT,
    "youtubeVideoId" TEXT,
    "youtubeTitle" TEXT,
    "youtubeThumbnailUrl" TEXT,
    "analysisConfigJson" JSONB,
    "chunksReceived" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "lastChunkAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveSession_streamKeyHash_key" ON "LiveSession"("streamKeyHash");

-- CreateIndex
CREATE INDEX "LiveSession_userId_createdAt_idx" ON "LiveSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveSession_status_idx" ON "LiveSession"("status");

-- CreateIndex
CREATE INDEX "ClipJob_liveSessionId_liveChunkIndex_idx" ON "ClipJob"("liveSessionId", "liveChunkIndex");

-- AddForeignKey
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
