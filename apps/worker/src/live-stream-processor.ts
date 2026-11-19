import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma, Prisma } from "@clipforge/db";
import {
  DefaultClipScoringProvider,
  createLogger,
  createObjectStorageFromEnv,
  getDefaultAnalysisConfig,
  type AnalysisConfig,
  type MediaProbeResult,
  type ObjectStorageProvider,
} from "@clipforge/core";
import { resolveFfmpegPath, runExecFile } from "./ffmpeg-binaries.js";
import { resolveLiveManifest } from "./live-manifest-resolver.js";
import { pollLiveChatSnapshot } from "./live-chat-monitor.js";
import { FfmpegAudioAnalysisProvider } from "./audio-provider.js";
import { createSpeechRecognitionProvider } from "./speech-provider.js";
import { FfmpegFaceCamDetectionProvider } from "./facecam-provider.js";
import { probeMediaFile } from "./media-probe.js";

const logger = createLogger("clipforge-live-processor");

export class LiveStreamProcessor {
  private readonly repoRoot: string;
  private readonly tempRoot: string;
  private readonly storage: ObjectStorageProvider;
  private readonly audioProvider = new FfmpegAudioAnalysisProvider();
  private readonly faceCamProvider = new FfmpegFaceCamDetectionProvider();
  private readonly scoringProvider = new DefaultClipScoringProvider();

  constructor(options: { repoRoot: string; tempRoot: string }) {
    this.repoRoot = options.repoRoot;
    this.tempRoot = options.tempRoot;
    this.storage = createObjectStorageFromEnv(process.env, options.repoRoot);
  }

