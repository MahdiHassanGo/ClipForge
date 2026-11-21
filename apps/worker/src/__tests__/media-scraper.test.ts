import { describe, it, expect } from "vitest";
import { resolveYtDlpPath } from "../live-manifest-resolver.js";
import { resolveFfmpegPath, resolveFfprobePath } from "../ffmpeg-binaries.js";
import { DirectScrapeIngestionProvider } from "@clipforge/core";

describe("Direct Media Ingestion & Scraper Verification", () => {
  it("resolves yt-dlp binary for media scraping", () => {
    const ytdlp = resolveYtDlpPath();
    expect(ytdlp).toBeDefined();
    expect(typeof ytdlp).toBe("string");
    expect(ytdlp!.length).toBeGreaterThan(0);
  });

  it("resolves ffmpeg and ffprobe binaries for media synthesis", () => {
    const ffmpeg = resolveFfmpegPath();
    const ffprobe = resolveFfprobePath();
    expect(ffmpeg).toBeDefined();
    expect(ffprobe).toBeDefined();
  });

  it("provides DirectScrapeIngestionProvider with zero user upload requirement", async () => {
    const provider = new DirectScrapeIngestionProvider();
    expect(provider.id).toBe("direct_scrape");
    expect(provider.requiresUserUpload).toBe(false);

    const check = await provider.canIngestDirectly("https://www.youtube.com/watch?v=sample");
    expect(check.allowed).toBe(true);
    expect(check.reason).toContain("Direct media scraping active");
  });
});
