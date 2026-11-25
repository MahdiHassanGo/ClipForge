import type {
  CaptionCue,
  CaptionStyle,
  ExportPreset,
  TranscriptSegmentData,
} from "./types.js";

export interface ExportPresetSpec {
  id: ExportPreset;
  label: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: string;
  audioBitrate: string;
  maxRecommendedSec: number;
  /** Safe margins in 1080x1920 pixel space to avoid platform UI buttons/captions */
  safeMarginBottomPx: number;
  safeMarginTopPx: number;
  safeMarginRightPx: number;
  safeMarginLeftPx: number;
}

export const EXPORT_PRESETS: Readonly<Record<ExportPreset, ExportPresetSpec>> = {
  youtube_shorts: {
    id: "youtube_shorts",
    label: "YouTube Shorts",
    description: "1080×1920 · 30/60fps · H.264 High · Safe margins for Shorts UI",
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: "8M",
    audioBitrate: "192k",
    maxRecommendedSec: 60,
    safeMarginBottomPx: 380,
    safeMarginTopPx: 180,
    safeMarginRightPx: 140,
    safeMarginLeftPx: 70,
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    description: "1080×1920 · 30fps · H.264 · Extra bottom & right clearance for TikTok overlays",
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: "8M",
    audioBitrate: "192k",
    maxRecommendedSec: 60,
    safeMarginBottomPx: 440,
    safeMarginTopPx: 200,
    safeMarginRightPx: 160,
    safeMarginLeftPx: 70,
  },
  instagram_reels: {
    id: "instagram_reels",
    label: "Instagram Reels",
    description: "1080×1920 · 30fps · H.264 · Balanced safe margins for Reels HUD",
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: "7M",
    audioBitrate: "192k",
    maxRecommendedSec: 90,
    safeMarginBottomPx: 410,
    safeMarginTopPx: 210,
    safeMarginRightPx: 145,
    safeMarginLeftPx: 70,
  },
};

export const SUPPORTED_CAPTION_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "bn_en", label: "Banglish (Romanized Bangla)" },
  { code: "bn", label: "Bangla (বাংলা)" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" },
  { code: "auto", label: "Auto-detect" },
] as const;

/**
 * Builds short, readable synced caption cues for a clip range from word-level or segment-level transcript data.
 * Never fabricates words; preserves low-confidence / needsReview flags honestly.
 */
