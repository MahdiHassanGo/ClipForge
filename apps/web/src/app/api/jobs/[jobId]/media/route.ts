import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { assertResourceOwnership } from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { getObjectStorage } from "@/lib/env";
import { handleApiError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      select: {
        userId: true,
        sourceStorageKey: true,
        sourceMimeType: true,
      },
    });

    if (!job || !job.sourceStorageKey) {
      return NextResponse.json(
        { error: "Source media not found for this job.", code: "MEDIA_NOT_FOUND" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "source video",
    });

    const storage = getObjectStorage();
    const stat = await storage.stat(job.sourceStorageKey);
    if (!stat) {
      return NextResponse.json(
        { error: "Source video file is missing from storage.", code: "MEDIA_MISSING" },
        { status: 404 },
      );
    }

    const totalSize = stat.sizeBytes;
    const contentType = job.sourceMimeType || "video/mp4";
    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalSize}` },
        });
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;

      if (start >= totalSize || end < start) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalSize}` },
        });
      }

      const { stream } = await storage.createReadStream(job.sourceStorageKey, {
        start,
        end,
      });
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new NextResponse(webStream, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    const { stream } = await storage.createReadStream(job.sourceStorageKey);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(totalSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/jobs/[jobId]/media" });
  }
}
