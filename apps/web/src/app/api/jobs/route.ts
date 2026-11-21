import path from "node:path";
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
    const isTwitchVod = isTwitch && input.youtubeUrl.includes("/videos/");

    let canonicalUrl = input.youtubeUrl;
    let videoId = "video";
    let title: string | null = null;
    let channelTitle: string | null = null;
    let thumbnailUrl: string | null = null;
    let durationSec: number | null = null;
    let streamType: "live_stream" | "archived_stream" | "regular_video" | "upcoming_stream" | "unknown" = "regular_video";
    let metadataSource: "youtube_data_api" | "oembed" | "none" = "none";
    let notice: string | null = null;

    if (isHls || (isTwitch && !isTwitchVod)) {
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
      try {
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
      } catch {
        // Non-YouTube URL (podcast audio, Twitch VOD, Kick, direct MP4)
        const normalized = /^https?:\/\//i.test(input.youtubeUrl)
          ? input.youtubeUrl
          : `https://${input.youtubeUrl}`;
        canonicalUrl = normalized;
        try {
          const u = new URL(normalized);
          const slug = path.basename(u.pathname).replace(/\.[^/.]+$/, "") || "media";
          videoId = slug.slice(0, 32);
          title = `${u.hostname} - ${slug.replace(/[-_]+/g, " ")}`;
          channelTitle = u.hostname;
        } catch {
          videoId = "media";
          title = "Scraped Media Clip";
        }
        const isAudio = /\.(mp3|m4a|aac|ogg|wav|flac)(\?.*)?$/i.test(normalized);
        thumbnailUrl = isAudio
          ? "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=640&q=80"
          : "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=80";
        streamType = isAudio ? "regular_video" : "archived_stream";
        notice = "Direct media link identified. Scraping and highlight analysis active.";
      }
    }

    const isLive = Boolean(input.isLiveStream || streamType === "live_stream");
    const analysisConfig = input.analysisConfig ?? getDefaultAnalysisConfig();

    const job = await prisma.clipJob.create({
      data: {
        userId: user.id,
        status: isLive ? "live_monitoring" : "analyzing",
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
        sourceProvider: isLive ? "live_stream" : "direct_scrape",
        analysisConfigJson: analysisConfig as unknown as Prisma.InputJsonValue,
        progressPct: isLive ? 0 : 5,
        progressMessage: isLive
          ? "Live stream queued — worker will resolve HLS manifest, pull live audio & monitor chat velocity."
          : "Scraping media directly from link (yt-dlp)...",
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
          mediaAccessAvailable: true,
          mediaAccessReason: isLive
            ? "Live HLS streaming supported directly."
            : "Direct media scraping active via yt-dlp & FFmpeg. No manual upload required.",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs" });
  }
}
