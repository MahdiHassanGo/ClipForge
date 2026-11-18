import { NextRequest, NextResponse } from "next/server";
import {
  OfficialYouTubeMetadataProvider,
  createJobSchema,
  getDefaultAnalysisConfig,
  parseYouTubeUrl,
} from "@clipforge/core";
import { prisma, Prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";

export async function GET() {
  try {
    const user = await requireUser();
    const jobs = await prisma.clipJob.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        _count: {
          select: {
            candidates: true,
            renderExports: true,
          },
        },
      },
    });

    return NextResponse.json({
      jobs: serializeJson(jobs),
    });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/jobs" });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const input = createJobSchema.parse(body);

    const parsed = parseYouTubeUrl(input.youtubeUrl);
    const metadataProvider = new OfficialYouTubeMetadataProvider();
    const metadata = await metadataProvider.fetchMetadata(parsed);
    const analysisConfig = input.analysisConfig ?? getDefaultAnalysisConfig();

    const job = await prisma.clipJob.create({
      data: {
        userId: user.id,
        status: "queued",
        youtubeUrl: parsed.canonicalUrl,
        youtubeVideoId: parsed.videoId,
        youtubeTitle: metadata.title,
        youtubeChannel: metadata.channelTitle,
        youtubeThumbnailUrl: metadata.thumbnailUrl,
        youtubeDurationSec: metadata.durationSec,
        youtubeStreamType: metadata.streamType,
        metadataSource: metadata.metadataSource,
        metadataNotice: metadata.notice,
        sourceProvider: "authorized_upload",
        analysisConfigJson: analysisConfig as unknown as Prisma.InputJsonValue,
        progressPct: 0,
        progressMessage: "Awaiting authorized source video upload.",
      },
    });

    return NextResponse.json(
      {
        job: serializeJson(job),
        metadata,
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs" });
  }
}
