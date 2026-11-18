import type { StreamType, YouTubeMetadataResult, YouTubeParsedUrl } from "./types.js";

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

const SUPPORTED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export class YouTubeUrlValidationError extends Error {
  readonly code = "INVALID_YOUTUBE_URL";
  constructor(message: string) {
    super(message);
    this.name = "YouTubeUrlValidationError";
  }
}

/**
 * Strictly validates supported YouTube URL formats and extracts the 11-char video ID.
 * Rejects malformed URLs, playlists without video IDs, channels, and non-YouTube domains.
 */
export function parseYouTubeUrl(rawInput: string): YouTubeParsedUrl {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new YouTubeUrlValidationError("Please paste a YouTube video URL.");
  }

  let parsed: URL;
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(normalized);
  } catch {
    throw new YouTubeUrlValidationError(
      "That doesn't look like a valid URL. Example: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new YouTubeUrlValidationError("Only http:// and https:// YouTube URLs are supported.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!SUPPORTED_HOSTS.has(host)) {
    throw new YouTubeUrlValidationError(
      `Unsupported host '${host}'. Please paste a youtube.com or youtu.be video URL.`,
    );
  }

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;
  let inputKind: YouTubeParsedUrl["inputKind"] = "watch";

  if (host === "youtu.be" || host === "www.youtu.be") {
    videoId = pathSegments[0] ?? null;
    inputKind = "short_link";
  } else if (parsed.pathname === "/watch") {
    videoId = parsed.searchParams.get("v");
    inputKind = "watch";
  } else if (pathSegments[0] === "live" && pathSegments[1]) {
    videoId = pathSegments[1];
    inputKind = "live";
  } else if (pathSegments[0] === "shorts" && pathSegments[1]) {
    videoId = pathSegments[1];
    inputKind = "shorts";
  } else if (pathSegments[0] === "embed" && pathSegments[1]) {
    videoId = pathSegments[1];
    inputKind = "embed";
  } else if (pathSegments[0] === "playlist" || parsed.searchParams.has("list")) {
    throw new YouTubeUrlValidationError(
      "Playlist URLs without a specific video ID are not supported. Paste a single video URL instead.",
    );
  } else if (
    pathSegments[0]?.startsWith("@") ||
    pathSegments[0] === "channel" ||
    pathSegments[0] === "c" ||
    pathSegments[0] === "user"
  ) {
    throw new YouTubeUrlValidationError(
      "Channel URLs are not supported. Please paste a specific YouTube video or stream URL.",
    );
  }

  if (!videoId || !YOUTUBE_VIDEO_ID_REGEX.test(videoId)) {
    throw new YouTubeUrlValidationError(
      "Could not extract a valid 11-character YouTube video ID from this URL.",
    );
  }

  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    inputKind,
  };
}

/**
 * Parses ISO 8601 duration strings returned by YouTube Data API v3 (e.g. PT1H12M34S).
 */
export function parseIso8601Duration(duration: string | undefined | null): number | null {
  if (!duration) return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(duration);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}

export interface YouTubeMetadataProvider {
  fetchMetadata(parsed: YouTubeParsedUrl): Promise<YouTubeMetadataResult>;
}

const MEDIA_ACCESS_REASON =
  "YouTube URLs provide metadata only. ClipForge never scrapes or downloads YouTube videos. Upload your authorized video file (recording/VOD export) below to analyze and clip.";

interface YouTubeDataApiResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      channelTitle?: string;
      liveBroadcastContent?: "live" | "upcoming" | "none";
      thumbnails?: {
        maxres?: { url?: string };
        high?: { url?: string };
        medium?: { url?: string };
        default?: { url?: string };
      };
    };
    contentDetails?: {
      duration?: string;
    };
    liveStreamingDetails?: {
      actualStartTime?: string;
      actualEndTime?: string;
      scheduledStartTime?: string;
    };
  }>;
}

interface YouTubeOEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

export class OfficialYouTubeMetadataProvider implements YouTubeMetadataProvider {
  private readonly apiKey?: string;

