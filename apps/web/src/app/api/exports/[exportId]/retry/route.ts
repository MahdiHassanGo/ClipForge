import { NextRequest, NextResponse } from "next/server";
import {
  assertRenderTransition,
  assertResourceOwnership,
  canRetryRender,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ exportId: string }> },
) {
  try {
    const user = await requireUser();
    const { exportId } = await context.params;

    const record = await prisma.renderExport.findUnique({
      where: { id: exportId },
    });

    if (!record) {
      return NextResponse.json(
        { error: "Render export not found.", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: record.userId,
      resourceName: "render export",
    });

    const retryCheck = canRetryRender({
      status: record.status,
      retryCount: record.retryCount,
    });
    if (!retryCheck.allowed) {
      return NextResponse.json(
        { error: retryCheck.reason, code: "RETRY_NOT_ALLOWED" },
        { status: 409 },
      );
    }

    assertRenderTransition(record.status, "queued");

    const updated = await prisma.renderExport.update({
      where: { id: exportId },
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

    await prisma.clipJob.updateMany({
      where: { id: record.jobId, status: { in: ["complete", "failed", "candidates_ready"] } },
      data: {
        status: "rendering",
        progressMessage: "Retrying render export...",
      },
    });

    return NextResponse.json({ export: serializeJson(updated) });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/exports/[exportId]/retry" });
  }
}
