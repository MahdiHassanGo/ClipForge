import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type {
  AudioTimelinePoint,
  SpeechRecognitionProvider,
  SpeechRecognitionResult,
  TranscriptSegmentData,
  TranscriptWord,
} from "@clipforge/core";
import {
  createLogger,
  detectSttStatus,
  resolveLocalWhisperModelPath,
  transliterateBengaliToBanglish,
} from "@clipforge/core";
import { resolveFfmpegPath, runExecFile } from "./ffmpeg-binaries.js";
import { parseVttSubtitles } from "./vtt-parser.js";

const logger = createLogger("clipforge-speech-provider");

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

function resolveWhisperSttHint(languageHint: string, configuredPrompt?: string): {
  whisperLang?: string;
  transliterateBanglish: boolean;
  prompt: string;
} {
  if (languageHint === "bn_en") {
    return {
      whisperLang: "bn",
      transliterateBanglish: true,
      prompt: "Bengali and English podcast or livestream conversation.",
    };
  }
  if (languageHint === "bn") {
    return {
      whisperLang: "bn",
      transliterateBanglish: false,
      prompt: "বাংলা এবং ইংরেজি পডকাস্ট বা আলোচনা।",
    };
  }
  if (languageHint === "auto") {
    return {
      whisperLang: undefined,
      transliterateBanglish: false,
      prompt: "Natural spoken podcast, interview, or livestream commentary.",
    };
  }
  if (languageHint === "en") {
    return {
      whisperLang: "en",
      transliterateBanglish: false,
      prompt:
        configuredPrompt?.trim() ||
        "Gaming livestream commentary, podcast discussion, gameplay action, clutch reaction",
    };
  }
  return {
    whisperLang: languageHint,
    transliterateBanglish: false,
    prompt: "Spoken podcast, interview, or livestream commentary.",
  };
}

