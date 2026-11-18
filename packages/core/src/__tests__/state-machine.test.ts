import { describe, it, expect } from "vitest";
import {
  assertJobTransition,
  assertRenderTransition,
  canRetryRender,
  canTransitionJob,
  InvalidStateTransitionError,
  resolveJobRetryTarget,
} from "../state-machine.js";

describe("Job & Render state machine and retry rules", () => {
  it("allows the canonical happy-path job transitions", () => {
    expect(canTransitionJob("queued", "uploading")).toBe(true);
    expect(canTransitionJob("uploading", "analyzing")).toBe(true);
    expect(canTransitionJob("analyzing", "candidates_ready")).toBe(true);
    expect(canTransitionJob("candidates_ready", "rendering")).toBe(true);
    expect(canTransitionJob("rendering", "complete")).toBe(true);
  });

  it("rejects illegal state jumps such as queued -> analyzing without upload", () => {
    expect(() => assertJobTransition("queued", "analyzing")).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => assertJobTransition("queued", "complete")).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => assertJobTransition("uploading", "complete")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("prevents retrying into analyzing when authorized media was never uploaded", () => {
    const res = resolveJobRetryTarget({
      status: "failed",
      failedFromStatus: "uploading",
      hasSourceMedia: false,
      hasCandidates: false,
      retryCount: 0,
    });
    expect(res.allowed).toBe(true);
    expect(res.nextStatus).toBe("queued");
  });

  it("retries into analyzing when analysis failed and media exists", () => {
    const res = resolveJobRetryTarget({
      status: "failed",
      failedFromStatus: "analyzing",
      hasSourceMedia: true,
      hasCandidates: false,
      retryCount: 1,
    });
    expect(res.allowed).toBe(true);
    expect(res.nextStatus).toBe("analyzing");
  });

  it("retries into rendering when rendering failed and candidates exist", () => {
    const res = resolveJobRetryTarget({
      status: "failed",
      failedFromStatus: "rendering",
      hasSourceMedia: true,
      hasCandidates: true,
      retryCount: 1,
    });
    expect(res.allowed).toBe(true);
    expect(res.nextStatus).toBe("rendering");
  });

  it("enforces max retry limit on jobs and render exports", () => {
    const jobRes = resolveJobRetryTarget({
      status: "failed",
      failedFromStatus: "analyzing",
      hasSourceMedia: true,
      hasCandidates: false,
      retryCount: 5,
      maxRetries: 5,
    });
    expect(jobRes.allowed).toBe(false);

    expect(canRetryRender({ status: "failed", retryCount: 2 }).allowed).toBe(true);
    expect(canRetryRender({ status: "complete", retryCount: 0 }).allowed).toBe(false);
    expect(canRetryRender({ status: "failed", retryCount: 5, maxRetries: 5 }).allowed).toBe(
      false,
    );

    expect(() => assertRenderTransition("complete", "queued")).toThrow(
      InvalidStateTransitionError,
    );
  });
});
