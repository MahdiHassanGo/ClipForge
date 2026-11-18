import fs from "node:fs/promises";
import path from "node:path";
import type {
  AudioTimelinePoint,
  SpeechRecognitionProvider,
  SpeechRecognitionResult,
  TranscriptSegmentData,
  TranscriptWord,
} from "@clipforge/core";
import { resolveFfmpegPath, runExecFile } from "./ffmpeg-binaries.js";

interface WhisperVerboseResponse {
  language?: string;
  text?: string;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

interface WhisperCppJsonFull {
  result?: {
    language?: string;
  };
  transcription?: Array<{
    offsets?: { from: number; to: number };
    text?: string;
    tokens?: Array<{
      text?: string;
      offsets?: { from: number; to: number };
      p?: number;
    }>;
  }>;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reusable Whisper API provider for any OpenAI-compatible audio transcription endpoint:
 * - Groq Free Tier (https://api.groq.com/openai/v1/audio/transcriptions, whisper-large-v3-turbo)
 * - Self-hosted Whisper API (STT_BASE_URL)
 * - OpenAI Whisper API (optional)
 */
export class OpenAICompatibleWhisperProvider implements SpeechRecognitionProvider {
  readonly name: string;
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: {
    name: string;
    endpointUrl: string;
    apiKey: string;
    model: string;
  }) {
    this.name = config.name;
    this.endpointUrl = config.endpointUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async transcribe(params: {
    audioFilePath: string;
    durationSec: number;
    languageHint: string;
    audioTimeline: AudioTimelinePoint[];
  }): Promise<SpeechRecognitionResult> {
    // Chunk into 12-minute mono 48k MP3 (~4.3MB each) to stay well under 25MB API limits
    const chunkSeconds = 720;
    const dir = path.dirname(params.audioFilePath);
    const totalChunks = Math.max(1, Math.ceil(params.durationSec / chunkSeconds));

    const allSegments: TranscriptSegmentData[] = [];
    let detectedLanguage = params.languageHint === "auto" ? "en" : params.languageHint;
    let runningIndex = 0;

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const offsetSec = chunkIdx * chunkSeconds;
      const chunkPath = path.join(dir, `speech_chunk_${chunkIdx}.mp3`);

      await runExecFile(
        resolveFfmpegPath(),
        [
          "-y",
          "-v",
          "error",
          "-ss",
          String(offsetSec),
          "-t",
          String(chunkSeconds),
          "-i",
          params.audioFilePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "48k",
          chunkPath,
        ],
        { timeoutMs: 120_000 },
      );

      const audioBytes = await fs.readFile(chunkPath);
      await fs.rm(chunkPath, { force: true });

      const form = new FormData();
      form.append(
        "file",
        new Blob([audioBytes], { type: "audio/mpeg" }),
        `chunk_${chunkIdx}.mp3`,
      );
      form.append("model", this.model);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (params.languageHint && params.languageHint !== "auto") {
        form.append("language", params.languageHint);
      }

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.endpointUrl, {
        method: "POST",
        headers,
        body: form,
        signal: AbortSignal.timeout(180_000),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(
          `Transcription provider '${this.name}' failed (${response.status}): ${errBody.slice(0, 300)}`,
        );
      }

      const data = (await response.json()) as WhisperVerboseResponse;
      if (data.language) {
        detectedLanguage = data.language;
      }

      const rawWords = data.words ?? [];
      const rawSegments = data.segments ?? [];

      for (const seg of rawSegments) {
        const text = seg.text.trim();
        if (!text) continue;

        const segStart = round2(seg.start + offsetSec);
        const segEnd = round2(Math.max(seg.end + offsetSec, segStart + 0.1));

        const logprobConf =
          seg.avg_logprob !== undefined ? clamp01(Math.exp(seg.avg_logprob)) : 0.78;
        const speechProb =
          seg.no_speech_prob !== undefined ? clamp01(1 - seg.no_speech_prob) : 0.9;
        const confidence = round2(clamp01(logprobConf * 0.7 + speechProb * 0.3));
        const lowConfidence = confidence < 0.65 || (seg.no_speech_prob ?? 0) > 0.5;

        const matchedWords: TranscriptWord[] = rawWords
          .filter((w) => w.start >= seg.start - 0.15 && w.end <= seg.end + 0.15)
          .map((w) => ({
            word: w.word.trim(),
            startSec: round2(w.start + offsetSec),
            endSec: round2(Math.max(w.end + offsetSec, w.start + offsetSec + 0.08)),
            confidence,
            lowConfidence,
          }))
          .filter((w) => w.word.length > 0);

        allSegments.push({
          index: runningIndex++,
          startSec: segStart,
          endSec: segEnd,
          text,
          language: detectedLanguage,
          confidence,
          lowConfidence,
          needsReview: lowConfidence,
          words: matchedWords,
        });
      }
    }

    return {
      providerName: this.name,
      language: detectedLanguage,
      segments: allSegments,
    };
  }
}

/**
 * 100% Free & Offline local Whisper provider using whisper.cpp (`whisper-cli`).
 * Install on macOS with: `brew install whisper-cpp` and download a ggml model (e.g. ggml-base.en.bin).
 */
export class LocalWhisperCppSpeechProvider implements SpeechRecognitionProvider {
  readonly name = "local_whisper_cpp";
  private readonly binaryPath: string;
  private readonly modelPath: string;

