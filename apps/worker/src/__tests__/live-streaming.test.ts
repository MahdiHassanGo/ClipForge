import { describe, it, expect } from "vitest";
import { computeLiveChatVelocity, type LiveChatMessage } from "../live-chat-monitor.js";
import { resolveLiveManifest } from "../live-manifest-resolver.js";

describe("Live Stream Ingestion & Chat Velocity Analysis", () => {
  it("resolves direct .m3u8 HLS manifests without external tool requirement", async () => {
    const directHls = "https://cdn.example.com/live/stream/playlist.m3u8";
    const result = await resolveLiveManifest(directHls);

    expect(result.isLive).toBe(true);
    expect(result.sourceType).toBe("hls");
    expect(result.videoManifestUrl).toBe(directHls);
    expect(result.audioManifestUrl).toBe(directHls);
  });

  it("rejects non-live non-stream URLs gracefully", async () => {
    await expect(resolveLiveManifest("https://example.com/not-a-stream.html")).rejects.toThrow(
      /Unsupported stream format/i,
    );
  });

  it("calculates chat velocity and generates chat_velocity_spike event on surge", () => {
    const now = Date.now();
    const messages: LiveChatMessage[] = [];

    // 0..20s: Baseline chat (1 message every 4 seconds = 0.25 MPS)
    for (let t = 0; t < 20; t += 4) {
      messages.push({
        timestampMs: now + t * 1000,
        author: `viewer_${t}`,
        text: "hello streamer",
        isHype: false,
      });
    }

    // 20..25s: Massive spike (30 messages in 5 seconds = 6 MPS, with W, LMAO, NO WAY)
    for (let i = 0; i < 30; i++) {
      messages.push({
        timestampMs: now + 20_000 + i * 150,
        author: `hype_fan_${i}`,
        text: i % 2 === 0 ? "W CLUTCH NO WAY" : "LMAOOOO INSANE",
        isHype: true,
      });
    }

    // 25..40s: Cooldown (1 message every 3 seconds)
    for (let t = 26; t < 40; t += 3) {
      messages.push({
        timestampMs: now + t * 1000,
        author: `viewer_after_${t}`,
        text: "that was crazy",
        isHype: false,
      });
    }

    const snapshot = computeLiveChatVelocity(messages, 40);

    expect(snapshot.messages.length).toBe(messages.length);
    expect(snapshot.peakMps).toBeGreaterThanOrEqual(5.0);
    expect(snapshot.events.length).toBeGreaterThan(0);

    const spikeEvent = snapshot.events.find((e) => e.type === "chat_velocity_spike");
    expect(spikeEvent).toBeDefined();
    expect(spikeEvent!.score).toBeGreaterThan(0.6);
    expect(spikeEvent!.metadata?.mps).toBeGreaterThan(3.0);
    expect(spikeEvent!.metadata?.hypeRatio).toBeGreaterThan(0.5);
  });

  it("handles empty chat cleanly", () => {
    const snapshot = computeLiveChatVelocity([]);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.velocityPoints).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.averageMps).toBe(0);
    expect(snapshot.peakMps).toBe(0);
  });
});