function applyBanglishTransliteration(
  result: SpeechRecognitionResult,
): SpeechRecognitionResult {
  return {
    ...result,
    language: "bn_en",
    segments: result.segments.map((seg) => ({
      ...seg,
      language: "bn_en",
      text: transliterateBengaliToBanglish(seg.text),
      words: seg.words.map((w) => ({
        ...w,
        word: transliterateBengaliToBanglish(w.word),
      })),
    })),
  };
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
          "-af",
          "highpass=f=100,lowpass=f=4200,volume=1.2",
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

      const sttHint = resolveWhisperSttHint(params.languageHint);

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
      form.append("prompt", sttHint.prompt);
      if (sttHint.whisperLang) {
        form.append("language", sttHint.whisperLang);
      }

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      let response: Response | null = null;
      let errBody = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        if (chunkIdx > 0 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 600));
        }
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
        }

        response = await fetch(this.endpointUrl, {
          method: "POST",
          headers,
          body: form,
          signal: AbortSignal.timeout(180_000),
        });

        if (response.ok) break;

        errBody = await response.text();
        if (response.status !== 429 && response.status < 500) {
          break;
        }
      }

      if (!response || !response.ok) {
        throw new Error(
          `Transcription provider '${this.name}' failed (${response?.status ?? "no-response"}): ${errBody.slice(0, 300)}`,
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
  readonly modelTag: string;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly prompt: string;
  private readonly threads: number;

  constructor(config: {
    binaryPath?: string;
    modelPath: string;
    prompt?: string;
    threads?: number;
  }) {
    this.binaryPath = config.binaryPath?.trim() || "whisper-cli";
    this.modelPath = config.modelPath;
    this.modelTag = path.basename(this.modelPath).replace(/^ggml-|\.bin$/g, "");
    this.prompt =
      config.prompt?.trim() ||
      "Gaming livestream commentary, gameplay action, clutch reaction, GTA gameplay, streamer callouts, Vice City, Jason, Lucia";
    this.threads = config.threads && config.threads > 0 ? config.threads : 6;
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

    // Dynamic audio preprocessing: Bandpass vocal filter + loudnorm normalization
    // Eliminates sub-bass rumble (car engines, explosions) and screeching while normalizing human voices
    await runExecFile(
      resolveFfmpegPath(),
      [
        "-y",
        "-v",
        "error",
        "-i",
        params.audioFilePath,
        "-vn",
        "-af",
        "highpass=f=120,lowpass=f=3800,loudnorm=I=-16:TP=-1.5:LRA=11",
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

    const sttHint = resolveWhisperSttHint(params.languageHint, this.prompt);

    // Fine-tuned whisper-cli parameters for Apple Silicon Metal & Speech Accuracy
    const args = [
      "-m",
      this.modelPath,
      "-f",
      wavPath,
      "-ojf",
      "-of",
      outputPrefix,
      "--no-prints",
      "-sow", // Split on words, never cut words mid-token
      "-sns", // Suppress non-speech hallucination tokens during background music
      "-bo",
      "5", // Best of 5 beam candidates
      "-bs",
      "5", // Beam size 5 for deep search
      "-t",
      String(this.threads), // Optimal thread count for Apple M4
      "-mc",
      "128", // Limit context window to prevent repetitive hallucination loops
      "-wt",
      "0.01", // Word timestamp threshold
      "--prompt",
      sttHint.prompt,
    ];
    if (sttHint.whisperLang) {
      args.push("-l", sttHint.whisperLang);
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

export class SubtitleAwareSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly name: string;
  private readonly inner: SpeechRecognitionProvider;

  constructor(inner: SpeechRecognitionProvider) {
    this.inner = inner;
    this.name = inner.name;
  }

  async transcribe(params: {
    audioFilePath: string;
    durationSec: number;
    languageHint: string;
    audioTimeline: AudioTimelinePoint[];
  }): Promise<SpeechRecognitionResult> {
    const dir = path.dirname(params.audioFilePath);
    try {
      const files = await fs.readdir(dir);
      const vttFile = files.find((f) => f.endsWith(".vtt"));
      if (vttFile) {
        const vttPath = path.join(dir, vttFile);
        const vttContent = await fs.readFile(vttPath, "utf8");
        const segments = parseVttSubtitles(
          vttContent,
          params.languageHint === "auto" ? "en" : params.languageHint,
        );
        if (segments.length > 0) {
          logger.info("Found pre-scraped video subtitles — using direct native captions", {
            vttFile,
            segmentCount: segments.length,
          });
          const vttResult: SpeechRecognitionResult = {
            providerName: "native_video_captions",
            language: segments[0]?.language ?? "en",
            segments,
          };
          return params.languageHint === "bn_en"
            ? applyBanglishTransliteration(vttResult)
            : vttResult;
        }
      }
    } catch (err) {
      logger.warn("Could not parse local VTT subtitle file, continuing with speech provider", {
        error: String(err),
      });
    }

    const res = await this.inner.transcribe(params);
    return params.languageHint === "bn_en"
      ? applyBanglishTransliteration(res)
      : res;
  }
}

export { resolveLocalWhisperModelPath, detectSttStatus };

export function createSpeechRecognitionProvider(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = process.cwd(),
): SpeechRecognitionProvider {
  const base = resolveBaseSpeechProvider(env, baseDir);
  return new SubtitleAwareSpeechRecognitionProvider(base);
}

function resolveBaseSpeechProvider(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = process.cwd(),
): SpeechRecognitionProvider {
  const mode = (env.STT_PROVIDER ?? "auto").toLowerCase().trim();
  const groqKey = env.GROQ_API_KEY?.trim();
  const localModel = resolveLocalWhisperModelPath(env, baseDir);
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
      const threads = Number(env.WHISPER_THREADS) || 6;
      const prompt = env.WHISPER_PROMPT?.trim();
      return new LocalWhisperCppSpeechProvider({
        binaryPath: env.LOCAL_WHISPER_BIN?.trim() || "whisper-cli",
        modelPath: localModel,
        prompt,
        threads,
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