  constructor(apiKey = process.env.YOUTUBE_API_KEY) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  async fetchMetadata(parsed: YouTubeParsedUrl): Promise<YouTubeMetadataResult> {
    if (this.apiKey) {
      const apiResult = await this.fetchViaDataApi(parsed, this.apiKey);
      if (apiResult) return apiResult;
    }

    const oembedResult = await this.fetchViaOEmbed(parsed);
    if (oembedResult) return oembedResult;

    return {
      videoId: parsed.videoId,
      canonicalUrl: parsed.canonicalUrl,
      title: null,
      channelTitle: null,
      thumbnailUrl: `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`,
      durationSec: null,
      streamType: parsed.inputKind === "live" ? "live_stream" : "unknown",
      metadataSource: "none",
      notice: this.apiKey
        ? "Video metadata could not be retrieved from YouTube APIs (it may be private, unlisted, or unavailable). You can still upload your authorized video file to analyze it."
        : "YOUTUBE_API_KEY is not configured and oEmbed lookup was unavailable. Video ID was validated; upload your authorized source file to proceed.",
      mediaAccessAvailable: false,
      mediaAccessReason: MEDIA_ACCESS_REASON,
    };
  }

  private async fetchViaDataApi(
    parsed: YouTubeParsedUrl,
    apiKey: string,
  ): Promise<YouTubeMetadataResult | null> {
    try {
      const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
      endpoint.searchParams.set("part", "snippet,contentDetails,liveStreamingDetails");
      endpoint.searchParams.set("id", parsed.videoId);
      endpoint.searchParams.set("key", apiKey);

      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as YouTubeDataApiResponse;
      const item = data.items?.[0];
      if (!item) return null;

      const snippet = item.snippet;
      const liveDetails = item.liveStreamingDetails;
      let streamType: StreamType = "regular_video";

      if (snippet?.liveBroadcastContent === "live") {
        streamType = "live_stream";
      } else if (snippet?.liveBroadcastContent === "upcoming") {
        streamType = "upcoming_stream";
      } else if (liveDetails?.actualStartTime && liveDetails?.actualEndTime) {
        streamType = "archived_stream";
      } else if (liveDetails?.actualStartTime) {
        streamType = "live_stream";
      }

      const thumb =
        snippet?.thumbnails?.maxres?.url ??
        snippet?.thumbnails?.high?.url ??
        snippet?.thumbnails?.medium?.url ??
        snippet?.thumbnails?.default?.url ??
        `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`;

      return {
        videoId: parsed.videoId,
        canonicalUrl: parsed.canonicalUrl,
        title: snippet?.title ?? null,
        channelTitle: snippet?.channelTitle ?? null,
        thumbnailUrl: thumb,
        durationSec: parseIso8601Duration(item.contentDetails?.duration),
        streamType,
        metadataSource: "youtube_data_api",
        notice:
          streamType === "live_stream"
            ? "Detected active YouTube live stream via YouTube Data API v3. Upload your local recording or stream archive to analyze."
            : streamType === "archived_stream"
              ? "Detected archived YouTube live stream via YouTube Data API v3. Upload your authorized VOD file to analyze."
              : "Metadata retrieved via YouTube Data API v3. Upload your authorized video file to begin analysis.",
        mediaAccessAvailable: false,
        mediaAccessReason: MEDIA_ACCESS_REASON,
      };
    } catch {
      return null;
    }
  }

  private async fetchViaOEmbed(
    parsed: YouTubeParsedUrl,
  ): Promise<YouTubeMetadataResult | null> {
    try {
      const endpoint = new URL("https://www.youtube.com/oembed");
      endpoint.searchParams.set("url", parsed.canonicalUrl);
      endpoint.searchParams.set("format", "json");

      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as YouTubeOEmbedResponse;
      return {
        videoId: parsed.videoId,
        canonicalUrl: parsed.canonicalUrl,
        title: data.title ?? null,
        channelTitle: data.author_name ?? null,
        thumbnailUrl:
          data.thumbnail_url ?? `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`,
        durationSec: null,
        streamType: parsed.inputKind === "live" ? "live_stream" : "unknown",
        metadataSource: "oembed",
        notice:
          "Metadata loaded via official YouTube oEmbed. Configure YOUTUBE_API_KEY in .env to detect live vs. archived streams and duration.",
        mediaAccessAvailable: false,
        mediaAccessReason: MEDIA_ACCESS_REASON,
      };
    } catch {
      return null;
    }
  }
}
