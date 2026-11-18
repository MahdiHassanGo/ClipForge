import { NextRequest, NextResponse } from "next/server";
import { assertResourceOwnership } from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { getObjectStorage } from "@/lib/env";
import { handleApiError, serializeJson } from "@/lib/http";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      include: {
        candidates: {
          orderBy: { rank: "asc" },
        },
        sceneEvents: {
          orderBy: { timestampSec: "asc" },
          take: 500,
        },
        transcriptSegments: {
          orderBy: { segmentIndex: "asc" },
          take: 1000,
        },
        renderExports: {
          orderBy: { createdAt: "desc" },
          include: {
            clip: {
              select: { id: true, title: true, rank: true },
            },
          },
        },
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

    return NextResponse.json({ job: serializeJson(job) });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/jobs/[jobId]" });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      include: {
        renderExports: { select: { outputStorageKey: true } },
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

    const storage = getObjectStorage();
    if (job.sourceStorageKey) {
      await storage.delete(job.sourceStorageKey).catch(() => {});
    }
    for (const exp of job.renderExports) {
      if (exp.outputStorageKey) {
        await storage.delete(exp.outputStorageKey).catch(() => {});
      }
    }

    await prisma.clipJob.delete({ where: { id: jobId } });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, { route: "DELETE /api/jobs/[jobId]" });
  }
}
