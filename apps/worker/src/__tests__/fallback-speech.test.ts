import { describe, it, expect } from "vitest";
import {
  createSpeechRecognitionProvider,
  HonestFallbackSpeechProvider,
  SubtitleAwareSpeechRecognitionProvider,
} from "../speech-provider.js";

describe("Speech recognition provider selection & honest fallback", () => {
  it("never fabricates spoken words and flags activity windows for manual review", async () => {
    const provider = new HonestFallbackSpeechProvider();
    const result = await provider.transcribe({
      audioFilePath: "/unused/fallback.mp4",
      durationSec: 30,
      languageHint: "en",
      audioTimeline: [
        { second: 0, rmsDb: -60, peakDb: -55, reactionScore: 0, isSilenceToBurst: false },
        { second: 5, rmsDb: -22, peakDb: -10, reactionScore: 0.65, isSilenceToBurst: true },
        { second: 6, rmsDb: -20, peakDb: -8, reactionScore: 0.72, isSilenceToBurst: false },
        { second: 7, rmsDb: -24, peakDb: -12, reactionScore: 0.55, isSilenceToBurst: false },
      ],
    });

    expect(result.providerName).toBe("audio_activity_fallback_no_asr");
    expect(result.notice).toContain("GROQ_API_KEY");
    expect(result.segments.length).toBe(1);
    expect(result.segments[0]!.lowConfidence).toBe(true);
    expect(result.segments[0]!.needsReview).toBe(true);
    expect(result.segments[0]!.text).toContain("[Speech activity detected");
  });

  it("prioritizes free Groq Whisper and local whisper.cpp cleanly in auto mode", () => {
    // In an empty directory with no models or keys, auto falls back cleanly
    expect(
      createSpeechRecognitionProvider({ STT_PROVIDER: "auto" }, "/tmp/empty-stt-dir").name,
    ).toBe("audio_activity_fallback_no_asr");

    // When offline models exist in the repo, auto selects local whisper
    expect(createSpeechRecognitionProvider({ STT_PROVIDER: "auto" }).name).toBe(
      "local_whisper_cpp",
    );

    expect(
      createSpeechRecognitionProvider({
        STT_PROVIDER: "auto",
        GROQ_API_KEY: "gsk_test_free_key",
      }).name,
    ).toBe("groq_whisper_free");

    expect(
      createSpeechRecognitionProvider({
        STT_PROVIDER: "auto",
        LOCAL_WHISPER_MODEL_PATH: "/tmp/ggml-base.en.bin",
      }).name,
    ).toBe("local_whisper_cpp");

    expect(
      createSpeechRecognitionProvider({
        STT_PROVIDER: "local_whisper",
        GROQ_API_KEY: "gsk_test_free_key",
        LOCAL_WHISPER_MODEL_PATH: "/tmp/ggml-base.en.bin",
      }).name,
    ).toBe("local_whisper_cpp");
  });

  it("transliterates Bengali segments and words to Banglish when languageHint is bn_en", async () => {
    const wrapped = new SubtitleAwareSpeechRecognitionProvider({
      name: "mock_bn_stt",
      async transcribe() {
        return {
          providerName: "mock_bn_stt",
          language: "bn",
          segments: [
            {
              index: 0,
              startSec: 1.0,
              endSec: 4.5,
              text: "কেমন আছেন ভাই",
              language: "bn",
              confidence: 0.92,
              lowConfidence: false,
              needsReview: false,
              words: [
                { word: "কেমন", startSec: 1.0, endSec: 1.8, confidence: 0.9, lowConfidence: false },
                { word: "আছেন", startSec: 1.9, endSec: 2.8, confidence: 0.92, lowConfidence: false },
                { word: "ভাই", startSec: 2.9, endSec: 4.0, confidence: 0.94, lowConfidence: false },
              ],
            },
          ],
        };
      },
    });

    const result = await wrapped.transcribe({
      audioFilePath: "/tmp/nonexistent-dir/audio.mp4",
      durationSec: 10,
      languageHint: "bn_en",
      audioTimeline: [],
    });

    expect(result.language).toBe("bn_en");
    expect(result.segments[0]?.text).toBe("kemon achhen bhai");
    expect(result.segments[0]?.words.map((w) => w.word)).toEqual(["kemon", "achhen", "bhai"]);
  });
});
