import { NextRequest, NextResponse } from "next/server";
import {
  assertResourceOwnership,
  updateCandidateSchema,
  validateCandidateBounds,
} from "@clipforge/core";
import { prisma, Prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ jobId: string; clipId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId, clipId } = await context.params;

    const clip = await prisma.candidateClip.findUnique({
      where: { id: clipId },
      include: {
        job: {
          select: { id: true, userId: true, mediaDurationSec: true },
        },
      },
    });

    if (!clip || clip.jobId !== jobId) {
      return NextResponse.json(
        { error: "Candidate clip not found.", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: clip.job.userId,
      resourceName: "candidate clip",
    });

    const body = await request.json();
    const input = updateCandidateSchema.parse(body);

    const nextStart = input.startSec ?? clip.startSec;
    const nextEnd = input.endSec ?? clip.endSec;

    const boundsCheck = validateCandidateBounds({
      startSec: nextStart,
      endSec: nextEnd,
      mediaDurationSec: clip.job.mediaDurationSec ?? 0,
    });

    if (!boundsCheck.valid) {
      return NextResponse.json(
        { error: boundsCheck.error, code: "INVALID_CLIP_BOUNDS" },
        { status: 400 },
      );
    }

    const updateData: Prisma.CandidateClipUpdateInput = {};
    if (input.title !== undefined) updateData.title = input.title;
    if (input.startSec !== undefined) updateData.startSec = input.startSec;
    if (input.endSec !== undefined) updateData.endSec = input.endSec;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.layoutMode !== undefined) updateData.layoutMode = input.layoutMode;
    if (input.faceCamCrop !== undefined) {
      updateData.faceCamCropJson = (input.faceCamCrop ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    if (input.captionLanguage !== undefined) {
      updateData.captionLanguage = input.captionLanguage;
    }
    if (input.captionStyle !== undefined) {
      updateData.captionStyle = input.captionStyle;
    }
    if (input.captionsEnabled !== undefined) {
      updateData.captionsEnabled = input.captionsEnabled;
    }
    if (input.captions !== undefined) {
      updateData.captionsJson = input.captions as unknown as Prisma.InputJsonValue;
      updateData.hasUnreviewedCaptions = input.captions.some((c) => c.needsReview);
    }

    const updated = await prisma.candidateClip.update({
      where: { id: clipId },
      data: updateData,
    });

    return NextResponse.json({ candidate: serializeJson(updated) });
  } catch (error) {
    return handleApiError(error, { route: "PATCH /api/jobs/[jobId]/candidates/[clipId]" });
  }
}