  constructor(config: { binaryPath?: string; modelPath: string }) {
    this.binaryPath = config.binaryPath?.trim() || "whisper-cli";
    this.modelPath = config.modelPath;
  }

  async transcribe(params: {
    audioFilePath: string;
    durationSec: number;
    languageHint: string;
    audioTimeline: AudioTimelinePoint[];
  }): Promise<SpeechRecognitionResult> {
    const dir = path.dirname(params.audioFilePath);
    const wavPath = path.join(dir, "whisper_input_16k.wav");
    const outputPrefix = path.join(dir, "whisper_out");
    const jsonPath = `${outputPrefix}.json`;

    await runExecFile(
      resolveFfmpegPath(),
      [
        "-y",
        "-v",
        "error",
        "-i",
        params.audioFilePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { timeoutMs: 180_000 },
    );

    const args = [
      "-m",
      this.modelPath,
      "-f",
      wavPath,
      "-ojf",
      "-of",
      outputPrefix,
      "--no-prints",
    ];
    if (params.languageHint && params.languageHint !== "auto") {
      args.push("-l", params.languageHint);
    }

    await runExecFile(this.binaryPath, args, { timeoutMs: 600_000 });

    const rawJson = await fs.readFile(jsonPath, "utf8");
    await fs.rm(wavPath, { force: true }).catch(() => {});
    await fs.rm(jsonPath, { force: true }).catch(() => {});

    const parsed = JSON.parse(rawJson) as WhisperCppJsonFull;
    const detectedLanguage =
      parsed.result?.language ||
      (params.languageHint === "auto" ? "en" : params.languageHint);

    const segments: TranscriptSegmentData[] = [];
    let segIndex = 0;

    for (const item of parsed.transcription ?? []) {
      const text = (item.text ?? "").trim();
      if (!text) continue;
      const startSec = round2((item.offsets?.from ?? 0) / 1000);
      const endSec = round2(Math.max((item.offsets?.to ?? 0) / 1000, startSec + 0.2));

      // Group subword tokens into clean words with real token probabilities
      const words: TranscriptWord[] = [];
      let probSum = 0;
      let probCount = 0;

      for (const tok of item.tokens ?? []) {
        const rawTok = tok.text ?? "";
        if (!rawTok || /^\[.*\]$/.test(rawTok.trim())) continue;
        const p = clamp01(tok.p ?? 0.8);
        probSum += p;
        probCount++;

        const tokStart = round2((tok.offsets?.from ?? startSec * 1000) / 1000);
        const tokEnd = round2(
          Math.max((tok.offsets?.to ?? endSec * 1000) / 1000, tokStart + 0.06),
        );

        if (rawTok.startsWith(" ") || words.length === 0) {
          const clean = rawTok.trim();
          if (clean) {
            words.push({
              word: clean,
              startSec: tokStart,
              endSec: tokEnd,
              confidence: round2(p),
              lowConfidence: p < 0.65,
            });
          }
        } else {
          // Append subword piece to previous word
          const prev = words[words.length - 1]!;
          prev.word += rawTok;
          prev.endSec = Math.max(prev.endSec, tokEnd);
          prev.confidence = round2((prev.confidence + p) / 2);
          prev.lowConfidence = prev.lowConfidence || p < 0.65;
        }
      }

      const confidence = round2(probCount > 0 ? probSum / probCount : 0.75);
      const lowConfidence = confidence < 0.65;

      segments.push({
        index: segIndex++,
        startSec,
        endSec,
        text,
        language: detectedLanguage,
        confidence,
        lowConfidence,
        needsReview: lowConfidence,
        words,
      });
    }

    return {
      providerName: this.name,
      language: detectedLanguage,
      segments,
    };
  }
}

/**
 * 100% Free zero-setup fallback when no transcription provider is configured.
 * Never fabricates spoken words: detects speech/audio activity spans from the
 * PCM energy timeline and flags them with lowConfidence=true, needsReview=true
 * so the user can type/edit captions manually or enable free Groq / local whisper.cpp.
 */
export class HonestFallbackSpeechProvider implements SpeechRecognitionProvider {
  readonly name = "audio_activity_fallback_no_asr";

