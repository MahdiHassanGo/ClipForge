import { describe, it, expect } from "vitest";
import { detectSttStatus, resolveLocalWhisperModelPath } from "../providers.js";

describe("STT detection & model resolution", () => {
  it("resolves explicit LOCAL_WHISPER_MODEL_PATH directly", () => {
    const resolved = resolveLocalWhisperModelPath(
      { LOCAL_WHISPER_MODEL_PATH: "/custom/models/whisper.bin" },
      "/unused",
    );
    expect(resolved).toBe("/custom/models/whisper.bin");
  });

  it("detects groq provider when GROQ_API_KEY is supplied", () => {
    const status = detectSttStatus({
      STT_PROVIDER: "auto",
      GROQ_API_KEY: "gsk_live_test_12345",
    }, "/unused");

    expect(status.configured).toBe(true);
    expect(status.provider).toBe("groq");
    expect(status.label).toBe("Groq Whisper (Free)");
  });

  it("detects local whisper offline when models exist in repo models/ dir", () => {
    // Current working directory has models/ggml-large-v3-turbo.bin downloaded
    const status = detectSttStatus({
      STT_PROVIDER: "local_whisper",
      LOCAL_WHISPER_MODEL: "auto",
      LOCAL_WHISPER_MODEL_PATH: "",
    }, process.cwd());

    expect(status.configured).toBe(true);
    expect(status.provider).toBe("local_whisper");
    expect(status.label).toBe("Local Whisper (Offline)");
    expect(status.modelPath).toBeDefined();
  });

  it("falls back to manual when provider is explicitly none or unconfigured", () => {
    const statusDisabled = detectSttStatus({ STT_PROVIDER: "none" }, "/unused");
    expect(statusDisabled.configured).toBe(false);
    expect(statusDisabled.label).toBe("Manual (Free)");

    const statusUnset = detectSttStatus({
      STT_PROVIDER: "auto",
      GROQ_API_KEY: "",
      LOCAL_WHISPER_MODEL_PATH: "",
    }, "/tmp/nonexistent-dir");
    expect(statusUnset.configured).toBe(false);
    expect(statusUnset.label).toBe("Manual (No Key)");
  });
});