  /**
   * Processes an active live stream job following the 4-step architecture:
   * Step A: Rolling HLS manifest extraction
   * Step B: Audio-First ingestion (pulls low-bitrate audio chunks)
   * Step C: Live Chat Velocity spike tracking
   * Step D: Selective Video Slicing (downloads ONLY the 30-60s high-res video for peak moments)
   */
  async processLiveStreamJob(jobId: string, workerId: string): Promise<boolean> {
    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
    });

    if (!job || (job.status !== "live_monitoring" && job.status !== "analyzing")) {
      return false;
    }

    const jobLog = logger.child({ jobId, workerId, streamUrl: job.youtubeUrl });
    const workDir = path.join(this.tempRoot, `live_${jobId}_${Date.now()}`);

    try {
      await fs.mkdir(workDir, { recursive: true });

      const updateProgress = async (pct: number, message: string) => {
        await prisma.clipJob.update({
          where: { id: jobId },
          data: {
            progressPct: pct,
            progressMessage: message,
            workerLockedAt: new Date(),
          },
        });
      };

      // --- STEP A: Extract Rolling Live HLS Manifest ---
      await updateProgress(10, "Step A: Resolving rolling live HLS/DASH manifest...");
      jobLog.info("Resolving live HLS manifest...");

      const manifestResult = await resolveLiveManifest(
        job.liveManifestUrl || job.youtubeUrl,
      );

      await prisma.clipJob.update({
        where: { id: jobId },
        data: {
          isLiveStream: true,
          liveManifestUrl: manifestResult.videoManifestUrl,
          liveAudioManifestUrl: manifestResult.audioManifestUrl,
        },
      });

      // Sample a recent 90-second rolling live window
      const sampleWindowSec = 90;
      const ffmpeg = resolveFfmpegPath();

      // --- STEP B: Audio-First Bandwidth Optimization ---
      // Pull ONLY the lightweight audio stream (~1MB/min) from the live manifest
      await updateProgress(
        25,
        "Step B: Audio-First ingestion — pulling low-bitrate live audio stream...",
      );
      jobLog.info("Step B: Extracting live audio stream (skipping video)...");

      const audioWavPath = path.join(workDir, "live_audio_chunk.wav");
      await runExecFile(
        ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-ss",
          "0",
          "-t",
          String(sampleWindowSec),
          "-i",
          manifestResult.audioManifestUrl,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          audioWavPath,
        ],
        { timeoutMs: 90_000 },
      );

      // Run PCM audio reaction & excitement analysis
      await updateProgress(45, "Analyzing audio dynamics, excitement & silence-to-burst...");
      const audioResult = await this.audioProvider.analyze({
        videoFilePath: audioWavPath,
        durationSec: sampleWindowSec,
        hasAudio: true,
      });

      // Run speech-to-text (local whisper.cpp / Groq Free / fallback)
      await updateProgress(60, "Transcribing live commentary with word timestamps...");
      const speechProvider = createSpeechRecognitionProvider(
        process.env,
        this.repoRoot,
      );
      const speechResult = await speechProvider.transcribe({
        audioFilePath: audioWavPath,
        durationSec: sampleWindowSec,
        languageHint: "en",
        audioTimeline: audioResult.timeline,
      });

      // --- STEP C: Live Chat Velocity Spikes ---
      await updateProgress(
        72,
        "Step C: Polling live chat messages per second (MPS) & hype keywords...",
      );
      jobLog.info("Step C: Polling live chat velocity spikes...");

      const chatSnapshot = await pollLiveChatSnapshot({
        videoId: job.youtubeVideoId,
        streamDurationSec: sampleWindowSec,
      });

      const combinedSceneEvents = [
        ...audioResult.events,
        ...chatSnapshot.events,
      ].sort((a, b) => a.timestampSec - b.timestampSec);

      // Save live chat velocity snapshot to job
      if (chatSnapshot.velocityPoints.length > 0) {
        await prisma.clipJob.update({
          where: { id: jobId },
          data: {
            liveChatVelocityJson:
              chatSnapshot.velocityPoints as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // --- Score Multi-Signal Candidate Moments ---
      const defaultCfg = getDefaultAnalysisConfig();
      const config: AnalysisConfig = {
        ...defaultCfg,
        minClipSec: Math.min(defaultCfg.minClipSec, 15),
        maxClipSec: Math.min(defaultCfg.maxClipSec, 45),
        targetClipSec: 30,
        scoreThreshold: 0.35,
      };

      const drafts = this.scoringProvider.generateCandidates({
        probe: {
          durationSec: sampleWindowSec,
          width: 1920,
          height: 1080,
          fps: 30,
          hasAudio: true,
          videoCodec: "h264",
          audioCodec: "aac",
        },
        transcriptSegments: speechResult.segments,
        audioTimeline: audioResult.timeline,
        motionTimeline: [],
        sceneEvents: combinedSceneEvents,
        faceCam: { detected: false, region: null, method: "live_pending" },
        config,
      });

      if (drafts.length === 0) {
        jobLog.info("No strong peak in current live window; waiting for next rolling cycle.");
        await updateProgress(
          100,
          "Live stream monitored. No peak threshold reached in this window; keeping watch...",
        );
        return true;
      }

      // --- STEP D: Selective Video Slicing & Vision AI ---
      // Download ONLY the 30-60s video chunk for the highest-scoring candidate moment!
      const topCandidate = drafts[0]!;
      const sliceDuration = Math.max(5, topCandidate.endSec - topCandidate.startSec);
      await updateProgress(
        85,
        `Step D: Selective Video Slicing — fetching ONLY ${Math.round(sliceDuration)}s high-res video from live manifest...`,
      );
      jobLog.info(
        `Step D: Slicing selective video chunk (${topCandidate.startSec}s–${topCandidate.endSec}s)...`,
      );

      const sliceFileName = `live_slice_${jobId}_${Math.floor(topCandidate.startSec)}_${Math.floor(topCandidate.endSec)}.mp4`;
      const localSlicePath = path.join(workDir, sliceFileName);

      await runExecFile(
        ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-ss",
          String(topCandidate.startSec),
          "-t",
          String(sliceDuration),
          "-i",
          manifestResult.videoManifestUrl,
          "-c",
          "copy",
          localSlicePath,
        ],
        { timeoutMs: 90_000 },
      );

      // Probe sliced media & run face-cam detection on the selective video slice
      const probe: MediaProbeResult = await probeMediaFile(localSlicePath);
      const faceCamResult = await this.faceCamProvider.detect({
        videoFilePath: localSlicePath,
        probe,
        workDir,
      });

      // Upload sliced source video to object storage so user can preview and render
      const storageKey = `uploads/${job.userId}/${job.id}/${sliceFileName}`;
      const stored = await this.storage.putFromFile(
        storageKey,
        localSlicePath,
        "video/mp4",
      );

      // Persist candidate clip, transcript segments, and scene events to PostgreSQL
      await prisma.$transaction(async (tx) => {
        await tx.transcriptSegment.deleteMany({ where: { jobId: job.id } });
        await tx.sceneEvent.deleteMany({ where: { jobId: job.id } });
        await tx.candidateClip.deleteMany({ where: { jobId: job.id } });

        if (speechResult.segments.length > 0) {
          await tx.transcriptSegment.createMany({
            data: speechResult.segments.map((seg) => ({
              jobId: job.id,
              segmentIndex: seg.index,
              startSec: seg.startSec,
              endSec: seg.endSec,
              text: seg.text,
              language: seg.language,
              confidence: seg.confidence,
              lowConfidence: seg.lowConfidence,
              needsReview: seg.needsReview,
              wordsJson: seg.words as unknown as Prisma.InputJsonValue,
            })),
          });
        }

        if (combinedSceneEvents.length > 0) {
          await tx.sceneEvent.createMany({
            data: combinedSceneEvents.map((ev) => ({
              jobId: job.id,
              timestampSec: ev.timestampSec,
              endSec: ev.endSec ?? null,
              type: ev.type,
              score: ev.score,
              metadataJson: (ev.metadata ?? null) as Prisma.InputJsonValue,
            })),
          });
        }

        // Adjust top candidate bounds relative to the sliced video (0..sliceDuration)
        await tx.candidateClip.create({
          data: {
            jobId: job.id,
            rank: 1,
            title: topCandidate.title,
            startSec: 0,
            endSec: Math.round(sliceDuration * 100) / 100,
            originalStartSec: topCandidate.startSec,
            originalEndSec: topCandidate.endSec,
            score: topCandidate.score,
            confidence: topCandidate.confidence,
            signalBreakdown: topCandidate.signalBreakdown as unknown as Prisma.InputJsonValue,
            reason: `${topCandidate.reason} (Sliced live using audio-first + chat spike detection)`,
            transcriptExcerpt: topCandidate.transcriptExcerpt,
            status: "selected",
            layoutMode: faceCamResult.detected ? "split_cam_top" : "gameplay_focus",
            faceCamCropJson: faceCamResult.region
              ? (faceCamResult.region as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            captionLanguage: "en",
            captionStyle: "bold_gaming",
            captionsEnabled: true,
            captionsJson: topCandidate.captions as unknown as Prisma.InputJsonValue,
            hasUnreviewedCaptions: topCandidate.hasUnreviewedCaptions,
          },
        });

        await tx.clipJob.update({
          where: { id: job.id },
          data: {
            status: "candidates_ready",
            sourceStorageKey: storageKey,
            sourceFileName: sliceFileName,
            sourceMimeType: "video/mp4",
            sourceFileSizeBytes: BigInt(stored.sizeBytes),
            mediaDurationSec: probe.durationSec,
            mediaWidth: probe.width,
            mediaHeight: probe.height,
            mediaFps: probe.fps,
            mediaHasAudio: probe.hasAudio,
            faceCamDetected: faceCamResult.detected,
            faceCamRegionJson: faceCamResult.region
              ? (faceCamResult.region as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            speechProviderUsed: speechResult.providerName,
            analysisSummary: `Live Stream Moment Captured: ${Math.round(sliceDuration)}s high-res slice extracted via Live HLS + Audio-first + Chat velocity spike analysis.`,
            progressPct: 100,
            progressMessage: "Live stream moment captured! Ready to preview, edit & export.",
            workerLockedAt: null,
            workerId: null,
          },
        });
      });

      jobLog.info("Live stream processing complete: candidate moment ready!", {
        sliceDuration,
        faceCam: faceCamResult.detected,
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jobLog.error("Live stream processing failed", { error });

      await prisma.clipJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          failedFromStatus: "live_monitoring",
          errorCode: "LIVE_INGEST_FAILED",
          errorMessage: message.slice(0, 500),
          progressMessage: "Live stream ingestion failed. Retry or upload authorized file.",
          workerLockedAt: null,
          workerId: null,
        },
      });

      return false;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
