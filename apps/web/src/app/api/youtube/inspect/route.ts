import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  DirectScrapeIngestionProvider,
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
    const isTwitchVod = isTwitch && url.includes("/videos/");

    if (isHls || (isTwitch && !isTwitchVod)) {
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

    const directIngestion = new DirectScrapeIngestionProvider();

    // Check if URL is standard YouTube
    let parsed: { videoId: string; canonicalUrl: string; inputKind: "watch" | "short_link" | "live" | "shorts" | "embed" };
    let isYouTube = false;

    try {
      parsed = parseYouTubeUrl(url);
      isYouTube = true;
    } catch {
      // Non-YouTube URL (podcast audio, Twitch VOD, Kick, direct MP4/M3U8)
      try {
        const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        const parsedUrl = new URL(normalized);
        const slug = path.basename(parsedUrl.pathname).replace(/\.[^/.]+$/, "") || "media";
        parsed = {
          videoId: slug.slice(0, 32) || "media",
          canonicalUrl: normalized,
          inputKind: "watch",
        };
      } catch {
        return NextResponse.json(
          { error: "Invalid media URL. Please paste a valid video, stream, or podcast link." },
          { status: 400 },
        );
      }
    }

    if (isYouTube) {
      const metadataProvider = new OfficialYouTubeMetadataProvider();
      const metadata = await metadataProvider.fetchMetadata(parsed);
      const isLive = parsed.inputKind === "live" || metadata.streamType === "live_stream";

      return NextResponse.json({
        parsed,
        metadata: {
          ...metadata,
          mediaAccessAvailable: true,
          mediaAccessReason: isLive
            ? "Live HLS streaming supported directly."
            : "Direct media scraping active via yt-dlp & FFmpeg. No manual upload required.",
        },
        isLiveStream: isLive,
        canLiveIngest: isLive,
        ingestion: {
          providerId: isLive ? "live_hls_stream" : directIngestion.id,
          providerName: isLive
            ? "Live Stream Ingest (Rolling HLS + Audio-First + Chat Velocity)"
            : directIngestion.displayName,
          requiresUserUpload: false,
          directAccessAllowed: true,
          reason: isLive
            ? "Live stream detected. ClipForge monitors rolling audio chunks and live chat velocity spikes in real time."
            : "Direct media scraping active. Highlights will be scraped and generated automatically from this video link.",
        },
      });
    }

    // Non-YouTube media (Twitch VOD, Kick, Podcast link, direct media)
    const isDirectAudio = /\.(mp3|m4a|aac|ogg|wav|flac)(\?.*)?$/i.test(url);
    const domain = new URL(parsed.canonicalUrl).hostname;

    return NextResponse.json({
      parsed,
      metadata: {
        videoId: parsed.videoId,
        canonicalUrl: parsed.canonicalUrl,
        title: isDirectAudio
          ? `Podcast / Audio Episode (${parsed.videoId})`
          : `${domain} Stream / Video (${parsed.videoId})`,
        channelTitle: domain,
        thumbnailUrl: isDirectAudio
          ? "https://images.unsplash.com/photo-1590602847861-f357a9332bbc?w=640&q=80"
          : "https://images.unsplash.com/photo-1542751371-adc38448a05e?w=640&q=80",
        durationSec: null,
        streamType: isDirectAudio ? "regular_video" : "archived_stream",
        metadataSource: "none",
        notice: isDirectAudio
          ? "Audio podcast detected. ClipForge will scrape the audio, synthesize a 9:16 canvas, and extract speech highlights automatically."
          : `Media source from ${domain} detected. yt-dlp direct scraping and clipping active.`,
        mediaAccessAvailable: true,
        mediaAccessReason: "Direct media scraping active via yt-dlp & FFmpeg. No manual file upload required.",
      },
      isLiveStream: false,
      canLiveIngest: false,
      ingestion: {
        providerId: directIngestion.id,
        providerName: directIngestion.displayName,
        requiresUserUpload: false,
        directAccessAllowed: true,
        reason: "Direct media scraping active. Clips will be extracted directly from this URL without requiring manual file uploads.",
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/youtube/inspect" });
  }
}
