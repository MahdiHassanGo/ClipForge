import { describe, it, expect } from "vitest";
import {
  assertAuthenticated,
  assertResourceOwnership,
  AuthorizationError,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "../auth.js";
import { redactValue } from "../logger.js";
import {
  validateUploadMetadata,
  validateVideoMagicBytes,
} from "../upload-validation.js";

describe("Authorization, ownership, upload validation & log redaction", () => {
  it("hashes and verifies passwords with per-password random salts", async () => {
    const h1 = await hashPassword("super-secret-pass");
    const h2 = await hashPassword("super-secret-pass");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("super-secret-pass", h1)).toBe(true);
    expect(await verifyPassword("wrong-pass", h1)).toBe(false);
  });

  it("enforces authentication and per-user ownership checks", () => {
    expect(() => assertAuthenticated(null)).toThrow(AuthorizationError);
    expect(() =>
      assertResourceOwnership({
        actorUserId: "user_a",
        ownerUserId: "user_b",
        resourceName: "clip job",
      }),
    ).toThrow(AuthorizationError);

    expect(() =>
      assertResourceOwnership({
        actorUserId: "user_a",
        ownerUserId: "user_a",
        resourceName: "clip job",
      }),
    ).not.toThrow();
  });

  it("produces deterministic HMAC hashes for session tokens", () => {
    const t1 = hashSessionToken("raw-token-123", "pepper");
    const t2 = hashSessionToken("raw-token-123", "pepper");
    const t3 = hashSessionToken("raw-token-456", "pepper");
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
  });

  it("redacts secrets and API tokens in structured log payloads", () => {
    const redacted = redactValue({
      jobId: "job_1",
      password: "secret",
      apiKey: "AIzaSyDummyKey123456789012345",
      nested: { authorization: "Bearer sk-1234567890abcdef1234567890" },
    }) as Record<string, unknown>;

    expect(redacted.jobId).toBe("job_1");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
  });

  it("validates upload file size, extension, MIME, and container magic bytes", () => {
    const ok = validateUploadMetadata({
      fileName: "match_recording.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5 * 1024 * 1024,
      maxBytes: 100 * 1024 * 1024,
    });
    expect(ok.valid).toBe(true);

    const tooBig = validateUploadMetadata({
      fileName: "huge.mp4",
      mimeType: "video/mp4",
      sizeBytes: 200 * 1024 * 1024,
      maxBytes: 100 * 1024 * 1024,
    });
    expect(tooBig.valid).toBe(false);
    if (!tooBig.valid) expect(tooBig.code).toBe("FILE_TOO_LARGE");

    const badExt = validateUploadMetadata({
      fileName: "script.exe",
      mimeType: "application/octet-stream",
      sizeBytes: 1024,
    });
    expect(badExt.valid).toBe(false);

    // Valid ISO BMFF MP4 header ("....ftypisom")
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    expect(validateVideoMagicBytes(mp4Header)).toBe(true);

    // Valid EBML WebM/MKV header
    const webmHeader = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    ]);
    expect(validateVideoMagicBytes(webmHeader)).toBe(true);

    // Plain HTML/text disguised as .mp4 must fail
    const fakeHeader = Buffer.from("<html><body>not a video</body></html>");
    expect(validateVideoMagicBytes(fakeHeader)).toBe(false);
  });
});