export function buildCaptionCuesForRange(
  segments: TranscriptSegmentData[],
  clipStartSec: number,
  clipEndSec: number,
  maxWordsPerCue = 5,
  maxCharsPerCue = 34,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cueCounter = 0;

  const overlapping = segments.filter(
    (seg) => seg.endSec > clipStartSec && seg.startSec < clipEndSec,
  );

  for (const seg of overlapping) {
    if (seg.words && seg.words.length > 0) {
      let chunkWords: typeof seg.words = [];
      let chunkLen = 0;

      const flushChunk = () => {
        if (chunkWords.length === 0) return;
        const first = chunkWords[0]!;
        const last = chunkWords[chunkWords.length - 1]!;
        const startSec = Math.max(clipStartSec, first.startSec);
        const endSec = Math.min(clipEndSec, Math.max(last.endSec, startSec + 0.35));
        if (endSec <= startSec) {
          chunkWords = [];
          chunkLen = 0;
          return;
        }
        const avgConf =
          chunkWords.reduce((sum, w) => sum + w.confidence, 0) / chunkWords.length;
        const needsReview =
          seg.needsReview ||
          seg.lowConfidence ||
          chunkWords.some((w) => w.lowConfidence) ||
          avgConf < 0.65;

        cues.push({
          id: `cue_${++cueCounter}`,
          startSec: round2(startSec),
          endSec: round2(endSec),
          text: chunkWords.map((w) => w.word).join(" ").trim(),
          confidence: round2(avgConf),
          needsReview,
        });
        chunkWords = [];
        chunkLen = 0;
      };

      for (const word of seg.words) {
        if (word.endSec <= clipStartSec || word.startSec >= clipEndSec) continue;
        const nextLen = chunkLen + (chunkLen > 0 ? 1 : 0) + word.word.length;
        const hasPause =
          chunkWords.length > 0 &&
          word.startSec - chunkWords[chunkWords.length - 1]!.endSec > 0.6;

        if (
          chunkWords.length >= maxWordsPerCue ||
          (chunkWords.length > 0 && nextLen > maxCharsPerCue) ||
          hasPause
        ) {
          flushChunk();
        }
        chunkWords.push(word);
        chunkLen += (chunkLen > 0 ? 1 : 0) + word.word.length;

        if (/[.!?]$/.test(word.word)) {
          flushChunk();
        }
      }
      flushChunk();
    } else {
      const startSec = Math.max(clipStartSec, seg.startSec);
      const endSec = Math.min(clipEndSec, Math.max(seg.endSec, startSec + 0.5));
      if (endSec > startSec && seg.text.trim().length > 0) {
        cues.push({
          id: `cue_${++cueCounter}`,
          startSec: round2(startSec),
          endSec: round2(endSec),
          text: seg.text.trim(),
          confidence: round2(seg.confidence),
          needsReview: seg.needsReview || seg.lowConfidence || seg.confidence < 0.65,
        });
      }
    }
  }

  return cues;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatAssTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const hours = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const centis = Math.floor((clamped - Math.floor(clamped)) * 100);
  return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function getAssStyleDefinition(
  style: CaptionStyle,
  preset: ExportPresetSpec,
): string {
  // ASS colors are &HAABBGGRR (alpha 00 = opaque, FF = transparent)
  const marginV = preset.safeMarginBottomPx;
  const marginL = preset.safeMarginLeftPx;
  const marginR = preset.safeMarginRightPx;

  switch (style) {
    case "bold_gaming":
      // High-impact bold white/yellowish pop with thick dark outline & soft drop shadow
      return `Style: Default,Arial,62,&H00FFFFFF,&H0000D7FF,&H00121212,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,2,${marginL},${marginR},${marginV},1`;
    case "clean_minimal":
      // Crisp sans-serif with subtle outline and clean shadow
      return `Style: Default,Helvetica,52,&H00F8FAFC,&H00FFFFFF,&H000F172A,&H66000000,0,0,0,0,100,100,0,0,1,3,2,2,${marginL},${marginR},${marginV},1`;
    case "boxed_high_contrast":
      // BorderStyle=3 draws an opaque background box behind captions for busy HUD gameplay
      return `Style: Default,Arial,54,&H00FFFFFF,&H0000FFFF,&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,3,12,0,2,${marginL},${marginR},${marginV},1`;
  }
}

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle file relative to clipStartSec.
 * Respects platform-specific safe zones so captions never collide with Shorts/TikTok/Reels overlays.
 */
export function generateAssSubtitles(params: {
  cues: CaptionCue[];
  clipStartSec: number;
  clipEndSec: number;
  style: CaptionStyle;
  preset: ExportPreset;
}): string {
  const spec = EXPORT_PRESETS[params.preset];
  const styleLine = getAssStyleDefinition(params.style, spec);

  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${spec.width}`,
    `PlayResY: ${spec.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const clipDuration = Math.max(0.1, params.clipEndSec - params.clipStartSec);
  const sorted = [...params.cues].sort((a, b) => a.startSec - b.startSec);

  for (const cue of sorted) {
    const text = cue.text.trim();
    if (!text) continue;

    // Skip explicit unedited placeholder notices so we never burn instructions onto final video
    if (text.startsWith("[Speech activity detected")) continue;

    const relStart = Math.max(0, cue.startSec - params.clipStartSec);
    const relEnd = Math.min(clipDuration, cue.endSec - params.clipStartSec);
    if (relEnd <= relStart + 0.05) continue;

    const displayText =
      params.style === "bold_gaming" ? text.toUpperCase() : text;

    lines.push(
      `Dialogue: 0,${formatAssTime(relStart)},${formatAssTime(relEnd)},Default,,0,0,0,,${escapeAssText(displayText)}`,
    );
  }

  return lines.join("\n") + "\n";
}