  async transcribe(params: {
    audioFilePath: string;
    durationSec: number;
    languageHint: string;
    audioTimeline: AudioTimelinePoint[];
  }): Promise<SpeechRecognitionResult> {
    const activeSeconds = params.audioTimeline.filter(
      (pt) => pt.rmsDb > -42 && (pt.reactionScore >= 0.35 || pt.rmsDb > -28),
    );

    const segments: TranscriptSegmentData[] = [];
    let segIdx = 0;

    let spanStart: number | null = null;
    let spanEnd: number | null = null;

    const flushSpan = () => {
      if (spanStart === null || spanEnd === null) return;
      const startSec = round2(spanStart);
      const endSec = round2(Math.min(params.durationSec, spanEnd + 1));
      if (endSec - startSec >= 1.5) {
        segments.push({
          index: segIdx++,
          startSec,
          endSec,
          text: "[Speech activity detected — add free GROQ_API_KEY or local whisper.cpp for auto-captions, or edit caption]",
          language: params.languageHint === "auto" ? "en" : params.languageHint,
          confidence: 0.25,
          lowConfidence: true,
          needsReview: true,
          words: [],
        });
      }
      spanStart = null;
      spanEnd = null;
    };

    for (const pt of activeSeconds) {
      if (spanStart === null) {
        spanStart = pt.second;
        spanEnd = pt.second;
      } else if (pt.second <= (spanEnd ?? pt.second) + 1 && pt.second - spanStart < 6) {
        spanEnd = pt.second;
      } else {
        flushSpan();
        spanStart = pt.second;
        spanEnd = pt.second;
      }
    }
    flushSpan();

    return {
      providerName: this.name,
      language: params.languageHint === "auto" ? "en" : params.languageHint,
      segments,
      notice:
        "No speech-to-text provider configured. Audio dynamics, scene changes, gameplay motion, and face-cam analysis completed; automatic transcription was skipped rather than inventing words. Add a free GROQ_API_KEY (recommended) or local whisper.cpp model in .env, or edit captions manually.",
    };
  }
}

export function createSpeechRecognitionProvider(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = process.cwd(),
): SpeechRecognitionProvider {
  const mode = (env.STT_PROVIDER ?? "auto").toLowerCase().trim();
  const groqKey = env.GROQ_API_KEY?.trim();
  const rawLocalModel = env.LOCAL_WHISPER_MODEL_PATH?.trim();
  const localModel = rawLocalModel
    ? path.isAbsolute(rawLocalModel)
      ? rawLocalModel
      : path.resolve(baseDir, rawLocalModel)
    : undefined;
  const customBaseUrl = env.STT_BASE_URL?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();

  if (mode === "none") {
    return new HonestFallbackSpeechProvider();
  }

  if (mode === "groq" || (mode === "auto" && groqKey)) {
    if (groqKey) {
      return new OpenAICompatibleWhisperProvider({
        name: "groq_whisper_free",
        endpointUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
        apiKey: groqKey,
        model: env.GROQ_WHISPER_MODEL?.trim() || "whisper-large-v3-turbo",
      });
    }
  }

  if (mode === "local_whisper" || (mode === "auto" && localModel)) {
    if (localModel) {
      return new LocalWhisperCppSpeechProvider({
        binaryPath: env.LOCAL_WHISPER_BIN?.trim() || "whisper-cli",
        modelPath: localModel,
      });
    }
  }

  if (mode === "custom" || (mode === "auto" && customBaseUrl)) {
    if (customBaseUrl) {
      return new OpenAICompatibleWhisperProvider({
        name: "custom_whisper_api",
        endpointUrl: customBaseUrl,
        apiKey: env.STT_API_KEY?.trim() || "",
        model: env.STT_MODEL?.trim() || "whisper-1",
      });
    }
  }

  if (mode === "openai" || (mode === "auto" && openaiKey)) {
    if (openaiKey) {
      return new OpenAICompatibleWhisperProvider({
        name: "openai_whisper",
        endpointUrl: "https://api.openai.com/v1/audio/transcriptions",
        apiKey: openaiKey,
        model: env.OPENAI_WHISPER_MODEL?.trim() || "whisper-1",
      });
    }
  }

  return new HonestFallbackSpeechProvider();
}
