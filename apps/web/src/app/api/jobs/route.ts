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

    const isHls = input.youtubeUrl.includes(".m3u8") || input.youtubeUrl.includes("/hls/");
    const isTwitch = input.youtubeUrl.includes("twitch.tv");

    let canonicalUrl = input.youtubeUrl;
    let videoId = "video";
    let title: string | null = null;
    let channelTitle: string | null = null;
    let thumbnailUrl: string | null = null;
    let durationSec: number | null = null;
    let streamType: "live_stream" | "archived_stream" | "regular_video" | "upcoming_stream" | "unknown" = "regular_video";
    let metadataSource: "youtube_data_api" | "oembed" | "none" = "none";
    let notice: string | null = null;

    if (isHls || isTwitch) {
      const channel = isTwitch
        ? input.youtubeUrl.split("twitch.tv/")[1]?.split("/")[0]?.split("?")[0] || "Twitch Stream"
        : "Direct Live HLS";
      videoId = isTwitch ? `twitch_${channel}` : "live_hls";
      title = isTwitch ? `Twitch Live: ${channel}` : "Live HLS Stream (.m3u8)";
      channelTitle = channel;
      thumbnailUrl = "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=80";
      streamType = "live_stream";
      notice = "Direct live stream monitor active. Audio-first processing and chat velocity spikes enabled.";
    } else {
      const parsed = parseYouTubeUrl(input.youtubeUrl);
      canonicalUrl = parsed.canonicalUrl;
      videoId = parsed.videoId;
      const metadataProvider = new OfficialYouTubeMetadataProvider();
      const metadata = await metadataProvider.fetchMetadata(parsed);
      title = metadata.title;
      channelTitle = metadata.channelTitle;
      thumbnailUrl = metadata.thumbnailUrl;
      durationSec = metadata.durationSec;
      streamType = metadata.streamType;
      metadataSource = metadata.metadataSource;
      notice = metadata.notice;
    }

    const isLive = Boolean(input.isLiveStream || streamType === "live_stream");
    const analysisConfig = input.analysisConfig ?? getDefaultAnalysisConfig();

    const job = await prisma.clipJob.create({
      data: {
        userId: user.id,
        status: isLive ? "live_monitoring" : "queued",
        isLiveStream: isLive,
        liveManifestUrl: input.liveManifestUrl ?? (isHls ? canonicalUrl : null),
        liveAudioManifestUrl: input.liveAudioManifestUrl ?? null,
        youtubeUrl: canonicalUrl,
        youtubeVideoId: videoId,
        youtubeTitle: title,
        youtubeChannel: channelTitle,
        youtubeThumbnailUrl: thumbnailUrl,
        youtubeDurationSec: durationSec,
        youtubeStreamType: streamType,
        metadataSource,
        metadataNotice: notice,
        sourceProvider: isLive ? "live_stream" : "authorized_upload",
        analysisConfigJson: analysisConfig as unknown as Prisma.InputJsonValue,
        progressPct: 0,
        progressMessage: isLive
          ? "Live stream queued — worker will resolve HLS manifest, pull live audio & monitor chat velocity."
          : "Awaiting authorized source video upload.",
      },
    });

    return NextResponse.json(
      {
        job: serializeJson(job),
        metadata: {
          videoId,
          canonicalUrl,
          title,
          channelTitle,
          thumbnailUrl,
          durationSec,
          streamType,
          metadataSource,
          notice,
          mediaAccessAvailable: isLive,
          mediaAccessReason: isLive
            ? "Live HLS streaming supported directly."
            : "Authorized upload required for pre-recorded VODs.",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs" });
  }
}
