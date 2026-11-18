import { describe, it, expect } from "vitest";
import { validateCandidateBounds, updateCandidateSchema } from "../schemas.js";
import { DefaultClipScoringProvider } from "../scoring.js";
import { buildCaptionCuesForRange, generateAssSubtitles } from "../captions.js";

describe("Candidate validation, multimodal scoring & synced captions", () => {
  it("validates candidate start/end bounds against source video duration", () => {
    expect(
      validateCandidateBounds({
        startSec: 10,
        endSec: 45,
        mediaDurationSec: 120,
      }),
    ).toEqual({ valid: true });

    const tooShort = validateCandidateBounds({
      startSec: 10,
      endSec: 11.5,
      mediaDurationSec: 120,
    });
    expect(tooShort.valid).toBe(false);

    const pastEnd = validateCandidateBounds({
      startSec: 100,
      endSec: 130,
      mediaDurationSec: 120,
    });
    expect(pastEnd.valid).toBe(false);

    const parsed = updateCandidateSchema.safeParse({
      startSec: 20,
      endSec: 21,
    });
    expect(parsed.success).toBe(false);
  });

  it("ranks synchronized clutch moments higher than constant noise and preserves setup + reaction boundaries", () => {
    const scorer = new DefaultClipScoringProvider();
    const durationSec = 180;

    // Simulate 180s timeline:
    // - 10..40s: flat constant game noise (reactionScore low)
    // - 95..112s: clutch moment with silence-to-burst, high motion, scene cut, and hype commentary
    const audioTimeline = Array.from({ length: durationSec }, (_, second) => ({
      second,
      rmsDb: second >= 10 && second <= 40 ? -15 : second >= 100 && second <= 108 ? -12 : -34,
      peakDb: second >= 100 && second <= 108 ? -2 : -22,
      reactionScore: second >= 100 && second <= 108 ? 0.9 : 0.15,
      isSilenceToBurst: second === 100,
    }));

    const motionTimeline = Array.from({ length: durationSec }, (_, second) => ({
      second,
      motionScore: second >= 97 && second <= 108 ? 0.88 : 0.2,
      sceneCut: second === 101 || second === 105,
    }));

    const transcriptSegments = [
      {
        index: 0,
        startSec: 88,
        endSec: 94,
        text: "Wait watch this, it's a 1v3 clutch setup.",
        language: "en",
        confidence: 0.94,
        lowConfidence: false,
        needsReview: false,
        words: [
          { word: "Wait", startSec: 88, endSec: 89, confidence: 0.95, lowConfidence: false },
          { word: "watch", startSec: 89, endSec: 90, confidence: 0.95, lowConfidence: false },
          { word: "this,", startSec: 90, endSec: 91, confidence: 0.94, lowConfidence: false },
          { word: "1v3", startSec: 91.5, endSec: 92.5, confidence: 0.94, lowConfidence: false },
          { word: "clutch!", startSec: 92.5, endSec: 94, confidence: 0.93, lowConfidence: false },
        ],
      },
      {
        index: 1,
        startSec: 100,
        endSec: 107,
        text: "NO WAY! Let's go! We actually won that!",
        language: "en",
        confidence: 0.92,
        lowConfidence: false,
        needsReview: false,
        words: [
          { word: "NO", startSec: 100, endSec: 101, confidence: 0.92, lowConfidence: false },
          { word: "WAY!", startSec: 101, endSec: 102.5, confidence: 0.92, lowConfidence: false },
          { word: "Let's", startSec: 103, endSec: 104, confidence: 0.91, lowConfidence: false },
          { word: "go!", startSec: 104, endSec: 105, confidence: 0.91, lowConfidence: false },
          { word: "We", startSec: 105.2, endSec: 105.8, confidence: 0.92, lowConfidence: false },
          { word: "won!", startSec: 105.8, endSec: 107, confidence: 0.92, lowConfidence: false },
        ],
      },
      {
        index: 2,
        startSec: 112,
        endSec: 118,
        text: "That was unbelievable, chat.",
        language: "en",
        confidence: 0.52,
        lowConfidence: true,
        needsReview: true,
        words: [],
      },
    ];

    const drafts = scorer.generateCandidates({
      probe: {
        durationSec,
        width: 1920,
        height: 1080,
        fps: 60,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      transcriptSegments,
      audioTimeline,
      motionTimeline,
      sceneEvents: [
        { timestampSec: 100, type: "silence_to_burst", score: 0.95 },
        { timestampSec: 101, type: "scene_cut", score: 0.85 },
        { timestampSec: 103, type: "motion_burst", score: 0.9 },
      ],
      faceCam: {
        detected: true,
        region: {
          x: 0.02,
          y: 0.72,
          width: 0.23,
          height: 0.24,
          corner: "bottom_left",
          confidence: 0.86,
          enabled: true,
        },
        method: "test",
      },
      config: {
        minClipSec: 20,
        maxClipSec: 60,
        targetClipSec: 35,
        scoreThreshold: 0.45,
        maxCandidates: 5,
        captionLanguage: "en",
      },
    });

    expect(drafts.length).toBeGreaterThan(0);
    const top = drafts[0]!;
    // Must center on the clutch play (~85..120s), preserving setup before 100s and reaction after 107s
    expect(top.startSec).toBeLessThan(95);
    expect(top.endSec).toBeGreaterThan(107);
    expect(top.endSec - top.startSec).toBeGreaterThanOrEqual(20);
    expect(top.endSec - top.startSec).toBeLessThanOrEqual(60);
    expect(top.layoutMode).toBe("split_cam_top");
    expect(top.reason.length).toBeGreaterThan(20);

    // Captions should flag low-confidence segments for review
    const cues = buildCaptionCuesForRange(transcriptSegments, 85, 120);
    expect(cues.some((c) => c.needsReview)).toBe(true);
    expect(cues.some((c) => !c.needsReview)).toBe(true);

    // ASS generation should offset times relative to clipStartSec and respect platform safe margins
    const ass = generateAssSubtitles({
      cues,
      clipStartSec: 85,
      clipEndSec: 120,
      style: "bold_gaming",
      preset: "tiktok",
    });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("Dialogue:");
  });
});
