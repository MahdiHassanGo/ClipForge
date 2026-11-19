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
import { FfmpegSceneDetectionProvider } from "./scene-provider.js";
import { FfmpegFaceCamDetectionProvider } from "./facecam-provider.js";
import { probeMediaFile } from "./media-probe.js";

const logger = createLogger("clipforge-live-processor");

export class LiveStreamProcessor {
  private readonly repoRoot: string;
  private readonly tempRoot: string;
  private readonly storage: ObjectStorageProvider;
  private readonly audioProvider = new FfmpegAudioAnalysisProvider();
  private readonly sceneProvider = new FfmpegSceneDetectionProvider();
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

      // Sample a 180-second (3-minute) rolling live window
      const sampleWindowSec = 180;
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

      // --- Score Multi-Signal Candidate Moments on Audio & Chat ---
      const defaultCfg = getDefaultAnalysisConfig();
      const config: AnalysisConfig = {
        ...defaultCfg,
        minClipSec: Math.min(defaultCfg.minClipSec, 15),
        maxClipSec: Math.min(defaultCfg.maxClipSec, 45),
        targetClipSec: 30,
        scoreThreshold: 0.22,
        maxCandidates: 6,
      };

      const preDrafts = this.scoringProvider.generateCandidates({
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

      if (preDrafts.length === 0) {
        jobLog.info("No strong peak in current live window; waiting for next rolling cycle.");
        await updateProgress(
          100,
          "Live stream monitored. No peak threshold reached in this window; keeping watch...",
        );
        return true;
      }

      // --- STEP D: Selective Video Slicing & Vision AI ---
      // Determine the bounding window that encapsulates the top moments (e.g. 60–100s long)
      const topMoments = preDrafts.slice(0, 4);
      let windowStartSec = Math.max(0, Math.floor(Math.min(...topMoments.map((d) => d.startSec)) - 5));
      let windowEndSec = Math.min(sampleWindowSec, Math.ceil(Math.max(...topMoments.map((d) => d.endSec)) + 5));

      // Ensure slice window is at least 45 seconds and at most 120 seconds
      if (windowEndSec - windowStartSec < 45) {
        const pad = Math.ceil((45 - (windowEndSec - windowStartSec)) / 2);
        windowStartSec = Math.max(0, windowStartSec - pad);
        windowEndSec = Math.min(sampleWindowSec, windowEndSec + pad);
      }
      if (windowEndSec - windowStartSec > 120) {
        windowEndSec = windowStartSec + 120;
      }
      const sliceDuration = windowEndSec - windowStartSec;

      await updateProgress(
        78,
        `Step D: Selective Video Slicing — fetching ${Math.round(sliceDuration)}s high-res stream with synchronized audio...`,
      );
      jobLog.info(
        `Step D: Slicing selective high-res video and audio (${windowStartSec}s–${windowEndSec}s)...`,
      );

      const sliceFileName = `live_slice_${jobId}_${windowStartSec}_${windowEndSec}.mp4`;
      const localSlicePath = path.join(workDir, sliceFileName);

      // Download BOTH video and audio together so the sliced MP4 has full game audio and streamer voice
      const sliceArgs: string[] = [
        "-y",
        "-v",
        "error",
        "-ss",
        String(windowStartSec),
        "-t",
        String(sliceDuration),
        "-i",
        manifestResult.videoManifestUrl,
      ];

      if (
        manifestResult.audioManifestUrl &&
        manifestResult.audioManifestUrl !== manifestResult.videoManifestUrl
      ) {
        sliceArgs.push(
          "-ss",
          String(windowStartSec),
          "-t",
          String(sliceDuration),
          "-i",
          manifestResult.audioManifestUrl,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0?",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
        );
      } else {
        sliceArgs.push("-c", "copy");
      }

      sliceArgs.push(localSlicePath);
      await runExecFile(ffmpeg, sliceArgs, { timeoutMs: 120_000 });

      // Probe sliced media to get accurate duration, width, height, fps, and audio channels
      const probe: MediaProbeResult = await probeMediaFile(localSlicePath);

      // Run gameplay motion and scene cut detection on the selective video slice
      await updateProgress(85, "Analyzing gameplay motion & scene transitions in captured stream...");
      const sceneResult = await this.sceneProvider.detect({
        videoFilePath: localSlicePath,
        durationSec: probe.durationSec,
      });

      // Run face-cam detection on the selective video slice
      await updateProgress(90, "Detecting face-cam positioning and framing in captured slice...");
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

      // Map segments, audio timeline, and scene events to the sliced video's timeline [0..probe.durationSec]
      const sliceSegments = speechResult.segments
        .filter((seg) => seg.endSec > windowStartSec && seg.startSec < windowEndSec)
        .map((seg, idx) => ({
          ...seg,
          index: idx,
          startSec: Math.max(0, Math.round((seg.startSec - windowStartSec) * 100) / 100),
          endSec: Math.min(probe.durationSec, Math.round((seg.endSec - windowStartSec) * 100) / 100),
          words: seg.words
            .filter((w) => w.endSec > windowStartSec && w.startSec < windowEndSec)
            .map((w) => ({
              ...w,
              startSec: Math.max(0, Math.round((w.startSec - windowStartSec) * 100) / 100),
              endSec: Math.min(probe.durationSec, Math.round((w.endSec - windowStartSec) * 100) / 100),
            })),
        }))
        .filter((seg) => seg.endSec > seg.startSec);

      const sliceAudioTimeline = audioResult.timeline
        .filter((pt) => pt.second >= windowStartSec && pt.second < windowEndSec)
        .map((pt) => ({
          ...pt,
          second: pt.second - windowStartSec,
        }));

      const sliceChatEvents = combinedSceneEvents
        .filter((ev) => ev.timestampSec >= windowStartSec && ev.timestampSec <= windowEndSec)
        .map((ev) => ({
          ...ev,
          timestampSec: Math.max(0, ev.timestampSec - windowStartSec),
          endSec: ev.endSec != null ? Math.min(probe.durationSec, ev.endSec - windowStartSec) : undefined,
        }));

      const allSliceEvents = [...sliceChatEvents, ...sceneResult.events].sort(
        (a, b) => a.timestampSec - b.timestampSec,
      );

      // Generate final multimodal candidate moments with full visual, audio, speech, and motion data
      await updateProgress(95, "Generating candidate vertical highlights with multimodal scoring...");
      const finalDrafts = this.scoringProvider.generateCandidates({
        probe,
        transcriptSegments: sliceSegments,
        audioTimeline: sliceAudioTimeline,
        motionTimeline: sceneResult.timeline,
        sceneEvents: allSliceEvents,
        faceCam: faceCamResult,
        config: {
          ...config,
          maxCandidates: 6,
        },
      });

      const candidateList =
        finalDrafts.length > 0
          ? finalDrafts
          : preDrafts.slice(0, 3).map((d, i) => ({
              ...d,
              rank: i + 1,
              startSec: Math.max(0, d.startSec - windowStartSec),
              endSec: Math.min(probe.durationSec, d.endSec - windowStartSec),
            }));

      // Persist candidate clips, transcript segments, and scene events to PostgreSQL
      await prisma.$transaction(async (tx) => {
        await tx.transcriptSegment.deleteMany({ where: { jobId: job.id } });
        await tx.sceneEvent.deleteMany({ where: { jobId: job.id } });
        await tx.candidateClip.deleteMany({ where: { jobId: job.id } });

        if (sliceSegments.length > 0) {
          await tx.transcriptSegment.createMany({
            data: sliceSegments.map((seg) => ({
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

        if (allSliceEvents.length > 0) {
          await tx.sceneEvent.createMany({
            data: allSliceEvents.map((ev) => ({
              jobId: job.id,
              timestampSec: ev.timestampSec,
              endSec: ev.endSec ?? null,
              type: ev.type,
              score: ev.score,
              metadataJson: (ev.metadata ?? null) as Prisma.InputJsonValue,
            })),
          });
        }

        for (const draft of candidateList) {
          await tx.candidateClip.create({
            data: {
              jobId: job.id,
              rank: draft.rank,
              title: draft.title,
              startSec: draft.startSec,
              endSec: draft.endSec,
              originalStartSec: draft.startSec + windowStartSec,
              originalEndSec: draft.endSec + windowStartSec,
              score: draft.score,
              confidence: draft.confidence,
              signalBreakdown: draft.signalBreakdown as unknown as Prisma.InputJsonValue,
              reason: `${draft.reason} (Captured live via Audio-First + Chat Velocity + Motion analysis)`,
              transcriptExcerpt: draft.transcriptExcerpt,
              status: draft.rank <= 2 ? "selected" : "suggested",
              layoutMode: faceCamResult.detected ? "split_cam_top" : "gameplay_focus",
              faceCamCropJson: faceCamResult.region
                ? (faceCamResult.region as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
              captionLanguage: "en",
              captionStyle: "bold_gaming",
              captionsEnabled: true,
              captionsJson: draft.captions as unknown as Prisma.InputJsonValue,
              hasUnreviewedCaptions: draft.hasUnreviewedCaptions,
            },
          });
        }

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
            analysisSummary: `Live Stream Captured: ${Math.round(probe.durationSec)}s (${probe.width}×${probe.height}) with ${candidateList.length} candidate moments identified · Synced audio & gameplay motion.`,
            progressPct: 100,
            progressMessage: `Live stream captured! ${candidateList.length} highlight moments ready to preview, edit & export with full audio.`,
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
