import { describe, it, expect } from "vitest";
import {
  createSpeechRecognitionProvider,
  HonestFallbackSpeechProvider,
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
    expect(createSpeechRecognitionProvider({ STT_PROVIDER: "auto" }).name).toBe(
      "audio_activity_fallback_no_asr",
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
});
