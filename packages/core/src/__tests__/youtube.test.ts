import { describe, it, expect } from "vitest";
import {
  parseIso8601Duration,
  parseYouTubeUrl,
  YouTubeUrlValidationError,
} from "../youtube.js";

describe("YouTube URL parsing & validation", () => {
  it("parses standard watch URLs with extra query parameters", () => {
    const res = parseYouTubeUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123",
    );
    expect(res.videoId).toBe("dQw4w9WgXcQ");
    expect(res.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.inputKind).toBe("watch");
  });

  it("parses youtu.be short links, mobile URLs, live URLs, shorts, and embeds", () => {
    expect(parseYouTubeUrl("https://youtu.be/abcDEF_1234").videoId).toBe("abcDEF_1234");
    expect(parseYouTubeUrl("https://m.youtube.com/watch?v=abcDEF_1234").videoId).toBe(
      "abcDEF_1234",
    );
    expect(parseYouTubeUrl("https://www.youtube.com/live/xyz98765432").inputKind).toBe(
      "live",
    );
    expect(parseYouTubeUrl("https://youtube.com/shorts/xyz98765432").inputKind).toBe(
      "shorts",
    );
    expect(parseYouTubeUrl("https://www.youtube.com/embed/xyz98765432").inputKind).toBe(
      "embed",
    );
    expect(parseYouTubeUrl("youtube.com/watch?v=xyz98765432").videoId).toBe(
      "xyz98765432",
    );
  });

  it("rejects non-YouTube domains, channels, playlists, and malformed video IDs", () => {
    expect(() => parseYouTubeUrl("")).toThrow(YouTubeUrlValidationError);
    expect(() => parseYouTubeUrl("not a url at all")).toThrow(YouTubeUrlValidationError);
    expect(() => parseYouTubeUrl("https://vimeo.com/123456789")).toThrow(
      YouTubeUrlValidationError,
    );
    expect(() => parseYouTubeUrl("https://www.youtube.com/@shroud")).toThrow(
      YouTubeUrlValidationError,
    );
    expect(() =>
      parseYouTubeUrl("https://www.youtube.com/playlist?list=PL12345"),
    ).toThrow(YouTubeUrlValidationError);
    expect(() =>
      parseYouTubeUrl("https://www.youtube.com/watch?v=short"),
    ).toThrow(YouTubeUrlValidationError);
  });

  it("parses ISO 8601 durations cleanly", () => {
    expect(parseIso8601Duration("PT1H2M30S")).toBe(3750);
    expect(parseIso8601Duration("PT45S")).toBe(45);
    expect(parseIso8601Duration("PT12M")).toBe(720);
    expect(parseIso8601Duration("INVALID")).toBeNull();
    expect(parseIso8601Duration(null)).toBeNull();
  });
});
