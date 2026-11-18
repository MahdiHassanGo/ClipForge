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
  context: { params: Promise<{ exportId: string }> },
) {
  try {
    const user = await requireUser();
    const { exportId } = await context.params;

    const record = await prisma.renderExport.findUnique({
      where: { id: exportId },
    });

    if (!record || record.status !== "complete" || !record.outputStorageKey) {
      return NextResponse.json(
        { error: "Rendered MP4 export is not available.", code: "EXPORT_NOT_READY" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: record.userId,
      resourceName: "render export",
    });

    const storage = getObjectStorage();
    const stat = await storage.stat(record.outputStorageKey);
    if (!stat) {
      return NextResponse.json(
        { error: "Rendered file is missing from object storage.", code: "EXPORT_MISSING" },
        { status: 404 },
      );
    }

    const totalSize = stat.sizeBytes;
    const isInline = request.nextUrl.searchParams.get("inline") === "1";
    const fileName = record.outputFileName || `clip-${record.preset}.mp4`;
    const disposition = isInline
      ? `inline; filename="${fileName}"`
      : `attachment; filename="${fileName}"`;

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

      const { stream } = await storage.createReadStream(record.outputStorageKey, {
        start,
        end,
      });
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new NextResponse(webStream, {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${totalSize}`,
          "Content-Disposition": disposition,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const { stream } = await storage.createReadStream(record.outputStorageKey);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(totalSize),
        "Content-Disposition": disposition,
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/exports/[exportId]/download" });
  }
}
