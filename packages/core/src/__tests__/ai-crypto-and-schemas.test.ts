import { describe, expect, it } from "vitest";
import {
  AI_PROVIDER_CATALOG,
  createAiProviderSchema,
  decryptApiKey,
  encryptApiKey,
  extractKeyLast4,
  jobChatRequestSchema,
  maskApiKey,
  normalizeFaceCamRegion,
  updateCandidateSchema,
} from "../index.js";

describe("AI API key encryption & masking", () => {
  it("encrypts and decrypts API keys roundtrip with random IVs", () => {
    const secret = "test-encryption-secret-32-chars!!";
    const key = "sk-ant-api03-secret-token-value-123456";
    const enc1 = encryptApiKey(key, secret);
    const enc2 = encryptApiKey(key, secret);

    expect(enc1).not.toEqual(enc2);
    expect(enc1.startsWith("enc:v1:")).toBe(true);
    expect(enc1).not.toContain(key);
    expect(decryptApiKey(enc1, secret)).toBe(key);
    expect(decryptApiKey(enc2, secret)).toBe(key);
  });

  it("rejects malformed or tampered ciphertexts", () => {
    const secret = "test-secret";
    const enc = encryptApiKey("sk-openai-1234567890", secret);
    expect(() => decryptApiKey("invalid-format", secret)).toThrow();
    expect(() => decryptApiKey(enc, "wrong-secret")).toThrow();
  });

  it("masks API keys without exposing middle characters", () => {
    const masked = maskApiKey("sk-ant-api03-verysecretmiddle9988");
    expect(masked).toContain("...9988");
    expect(masked).not.toContain("verysecretmiddle");
    expect(maskApiKey(null)).toBe("No key (local)");
    expect(extractKeyLast4("sk-test-abcd")).toBe("abcd");
  });
});

describe("AI provider and chat schemas", () => {
  it("requires an API key for cloud providers but allows optional key for custom local endpoints", () => {
    const badCloud = createAiProviderSchema.safeParse({
      provider: "anthropic",
      label: "Claude",
      model: AI_PROVIDER_CATALOG.anthropic.defaultModel,
    });
    expect(badCloud.success).toBe(false);

    const goodCloud = createAiProviderSchema.safeParse({
      provider: "openrouter",
      label: "OpenRouter",
      model: "anthropic/claude-sonnet-4.5",
      apiKey: "sk-or-v1-valid-key-12345",
      isDefault: true,
    });
    expect(goodCloud.success).toBe(true);

    const goodLocal = createAiProviderSchema.safeParse({
      provider: "custom",
      label: "Local Ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(goodLocal.success).toBe(true);

    const badUrl = createAiProviderSchema.safeParse({
      provider: "custom",
      label: "Bad URL",
      model: "llama3.2",
      baseUrl: "ftp://localhost:11434",
    });
    expect(badUrl.success).toBe(false);
  });

  it("validates job chat requests", () => {
    expect(jobChatRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(
      jobChatRequestSchema.safeParse({
        message: "Find clutch moments around boss fight",
        providerId: "prov_123",
      }).success,
    ).toBe(true);
  });

  it("normalizes empty or malformed faceCamCrop objects to null instead of failing validation", () => {
    expect(normalizeFaceCamRegion({})).toBeNull();
    expect(normalizeFaceCamRegion({ x: Number.NaN, y: 0 })).toBeNull();

    const parsed = updateCandidateSchema.safeParse({
      layoutMode: "gameplay_focus",
      faceCamCrop: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.faceCamCrop).toBeNull();
    }
  });
});
