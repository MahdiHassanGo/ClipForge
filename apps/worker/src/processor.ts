import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { prisma, Prisma } from "@clipforge/db";
import {
  DefaultClipScoringProvider,
  analysisConfigSchema,
  createLogger,
  createObjectStorageFromEnv,
  getDefaultAnalysisConfig,
  type AnalysisConfig,
  type CaptionCue,
  type FaceCamRegion,
  type ObjectStorageProvider,
} from "@clipforge/core";
import { probeMediaFile } from "./media-probe.js";
import { FfmpegAudioAnalysisProvider } from "./audio-provider.js";
import { createSpeechRecognitionProvider } from "./speech-provider.js";
import { FfmpegSceneDetectionProvider } from "./scene-provider.js";
import { FfmpegFaceCamDetectionProvider } from "./facecam-provider.js";
import { FfmpegVideoRendererProvider } from "./renderer-provider.js";
import { LiveStreamProcessor } from "./live-stream-processor.js";
import { scrapeMediaFromUrl } from "./media-scraper.js";

const logger = createLogger("clipforge-worker");

export class ClipWorkerProcessor {
  private readonly workerId: string;
  private readonly repoRoot: string;
  private readonly storage: ObjectStorageProvider;
  private readonly tempRoot: string;
  private readonly staleLockMs: number;

  private readonly audioProvider = new FfmpegAudioAnalysisProvider();
  private readonly sceneProvider = new FfmpegSceneDetectionProvider();
  private readonly faceCamProvider = new FfmpegFaceCamDetectionProvider();
  private readonly scoringProvider = new DefaultClipScoringProvider();
  private readonly rendererProvider = new FfmpegVideoRendererProvider();
  private readonly liveStreamProcessor: LiveStreamProcessor;

