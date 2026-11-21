import { describe, it, expect } from "vitest";
import { parseVttSubtitles } from "../vtt-parser.js";

describe("VTT Subtitle & Auto-Caption Parser", () => {
  it("parses standard WebVTT subtitles with start and end timestamps", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world, welcome to the stream!

00:00:04.000 --> 00:00:07.000
Today we are beating the final boss.
`;

    const segments = parseVttSubtitles(vtt);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.startSec).toBe(1);
    expect(segments[0]?.endSec).toBe(3.5);
    expect(segments[0]?.text).toBe("Hello world, welcome to the stream!");
    expect(segments[0]?.words.length).toBeGreaterThan(0);
    expect(segments[1]?.startSec).toBe(4);
    expect(segments[1]?.endSec).toBe(7);
  });

  it("extracts word-level timestamps from YouTube-style inline VTT tags", () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

00:00:02.720 --> 00:00:05.910
Hey<00:00:04.240><c> there.</c><00:00:04.560><c> Looking</c><00:00:04.799><c> for</c><00:00:04.960><c> a</c><00:00:05.200><c> taxi?</c>
`;

    const segments = parseVttSubtitles(vtt);
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.words.length).toBe(6);
    expect(seg.words[0]?.word).toBe("Hey");
    expect(seg.words[0]?.startSec).toBe(2.72);
    expect(seg.words[0]?.endSec).toBe(4.24);
    expect(seg.words[1]?.word).toBe("there.");
    expect(seg.words[1]?.startSec).toBe(4.24);
    expect(seg.words[1]?.endSec).toBe(4.56);
  });

  it("deduplicates rolling duplicate cues from live streams", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Let's go guys

00:00:02.000 --> 00:00:04.000
Let's go guys this is insane!
`;

    const segments = parseVttSubtitles(vtt);
    // Should collapse or expand superset rather than duplicate
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("Let's go guys this is insane!");
    expect(segments[0]?.endSec).toBe(4);
  });
});
