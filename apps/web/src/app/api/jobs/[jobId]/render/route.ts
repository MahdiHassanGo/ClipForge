import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  assertJobTransition,
  assertResourceOwnership,
  createRenderRequestSchema,
  normalizeFaceCamRegion,
} from "@clipforge/core";
import { prisma, Prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      include: {
        candidates: true,
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

    if (!job.sourceStorageKey) {
      return NextResponse.json(
        {
          error: "Source media must be uploaded and analyzed before rendering clips.",
          code: "MEDIA_MISSING",
        },
        { status: 400 },
      );
    }

    assertJobTransition(job.status, "rendering");

    const body = await request.json();
    const input = createRenderRequestSchema.parse(body);

    const candidateMap = new Map(job.candidates.map((c) => [c.id, c]));
    const selectedClips = input.clipIds
      .map((id) => candidateMap.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c && c.status !== "discarded"));

    if (selectedClips.length === 0) {
      return NextResponse.json(
        { error: "No valid non-discarded clips were selected.", code: "NO_CLIPS_SELECTED" },
        { status: 400 },
      );
    }

    const createdOrExisting = [];

    for (const clip of selectedClips) {
      for (const preset of input.presets) {
        // Content-addressed idempotency key prevents duplicate simultaneous renders of identical settings
        const fingerprint = crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              clipId: clip.id,
              preset,
              startSec: clip.startSec,
              endSec: clip.endSec,
              layoutMode: clip.layoutMode,
              captionStyle: clip.captionStyle,
              captionLanguage: clip.captionLanguage,
              captionsEnabled: clip.captionsEnabled,
              faceCamCropJson: clip.faceCamCropJson,
              captionsJson: clip.captionsJson,
            }),
          )
          .digest("hex")
          .slice(0, 28);

        const existing = await prisma.renderExport.findUnique({
          where: { idempotencyKey: fingerprint },
        });

        if (existing && (existing.status === "queued" || existing.status === "rendering" || existing.status === "complete")) {
          createdOrExisting.push(existing);
          continue;
        }

        if (existing && (existing.status === "failed" || existing.status === "cancelled")) {
          const requeued = await prisma.renderExport.update({
            where: { id: existing.id },
            data: {
              status: "queued",
              progressPct: 0,
              progressMessage: "Queued for vertical 9:16 render...",
              errorCode: null,
              errorMessage: null,
              workerLockedAt: null,
              workerId: null,
              retryCount: { increment: 1 },
            },
          });
          createdOrExisting.push(requeued);
          continue;
        }

        const validClipFaceCam = normalizeFaceCamRegion(clip.faceCamCropJson);
        const record = await prisma.renderExport.create({
          data: {
            jobId: job.id,
            clipId: clip.id,
            userId: user.id,
            preset,
            status: "queued",
            startSec: clip.startSec,
            endSec: clip.endSec,
            layoutMode: clip.layoutMode,
            captionStyle: clip.captionStyle,
            captionLanguage: clip.captionLanguage,
            captionsEnabled: clip.captionsEnabled,
            ...(validClipFaceCam
              ? {
                  faceCamCropJson:
                    validClipFaceCam as unknown as Prisma.InputJsonValue,
                }
              : {}),
            captionsJson: clip.captionsJson as unknown as Prisma.InputJsonValue,
            progressPct: 0,
            progressMessage: "Queued for vertical 9:16 render...",
            idempotencyKey: fingerprint,
          },
        });
        createdOrExisting.push(record);
      }
    }

    const hasPending = createdOrExisting.some(
      (r) => r.status === "queued" || r.status === "rendering",
    );

    if (hasPending) {
      await prisma.clipJob.update({
        where: { id: job.id },
        data: {
          status: "rendering",
          progressMessage: `Queued ${createdOrExisting.length} vertical export(s)...`,
        },
      });
    }

    return NextResponse.json(
      { exports: serializeJson(createdOrExisting) },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs/[jobId]/render" });
  }
}