  constructor(options: { repoRoot: string }) {
    this.repoRoot = options.repoRoot;
    this.workerId = `worker-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    this.storage = createObjectStorageFromEnv(process.env, options.repoRoot);
    const configuredTmp = process.env.TEMP_WORK_DIR ?? "./tmp/clipforge-worker";
    this.tempRoot = path.isAbsolute(configuredTmp)
      ? configuredTmp
      : path.resolve(options.repoRoot, configuredTmp);
    this.staleLockMs = Number(process.env.WORKER_STALE_LOCK_MS) || 600_000;
    this.liveStreamProcessor = new LiveStreamProcessor({
      repoRoot: options.repoRoot,
      tempRoot: this.tempRoot,
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.tempRoot, { recursive: true });
    const speechProvider = createSpeechRecognitionProvider(process.env, this.repoRoot);
    logger.info("Worker initialized", {
      workerId: this.workerId,
      storageProvider: this.storage.providerName,
      tempRoot: this.tempRoot,
      speechProvider: speechProvider.name,
    });
  }

  /**
   * Claims and processes one pending analysis job if available. Returns true if work was done.
   */
  async processNextAnalysisJob(): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - this.staleLockMs);

    const candidate = await prisma.clipJob.findFirst({
      where: {
        status: "analyzing",
        AND: [
          {
            OR: [
              { sourceStorageKey: { not: null } },
              { sourceProvider: "direct_scrape" },
              { youtubeUrl: { not: "" } },
            ],
          },
          {
            OR: [{ workerLockedAt: null }, { workerLockedAt: { lt: staleThreshold } }],
          },
        ],
      },
      orderBy: { updatedAt: "asc" },
    });

    if (!candidate) return false;

    // Atomic conditional lease acquisition prevents duplicate concurrent processing
    const claimed = await prisma.clipJob.updateMany({
      where: {
        id: candidate.id,
        status: "analyzing",
        OR: [{ workerLockedAt: null }, { workerLockedAt: { lt: staleThreshold } }],
      },
      data: {
        workerLockedAt: new Date(),
        workerId: this.workerId,
      },
    });

    if (claimed.count === 0) return false;

    const jobLog = logger.child({ jobId: candidate.id, workerId: this.workerId });
    const workDir = path.join(this.tempRoot, `analyze_${candidate.id}_${Date.now()}`);

    try {
      await fs.mkdir(workDir, { recursive: true });
      jobLog.info("Starting media analysis job", {
        sourceStorageKey: candidate.sourceStorageKey,
        sourceProvider: candidate.sourceProvider,
        youtubeUrl: candidate.youtubeUrl,
      });

      const updateProgress = async (pct: number, message: string) => {
        await prisma.clipJob.updateMany({
          where: { id: candidate.id, status: "analyzing" },
          data: {
            progressPct: pct,
            progressMessage: message,
            workerLockedAt: new Date(),
          },
        });
      };

      let localVideoPath: string;

      if (!candidate.sourceStorageKey) {
        await updateProgress(5, "Scraping media directly from link (yt-dlp)...");
        jobLog.info("Direct media scraping from URL", { url: candidate.youtubeUrl });

        localVideoPath = await scrapeMediaFromUrl({
          url: candidate.youtubeUrl,
          workDir,
          jobId: candidate.id,
          userId: candidate.userId,
          onProgress: (msg) => {
            void updateProgress(12, msg);
          },
        });

        const stat = await fs.stat(localVideoPath);
        const fileName = path.basename(localVideoPath);
        const storageKey = `uploads/${candidate.userId}/${candidate.id}/${fileName}`;

        await updateProgress(16, "Syncing media to storage for studio playback...");
        await this.storage.putFromFile(storageKey, localVideoPath, "video/mp4");

        await prisma.clipJob.update({
          where: { id: candidate.id },
          data: {
            sourceStorageKey: storageKey,
            sourceFileName: fileName,
            sourceMimeType: "video/mp4",
            sourceFileSizeBytes: BigInt(stat.size),
            sourceProvider: "direct_scrape",
          },
        });
      } else {
        await updateProgress(8, "Loading source video into isolated worker...");
        const ext = path.extname(candidate.sourceFileName ?? ".mp4") || ".mp4";
        localVideoPath = path.join(workDir, `source${ext}`);
        await this.storage.downloadToFile(candidate.sourceStorageKey, localVideoPath);
      }

      await updateProgress(18, "Probing video & audio streams...");
      const probe = await probeMediaFile(localVideoPath);

      await prisma.clipJob.update({
        where: { id: candidate.id },
        data: {
          mediaDurationSec: probe.durationSec,
          mediaWidth: probe.width,
          mediaHeight: probe.height,
          mediaFps: probe.fps,
          mediaHasAudio: probe.hasAudio,
        },
      });

      const defaultCfg = getDefaultAnalysisConfig();
      const parsedCfg = analysisConfigSchema.safeParse(candidate.analysisConfigJson);
      const config: AnalysisConfig = parsedCfg.success ? parsedCfg.data : defaultCfg;

      await updateProgress(32, "Analyzing audio dynamics & reaction cues...");
      const audioResult = await this.audioProvider.analyze({
        videoFilePath: localVideoPath,
        durationSec: probe.durationSec,
        hasAudio: probe.hasAudio,
      });

      await updateProgress(52, "Transcribing speech with word-level timestamps...");
      const speechProvider = createSpeechRecognitionProvider(process.env, this.repoRoot);
      const speechResult = await speechProvider.transcribe({
        audioFilePath: localVideoPath,
        durationSec: probe.durationSec,
        languageHint: config.captionLanguage,
        audioTimeline: audioResult.timeline,
      });

      await updateProgress(70, "Detecting scene transitions & gameplay motion...");
      const sceneResult = await this.sceneProvider.detect({
        videoFilePath: localVideoPath,
        durationSec: probe.durationSec,
      });

      await updateProgress(82, "Checking for face-cam presence & location...");
      const faceCamResult = await this.faceCamProvider.detect({
        videoFilePath: localVideoPath,
        probe,
        workDir,
      });

      await updateProgress(90, "Scoring synchronized highlights & context boundaries...");
      const allSceneEvents = [...audioResult.events, ...sceneResult.events].sort(
        (a, b) => a.timestampSec - b.timestampSec,
      );

      const drafts = this.scoringProvider.generateCandidates({
        probe,
        transcriptSegments: speechResult.segments,
        audioTimeline: audioResult.timeline,
        motionTimeline: sceneResult.timeline,
        sceneEvents: allSceneEvents,
        faceCam: faceCamResult,
        config,
      });

      // Verify job wasn't cancelled while running
      const freshJob = await prisma.clipJob.findUnique({
        where: { id: candidate.id },
        select: { status: true },
      });
      if (!freshJob || freshJob.status === "cancelled") {
        jobLog.info("Job was cancelled during analysis; discarding results.");
        return true;
      }

      const summaryParts = [
        `Analyzed ${Math.round(probe.durationSec)}s (${probe.width}×${probe.height} @ ${probe.fps}fps)`,
        `${drafts.length} candidate clip${drafts.length === 1 ? "" : "s"} identified`,
        faceCamResult.detected
          ? `face-cam detected (${faceCamResult.region?.corner.replace("_", " ")})`
          : "no face-cam auto-detected (manual overlay optional)",
      ];
      if (speechResult.notice) {
        summaryParts.push(speechResult.notice);
      }

      // Idempotent persistence: atomically replace previous analysis rows & transition to candidates_ready
      await prisma.$transaction(async (tx) => {
        await tx.transcriptSegment.deleteMany({ where: { jobId: candidate.id } });
        await tx.sceneEvent.deleteMany({ where: { jobId: candidate.id } });
        await tx.candidateClip.deleteMany({ where: { jobId: candidate.id } });

        if (speechResult.segments.length > 0) {
          await tx.transcriptSegment.createMany({
            data: speechResult.segments.map((seg) => ({
              jobId: candidate.id,
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

        if (allSceneEvents.length > 0) {
          await tx.sceneEvent.createMany({
            data: allSceneEvents.map((ev) => ({
              jobId: candidate.id,
              timestampSec: ev.timestampSec,
              endSec: ev.endSec ?? null,
              type: ev.type,
              score: ev.score,
              metadataJson: (ev.metadata ?? null) as Prisma.InputJsonValue,
            })),
          });
        }

        for (const draft of drafts) {
          await tx.candidateClip.create({
            data: {
              jobId: candidate.id,
              rank: draft.rank,
              title: draft.title,
              startSec: draft.startSec,
              endSec: draft.endSec,
              originalStartSec: draft.startSec,
              originalEndSec: draft.endSec,
              score: draft.score,
              confidence: draft.confidence,
              signalBreakdown: draft.signalBreakdown as unknown as Prisma.InputJsonValue,
              reason: draft.reason,
              transcriptExcerpt: draft.transcriptExcerpt,
              status: draft.rank <= 3 ? "selected" : "suggested",
              layoutMode: draft.layoutMode,
              faceCamCropJson: draft.faceCamCrop
                ? (draft.faceCamCrop as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
              captionLanguage: draft.captionLanguage,
              captionStyle: draft.captionStyle,
              captionsEnabled: true,
              captionsJson: draft.captions as unknown as Prisma.InputJsonValue,
              hasUnreviewedCaptions: draft.hasUnreviewedCaptions,
            },
          });
        }

        await tx.clipJob.update({
          where: { id: candidate.id },
          data: {
            status: "candidates_ready",
            progressPct: 100,
            progressMessage: `Ready for review — ${drafts.length} clip candidate${drafts.length === 1 ? "" : "s"} found.`,
            faceCamDetected: faceCamResult.detected,
            faceCamRegionJson: faceCamResult.region
              ? (faceCamResult.region as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            speechProviderUsed: speechResult.providerName,
            analysisSummary: summaryParts.join(" · "),
            errorCode: null,
            errorMessage: null,
            failedFromStatus: null,
            workerLockedAt: null,
            workerId: null,
          },
        });
      });

      jobLog.info("Analysis job completed", {
        candidatesCount: drafts.length,
        speechProvider: speechResult.providerName,
        faceCamDetected: faceCamResult.detected,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown media analysis error.";
      jobLog.error("Analysis job failed", { error });
      await prisma.clipJob.update({
        where: { id: candidate.id },
        data: {
          status: "failed",
          failedFromStatus: "analyzing",
          errorCode: "ANALYSIS_FAILED",
          errorMessage: message.slice(0, 600),
          progressMessage: "Analysis failed — see error details and retry.",
          workerLockedAt: null,
          workerId: null,
        },
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    return true;
  }

  /**
   * Claims and processes one pending live stream monitoring job if available.
   * Extracts rolling live HLS manifest, pulls audio-first, monitors chat velocity spikes,
   * and selectively slices peak video windows without downloading the full multi-GB live stream.
   */
  async processNextLiveStreamJob(): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - this.staleLockMs);

    const candidate = await prisma.clipJob.findFirst({
      where: {
        status: "live_monitoring",
        OR: [{ workerLockedAt: null }, { workerLockedAt: { lt: staleThreshold } }],
      },
      orderBy: { updatedAt: "asc" },
    });

    if (!candidate) return false;

    // Atomic conditional lease acquisition
    const claimed = await prisma.clipJob.updateMany({
      where: {
        id: candidate.id,
        status: "live_monitoring",
        OR: [{ workerLockedAt: null }, { workerLockedAt: { lt: staleThreshold } }],
      },
      data: {
        workerLockedAt: new Date(),
        workerId: this.workerId,
      },
    });

    if (claimed.count === 0) return false;

    return this.liveStreamProcessor.processLiveStreamJob(candidate.id, this.workerId);
  }

  /**
   * Claims and processes one queued vertical MP4 render export. Returns true if work was done.
   */
  async processNextRenderExport(): Promise<boolean> {
    const staleThreshold = new Date(Date.now() - this.staleLockMs);

    const pending = await prisma.renderExport.findFirst({
      where: {
        OR: [
          { status: "queued" },
          { status: "rendering", workerLockedAt: { lt: staleThreshold } },
        ],
      },
      include: {
        job: true,
        clip: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!pending) return false;

    const claimed = await prisma.renderExport.updateMany({
      where: {
        id: pending.id,
        OR: [
          { status: "queued" },
          { status: "rendering", workerLockedAt: { lt: staleThreshold } },
        ],
      },
      data: {
        status: "rendering",
        workerLockedAt: new Date(),
        workerId: this.workerId,
        progressPct: 5,
        progressMessage: "Preparing source clip for 9:16 render...",
      },
    });

    if (claimed.count === 0) return false;

    const renderLog = logger.child({
      renderId: pending.id,
      jobId: pending.jobId,
      clipId: pending.clipId,
      preset: pending.preset,
    });
    const workDir = path.join(this.tempRoot, `render_${pending.id}_${Date.now()}`);

    try {
      await fs.mkdir(workDir, { recursive: true });
      if (!pending.job.sourceStorageKey) {
        throw new Error("Source video file is missing from object storage.");
      }

      const ext = path.extname(pending.job.sourceFileName ?? ".mp4") || ".mp4";
      const localSource = path.join(workDir, `source${ext}`);
      await this.storage.downloadToFile(pending.job.sourceStorageKey, localSource);

      const probe =
        pending.job.mediaDurationSec &&
        pending.job.mediaWidth &&
        pending.job.mediaHeight
          ? {
              durationSec: pending.job.mediaDurationSec,
              width: pending.job.mediaWidth,
              height: pending.job.mediaHeight,
              fps: pending.job.mediaFps ?? 30,
              hasAudio: pending.job.mediaHasAudio ?? true,
              videoCodec: null,
              audioCodec: null,
            }
          : await probeMediaFile(localSource);

      const safeTitle = pending.clip.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
      const outputFileName = `${safeTitle || "clip"}-${pending.preset}.mp4`;
      const localOutput = path.join(workDir, outputFileName);

      const captions = Array.isArray(pending.captionsJson)
        ? (pending.captionsJson as unknown as CaptionCue[])
        : [];
      const faceCamCrop =
        pending.faceCamCropJson && typeof pending.faceCamCropJson === "object"
          ? (pending.faceCamCropJson as unknown as FaceCamRegion)
          : null;

      let lastDbUpdate = 0;
      const result = await this.rendererProvider.renderVerticalClip({
        sourceVideoPath: localSource,
        outputVideoPath: localOutput,
        workDir,
        probe,
        startSec: pending.startSec,
        endSec: pending.endSec,
        preset: pending.preset,
        layoutMode: pending.layoutMode,
        faceCamCrop,
        captionsEnabled: pending.captionsEnabled,
        captionStyle: pending.captionStyle,
        captionLanguage: pending.captionLanguage,
        captions,
        onProgress: (pct, message) => {
          const now = Date.now();
          if (now - lastDbUpdate > 1200 || pct === 100) {
            lastDbUpdate = now;
            void prisma.renderExport
              .updateMany({
                where: { id: pending.id, status: "rendering" },
                data: {
                  progressPct: pct,
                  progressMessage: message,
                  workerLockedAt: new Date(),
                },
              })
              .catch(() => {});
          }
        },
      });

      const storageKey = `exports/${pending.userId}/${pending.jobId}/${pending.id}.mp4`;
      await this.storage.putFromFile(storageKey, result.outputVideoPath, "video/mp4");

      // Save a direct, easily-accessible copy in the dedicated clips directory
      const storageBase = process.env.LOCAL_STORAGE_DIR ?? "./storage";
      const resolvedStorageBase = path.isAbsolute(storageBase)
        ? storageBase
        : path.resolve(this.repoRoot, storageBase);
      const userClipsDir = path.join(resolvedStorageBase, "clips", safeTitle || pending.jobId);
      await fs.mkdir(userClipsDir, { recursive: true });
      const exportedClipPath = path.join(userClipsDir, outputFileName);
      await fs.copyFile(result.outputVideoPath, exportedClipPath);

      renderLog.info("Clip saved to user directory", { exportedClipPath });

      await prisma.renderExport.update({
        where: { id: pending.id },
        data: {
          status: "complete",
          progressPct: 100,
          progressMessage: `Saved to ${exportedClipPath}`,
          outputStorageKey: storageKey,
          outputFileName,
          outputFileSizeBytes: BigInt(result.fileSizeBytes),
          outputDurationSec: result.durationSec,
          width: result.width,
          height: result.height,
          errorCode: null,
          errorMessage: null,
          workerLockedAt: null,
          workerId: null,
          completedAt: new Date(),
        },
      });

      await this.syncParentJobRenderState(pending.jobId);
      renderLog.info("Render export completed", {
        storageKey,
        fileSizeBytes: result.fileSizeBytes,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown FFmpeg rendering error.";
      renderLog.error("Render export failed", { error });

      await prisma.renderExport.update({
        where: { id: pending.id },
        data: {
          status: "failed",
          errorCode: "RENDER_FAILED",
          errorMessage: message.slice(0, 600),
          progressMessage: "Render failed — retry when ready.",
          workerLockedAt: null,
          workerId: null,
        },
      });

      await this.syncParentJobRenderState(pending.jobId);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    return true;
  }

  private async syncParentJobRenderState(jobId: string): Promise<void> {
    const exports = await prisma.renderExport.findMany({
      where: { jobId },
      select: { status: true },
    });
    if (exports.length === 0) return;

    const active = exports.some((e) => e.status === "queued" || e.status === "rendering");
    const completed = exports.filter((e) => e.status === "complete").length;
    const failed = exports.filter((e) => e.status === "failed").length;

    if (active) {
      await prisma.clipJob.updateMany({
        where: { id: jobId, status: { in: ["candidates_ready", "rendering", "complete"] } },
        data: {
          status: "rendering",
          progressMessage: `Rendering exports (${completed}/${exports.length} complete)...`,
        },
      });
      return;
    }

    if (completed > 0) {
      await prisma.clipJob.updateMany({
        where: { id: jobId, status: { in: ["rendering", "candidates_ready"] } },
        data: {
          status: "complete",
          progressPct: 100,
          progressMessage:
            failed > 0
              ? `${completed} export(s) ready, ${failed} failed (retryable).`
              : `All ${completed} export(s) ready to download.`,
          completedAt: new Date(),
        },
      });
    } else if (failed > 0) {
      await prisma.clipJob.updateMany({
        where: { id: jobId, status: "rendering" },
        data: {
          status: "failed",
          failedFromStatus: "rendering",
          errorCode: "RENDER_BATCH_FAILED",
          errorMessage: "One or more clip renders failed. Check individual exports to retry.",
        },
      });
    }
  }

  /**
   * Retention cleanup for stale temp directories left by crashes.
   */
  async cleanupStaleTempDirs(): Promise<void> {
    const retentionHours = Number(process.env.RETENTION_HOURS) || 72;
    const cutoffMs = Date.now() - retentionHours * 3600 * 1000;

    try {
      const entries = await fs.readdir(this.tempRoot, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(this.tempRoot, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat && stat.mtimeMs < cutoffMs) {
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch {
      // ignore if temp root does not exist yet
    }
  }
}
