import type { JobStatus, RenderStatus } from "./types.js";

/**
 * Typed job state machine:
 * queued -> uploading -> analyzing -> candidates_ready -> rendering -> complete
 * with failed and cancelled states + deterministic retry transitions.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["uploading", "live_monitoring", "failed", "cancelled"],
  live_monitoring: ["candidates_ready", "failed", "cancelled"],
  uploading: ["analyzing", "failed", "cancelled"],
  analyzing: ["candidates_ready", "failed", "cancelled"],
  candidates_ready: ["rendering", "analyzing", "live_monitoring", "cancelled"],
  rendering: ["complete", "candidates_ready", "failed", "cancelled"],
  complete: ["rendering", "candidates_ready"],
  failed: ["queued", "live_monitoring", "uploading", "analyzing", "rendering", "cancelled"],
  cancelled: ["queued", "live_monitoring", "uploading", "analyzing"],
};

export const RENDER_TRANSITIONS: Readonly<Record<RenderStatus, readonly RenderStatus[]>> = {
  queued: ["rendering", "failed", "cancelled"],
  rendering: ["complete", "failed", "cancelled"],
  complete: [],
  failed: ["queued", "cancelled"],
  cancelled: ["queued"],
};

export class InvalidStateTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION";
  readonly from: string;
  readonly to: string;

  constructor(entity: "job" | "render", from: string, to: string) {
    super(`Invalid ${entity} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new InvalidStateTransitionError("job", from, to);
  }
}

export function canTransitionRender(from: RenderStatus, to: RenderStatus): boolean {
  if (from === to) return true;
  return RENDER_TRANSITIONS[from].includes(to);
}

export function assertRenderTransition(from: RenderStatus, to: RenderStatus): void {
  if (!canTransitionRender(from, to)) {
    throw new InvalidStateTransitionError("render", from, to);
  }
}

export interface RetryResolution {
  allowed: boolean;
  nextStatus?: JobStatus;
  reason?: string;
}

/**
 * Resolves the safe, idempotent retry target for a failed or cancelled job.
 * Never retries into "analyzing" if authorized media has not been uploaded.
 */
export function resolveJobRetryTarget(params: {
  status: JobStatus;
  failedFromStatus: JobStatus | null;
  hasSourceMedia: boolean;
  hasCandidates: boolean;
  isLiveStream?: boolean;
  sourceProvider?: string;
  retryCount: number;
  maxRetries?: number;
}): RetryResolution {
  const maxRetries = params.maxRetries ?? 5;

  if (params.status !== "failed" && params.status !== "cancelled") {
    return {
      allowed: false,
      reason: `Job is in '${params.status}' state and does not need a retry.`,
    };
  }

  if (params.retryCount >= maxRetries) {
    return {
      allowed: false,
      reason: `Maximum retry limit (${maxRetries}) reached. Please inspect the error or create a new job.`,
    };
  }

  if (params.isLiveStream) {
    return {
      allowed: true,
      nextStatus: "live_monitoring",
    };
  }

  if (params.sourceProvider === "direct_scrape") {
    return {
      allowed: true,
      nextStatus: "analyzing",
    };
  }

  if (!params.hasSourceMedia) {
    return {
      allowed: true,
      nextStatus: "queued",
    };
  }

  if (params.failedFromStatus === "rendering" && params.hasCandidates) {
    return {
      allowed: true,
      nextStatus: "rendering",
    };
  }

  return {
    allowed: true,
    nextStatus: "analyzing",
  };
}

export function canRetryRender(params: {
  status: RenderStatus;
  retryCount: number;
  maxRetries?: number;
}): { allowed: boolean; reason?: string } {
  const maxRetries = params.maxRetries ?? 5;
  if (params.status !== "failed" && params.status !== "cancelled") {
    return {
      allowed: false,
      reason: `Render export in '${params.status}' state cannot be retried.`,
    };
  }
  if (params.retryCount >= maxRetries) {
    return {
      allowed: false,
      reason: `Maximum render retry limit (${maxRetries}) reached.`,
    };
  }
  return { allowed: true };
}
