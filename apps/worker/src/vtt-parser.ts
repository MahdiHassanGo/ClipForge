import type { TranscriptSegmentData, TranscriptWord } from "@clipforge/core";

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

export function parseVttTimestamp(timestampStr: string): number {
  const parts = timestampStr.trim().split(":");
  if (parts.length === 3) {
    const hours = parseFloat(parts[0] ?? "0") || 0;
    const minutes = parseFloat(parts[1] ?? "0") || 0;
    const seconds = parseFloat(parts[2] ?? "0") || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0] ?? "0") || 0;
    const seconds = parseFloat(parts[1] ?? "0") || 0;
    return minutes * 60 + seconds;
  }
  return 0;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Parses WebVTT subtitle text (such as YouTube auto-generated captions or standard VTT files)
 * into structured TranscriptSegmentData[] with word-level timestamps and deduplicated cues.
 */
export function parseVttSubtitles(
  vttContent: string,
  defaultLanguage = "en",
): TranscriptSegmentData[] {
  const lines = vttContent.split(/\r?\n/);
  const rawCues: Array<{
    startSec: number;
    endSec: number;
    rawText: string;
  }> = [];

  let currentStart: number | null = null;
  let currentEnd: number | null = null;
  let currentTextLines: string[] = [];

  const timeRegex =
    /^(?:(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3}))\s+-->\s+(?:(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3}))/;

  const flushCue = () => {
    if (currentStart !== null && currentEnd !== null && currentTextLines.length > 0) {
      const combined = currentTextLines.join(" ").trim();
      if (combined) {
        rawCues.push({
          startSec: currentStart,
          endSec: Math.max(currentEnd, currentStart + 0.1),
          rawText: combined,
        });
      }
    }
    currentStart = null;
    currentEnd = null;
    currentTextLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.startsWith("NOTE") ||
      /^\d+$/.test(line)
    ) {
      continue;
    }

    const timeMatch = timeRegex.exec(line);
    if (timeMatch) {
      flushCue();
      currentStart = parseVttTimestamp(timeMatch[1] ?? "0");
      currentEnd = parseVttTimestamp(timeMatch[2] ?? "0");
      continue;
    }

    if (currentStart !== null) {
      currentTextLines.push(line);
    }
  }
  flushCue();

  if (rawCues.length === 0) {
    return [];
  }

  const segments: TranscriptSegmentData[] = [];
  let previousNormalizedText = "";

  for (const cue of rawCues) {
    // Strip styling tags while preserving inline timestamps
    const textWithoutStyle = cue.rawText
      .replace(/<\/?c(?:\.[a-zA-Z0-9_-]+)?>/g, "")
      .replace(/<\/?v(?:\.[a-zA-Z0-9_-]+)?>/g, "")
      .replace(/<[^>]+style[^>]*>/g, "");

    const decoded = decodeHtmlEntities(textWithoutStyle);

    // Split by inline timing tags: <00:00:04.240>
    const parts = decoded.split(/<(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})>/);
    const words: TranscriptWord[] = [];
    let currentTime = cue.startSec;

    for (let i = 0; i < parts.length; i += 2) {
      const textChunk = (parts[i] ?? "").replace(/<[^>]+>/g, "").trim();
      const nextTimeStr = parts[i + 1];
      const nextTime = nextTimeStr ? parseVttTimestamp(nextTimeStr) : cue.endSec;

      if (textChunk) {
        const subWords = textChunk.split(/\s+/).filter(Boolean);
        const validWords = subWords.filter((w) => w !== ">>");
        const totalDuration = Math.max(0.1, nextTime - currentTime);
        const step = totalDuration / Math.max(1, validWords.length);

        for (let j = 0; j < validWords.length; j++) {
          const wStart = currentTime + j * step;
          const wEnd = currentTime + (j + 1) * step;
          words.push({
            word: validWords[j]!,
            startSec: round2(wStart),
            endSec: round2(wEnd),
            confidence: 0.95,
            lowConfidence: false,
          });
        }
      }

      if (nextTimeStr) {
        currentTime = nextTime;
      }
    }

    const cleanSegmentText = words.map((w) => w.word).join(" ").trim();
    if (!cleanSegmentText) continue;

    // Deduplicate rolling captions (YouTube often outputs: "A" then "A B" then "B C")
    const normCurrent = cleanSegmentText.toLowerCase();
    if (normCurrent === previousNormalizedText) {
      continue;
    }

    if (
      segments.length > 0 &&
      previousNormalizedText &&
      normCurrent.startsWith(previousNormalizedText)
    ) {
      const lastSeg = segments[segments.length - 1]!;
      lastSeg.endSec = round2(cue.endSec);
      lastSeg.text = cleanSegmentText;
      lastSeg.words = words;
      previousNormalizedText = normCurrent;
      continue;
    }

    previousNormalizedText = normCurrent;
    segments.push({
      index: segments.length,
      startSec: round2(cue.startSec),
      endSec: round2(cue.endSec),
      text: cleanSegmentText,
      language: defaultLanguage,
      confidence: 0.95,
      lowConfidence: false,
      needsReview: false,
      words,
    });
  }

  // Renumber indices
  for (let i = 0; i < segments.length; i++) {
    segments[i]!.index = i;
  }

  return segments;
}
