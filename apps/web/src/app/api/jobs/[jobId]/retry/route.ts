import { NextRequest, NextResponse } from "next/server";
import {
  assertJobTransition,
  assertResourceOwnership,
  resolveJobRetryTarget,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      include: {
        _count: { select: { candidates: true } },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404 });
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "clip job",
    });

    // Also allow explicit re-analysis from candidates_ready when requested
    if (job.status === "candidates_ready" && job.sourceStorageKey) {
      assertJobTransition(job.status, "analyzing");
      const updated = await prisma.clipJob.update({
        where: { id: jobId },
        data: {
          status: "analyzing",
          progressPct: 5,
          progressMessage: "Re-running background analysis...",
          errorCode: null,
          errorMessage: null,
          workerLockedAt: null,
          workerId: null,
          retryCount: { increment: 1 },
        },
      });
      return NextResponse.json({ job: serializeJson(updated) });
    }

    const resolution = resolveJobRetryTarget({
      status: job.status,
      failedFromStatus: job.failedFromStatus,
      hasSourceMedia: Boolean(job.sourceStorageKey),
      hasCandidates: job._count.candidates > 0,
      isLiveStream: Boolean(job.isLiveStream),
      sourceProvider: job.sourceProvider,
      retryCount: job.retryCount,
    });

    if (!resolution.allowed || !resolution.nextStatus) {
      return NextResponse.json(
        { error: resolution.reason ?? "Retry is not permitted.", code: "RETRY_NOT_ALLOWED" },
        { status: 409 },
      );
    }

    assertJobTransition(job.status, resolution.nextStatus);

    if (resolution.nextStatus === "rendering") {
      await prisma.renderExport.updateMany({
        where: { jobId, status: "failed" },
        data: {
          status: "queued",
          progressPct: 0,
          progressMessage: "Queued for retry...",
          errorCode: null,
          errorMessage: null,
          workerLockedAt: null,
          workerId: null,
          retryCount: { increment: 1 },
        },
      });
    }

    const updated = await prisma.clipJob.update({
      where: { id: jobId },
      data: {
        status: resolution.nextStatus,
        progressPct: resolution.nextStatus === "queued" ? 0 : 5,
        progressMessage:
          resolution.nextStatus === "queued"
            ? "Ready for you to upload your authorized source video file."
            : resolution.nextStatus === "rendering"
              ? "Retrying failed clip exports..."
              : "Re-queued for background analysis...",
        errorCode: null,
        errorMessage: null,
        failedFromStatus: null,
        workerLockedAt: null,
        workerId: null,
        retryCount: { increment: 1 },
      },
    });

    return NextResponse.json({ job: serializeJson(updated) });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs/[jobId]/retry" });
  }
}
