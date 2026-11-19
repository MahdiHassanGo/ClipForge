import { NextRequest, NextResponse } from "next/server";
import {
  AuthorizedUploadIngestionProvider,
  OfficialYouTubeMetadataProvider,
  inspectYoutubeSchema,
  parseYouTubeUrl,
} from "@clipforge/core";
import { requireUser } from "@/lib/session";
import { handleApiError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const body = await request.json();
    const { url } = inspectYoutubeSchema.parse(body);

    const isHls = url.includes(".m3u8") || url.includes("/hls/");
    const isTwitch = url.includes("twitch.tv");

    if (isHls || isTwitch) {
      const channelOrStream = isTwitch
        ? url.split("twitch.tv/")[1]?.split("/")[0]?.split("?")[0] || "Twitch Stream"
        : "Direct Live HLS";
      return NextResponse.json({
        parsed: {
          videoId: isTwitch ? `twitch_${channelOrStream}` : "live_hls",
          canonicalUrl: url,
          inputKind: "live",
        },
        metadata: {
          videoId: isTwitch ? `twitch_${channelOrStream}` : "live_hls",
          canonicalUrl: url,
          title: isTwitch ? `Twitch Live: ${channelOrStream}` : "Live HLS Stream (.m3u8)",
          channelTitle: channelOrStream,
          thumbnailUrl: "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=80",
          durationSec: null,
          streamType: "live_stream",
          metadataSource: "none",
          notice: "Live stream detected. ClipForge monitors rolling audio chunks and chat velocity spikes in real-time.",
          mediaAccessAvailable: true,
          mediaAccessReason: "Live HLS streaming supported natively without full video download.",
        },
        isLiveStream: true,
        canLiveIngest: true,
        ingestion: {
          providerId: "live_hls_stream",
          providerName: "Live Stream Ingest (Rolling HLS + Audio-First + Chat Velocity)",
          requiresUserUpload: false,
          directAccessAllowed: true,
          reason: "Live stream ingestion supported. Audio-first processing and chat velocity spikes detect peak moments without downloading the full stream.",
        },
      });
    }

    const parsed = parseYouTubeUrl(url);
    const metadataProvider = new OfficialYouTubeMetadataProvider();
    const ingestionProvider = new AuthorizedUploadIngestionProvider();

    const [metadata, ingestionCheck] = await Promise.all([
      metadataProvider.fetchMetadata(parsed),
      ingestionProvider.canIngestDirectly(parsed.videoId),
    ]);

    const isLive = parsed.inputKind === "live" || metadata.streamType === "live_stream";

    return NextResponse.json({
      parsed,
      metadata,
      isLiveStream: isLive,
      canLiveIngest: isLive,
      ingestion: {
        providerId: isLive ? "live_hls_stream" : ingestionProvider.id,
        providerName: isLive ? "Live Stream Ingest (Rolling HLS + Audio-First + Chat Velocity)" : ingestionProvider.displayName,
        requiresUserUpload: !isLive,
        directAccessAllowed: isLive || ingestionCheck.allowed,
        reason: isLive
          ? "Live stream detected. ClipForge can monitor rolling audio chunks and live chat velocity spikes in real time without downloading the full multi-GB stream."
          : ingestionCheck.reason,
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/youtube/inspect" });
  }
}
