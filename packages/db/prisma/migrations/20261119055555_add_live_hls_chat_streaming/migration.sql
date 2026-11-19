-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'live_monitoring';

-- AlterEnum
ALTER TYPE "SceneEventType" ADD VALUE 'chat_velocity_spike';

-- AlterTable
ALTER TABLE "ClipJob" ADD COLUMN     "isLiveStream" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveAudioManifestUrl" TEXT,
ADD COLUMN     "liveChatVelocityJson" JSONB,
ADD COLUMN     "liveManifestUrl" TEXT;
