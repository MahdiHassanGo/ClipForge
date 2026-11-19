import { buildCaptionCuesForRange } from "./captions.js";
import type { ClipScoringInput, ClipScoringProvider } from "./providers.js";
import type {
  CandidateClipDraft,
  LayoutMode,
  SignalBreakdown,
  TranscriptSegmentData,
} from "./types.js";

const HYPE_PATTERNS: ReadonlyArray<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(clutch|ace|1v[2-5]|team\s*wipe|squad\s*wipe|pentakill|quadra|triple)\b/i, weight: 0.95, label: "clutch play callout" },
  { pattern: /\b(no\s*way|what\s*the|insane|unbelievable|impossible|bro\s*what|oh\s*my\s*god|omg)\b/i, weight: 0.85, label: "disbelief reaction" },
  { pattern: /\b(let'?s\s*go|we\s*win|victory|gg|huge|massive|clean|nasty|crazy)\b/i, weight: 0.75, label: "celebration reaction" },
  { pattern: /\b(headshot|one\s*tap|flick|snipe|boss|defeat|kill|eliminated|checkmate)\b/i, weight: 0.7, label: "key gameplay callout" },
  { pattern: /\b(wait|watch\s*this|hold\s*on|look\s*at|here\s*he\s*comes|behind\s*you)\b/i, weight: 0.55, label: "anticipation setup" },
  { pattern: /[!?]{1,3}/, weight: 0.35, label: "emphatic delivery" },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface SecondSignal {
  second: number;
  speechScore: number;
  reactionScore: number;
  motionScore: number;
  sceneScore: number;
  chatScore: number;
  silenceToBurst: boolean;
  matchedLabels: string[];
}

/**
 * Synchronized multimodal clip scoring & boundary engine.
 * Combines speech/transcript cues, relative audio reaction contrast (NOT raw loudness),
 * scene cuts & gameplay motion, face-cam presence, and setup/reaction boundary preservation.
 */
export class DefaultClipScoringProvider implements ClipScoringProvider {
  readonly name = "default_multimodal_v1";

  generateCandidates(input: ClipScoringInput): CandidateClipDraft[] {
    const duration = Math.max(1, input.probe.durationSec);
    const totalSeconds = Math.max(1, Math.ceil(duration));
    const { config } = input;

    // Effective bounds adapt gracefully when an uploaded test clip or live slice is shorter than default minClipSec
    const effectiveMinSec = Math.min(
      config.minClipSec,
      duration <= 90 ? Math.min(12, Math.max(3, duration * 0.25)) : Math.max(3, duration * 0.6),
    );
    const effectiveMaxSec = Math.min(config.maxClipSec, duration);
    const effectiveTargetSec = Math.max(
      effectiveMinSec,
      Math.min(
        config.targetClipSec,
        duration <= 90 ? Math.min(22, Math.max(effectiveMinSec, duration * 0.35)) : effectiveMaxSec,
      ),
    );

    const hasRealTranscript = input.transcriptSegments.some(
      (s) => !s.text.startsWith("[Speech activity detected") && s.text.trim().length > 0,
    );

    // 1. Build synchronized per-second signal timeline
    const timeline: SecondSignal[] = Array.from({ length: totalSeconds }, (_, second) => ({
      second,
      speechScore: 0,
      reactionScore: 0,
      motionScore: 0,
      sceneScore: 0,
      chatScore: 0,
      silenceToBurst: false,
      matchedLabels: [],
    }));

    for (const pt of input.audioTimeline) {
      const idx = Math.min(totalSeconds - 1, Math.max(0, Math.floor(pt.second)));
      const bin = timeline[idx]!;
      bin.reactionScore = Math.max(bin.reactionScore, clamp01(pt.reactionScore));
      if (pt.isSilenceToBurst) {
        bin.silenceToBurst = true;
        bin.reactionScore = clamp01(bin.reactionScore + 0.18);
      }
    }

    for (const pt of input.motionTimeline) {
      const idx = Math.min(totalSeconds - 1, Math.max(0, Math.floor(pt.second)));
      const bin = timeline[idx]!;
      bin.motionScore = Math.max(bin.motionScore, clamp01(pt.motionScore));
      if (pt.sceneCut) {
        bin.sceneScore = Math.max(bin.sceneScore, 0.85);
      }
    }

    for (const ev of input.sceneEvents) {
      const startIdx = Math.min(totalSeconds - 1, Math.max(0, Math.floor(ev.timestampSec)));
      const endIdx =
        ev.endSec != null
          ? Math.min(totalSeconds - 1, Math.max(startIdx, Math.floor(ev.endSec)))
          : Math.min(totalSeconds - 1, startIdx + (ev.type === "chat_velocity_spike" ? 5 : 0));

      for (let i = startIdx; i <= endIdx; i++) {
        const bin = timeline[i]!;
        if (ev.type === "scene_cut") {
          bin.sceneScore = Math.max(bin.sceneScore, clamp01(ev.score));
        } else if (ev.type === "motion_burst") {
          bin.motionScore = Math.max(bin.motionScore, clamp01(ev.score));
        } else if (ev.type === "audio_reaction" || ev.type === "silence_to_burst") {
          bin.reactionScore = Math.max(bin.reactionScore, clamp01(ev.score));
          if (ev.type === "silence_to_burst") bin.silenceToBurst = true;
        } else if (ev.type === "speech_peak") {
          bin.speechScore = Math.max(bin.speechScore, clamp01(ev.score));
        } else if (ev.type === "chat_velocity_spike") {
          bin.chatScore = Math.max(bin.chatScore, clamp01(ev.score));
          if (!bin.matchedLabels.includes("live chat velocity spike")) {
            bin.matchedLabels.push("live chat velocity spike");
          }
        }
      }
    }

    for (const seg of input.transcriptSegments) {
      if (seg.text.startsWith("[Speech activity detected")) {
        // Honest speech-activity marker without fabricated words gives modest speech presence signal
        const startIdx = Math.max(0, Math.floor(seg.startSec));
        const endIdx = Math.min(totalSeconds - 1, Math.floor(seg.endSec));
        for (let i = startIdx; i <= endIdx; i++) {
          timeline[i]!.speechScore = Math.max(timeline[i]!.speechScore, 0.35);
        }
        continue;
      }

      const { score, labels } = scoreTranscriptText(seg.text, seg.confidence);
      const startIdx = Math.max(0, Math.floor(seg.startSec));
      const endIdx = Math.min(totalSeconds - 1, Math.floor(seg.endSec));
      for (let i = startIdx; i <= endIdx; i++) {
        const bin = timeline[i]!;
        if (score > bin.speechScore) {
          bin.speechScore = score;
        }
        for (const label of labels) {
          if (!bin.matchedLabels.includes(label)) bin.matchedLabels.push(label);
        }
      }
    }

    // 2. Compute per-second fused excitement score (explicitly multi-signal, never loudness-only)
    const hasChatSignals = timeline.some((b) => b.chatScore > 0);

    const perSecondComposite = timeline.map((bin) => {
      if (hasChatSignals) {
        return (
          bin.chatScore * 0.35 +
          bin.reactionScore * 0.25 +
          bin.motionScore * 0.20 +
          bin.speechScore * 0.20
        );
      }
      if (hasRealTranscript) {
        return (
          bin.speechScore * 0.36 +
          bin.reactionScore * 0.24 +
          bin.motionScore * 0.24 +
          bin.sceneScore * 0.16
        );
      }
      // Without transcription API, weight visual motion + scene cuts + relative audio contrast evenly
      return (
        bin.reactionScore * 0.34 +
        bin.motionScore * 0.34 +
        bin.sceneScore * 0.22 +
        bin.speechScore * 0.10
      );
    });

    // 3. Smooth with a 5-second kernel to locate sustained moments rather than 1-frame glitches
    const smoothed = perSecondComposite.map((_, idx) => {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, idx - 2); j <= Math.min(totalSeconds - 1, idx + 2); j++) {
        sum += perSecondComposite[j]!;
        count++;
      }
      return count > 0 ? sum / count : 0;
    });

    // 4. Identify local peaks ordered by smoothed score
    const peakCandidates: Array<{ peakSec: number; peakScore: number }> = [];
    for (let s = 0; s < totalSeconds; s++) {
      const val = smoothed[s]!;
      const left = s > 0 ? smoothed[s - 1]! : -1;
      const right = s < totalSeconds - 1 ? smoothed[s + 1]! : -1;
      if (val >= left && val >= right && val > 0.05) {
        peakCandidates.push({ peakSec: s, peakScore: val });
      }
    }

    // Fallback: if video is very uniform (e.g. calm gameplay), ensure we inspect evenly spaced windows
    if (peakCandidates.length === 0) {
      const step = Math.max(10, Math.floor(effectiveTargetSec));
      for (let s = Math.floor(step / 2); s < totalSeconds; s += step) {
        peakCandidates.push({ peakSec: s, peakScore: smoothed[s] ?? 0.25 });
      }
      if (peakCandidates.length === 0) {
        peakCandidates.push({ peakSec: Math.floor(totalSeconds / 2), peakScore: 0.25 });
      }
    }

    peakCandidates.sort((a, b) => b.peakScore - a.peakScore);

    // 5. Build context-aware candidate windows without overlap
    const acceptedWindows: Array<{ startSec: number; endSec: number }> = [];
    const drafts: CandidateClipDraft[] = [];

    const defaultLayout: LayoutMode = input.faceCam.detected
      ? "split_cam_top"
      : "gameplay_focus";

    for (const peak of peakCandidates) {
      if (drafts.length >= config.maxCandidates) break;

      const window = snapContextWindow({
        peakSec: peak.peakSec,
        duration,
        effectiveMinSec,
        effectiveMaxSec,
        effectiveTargetSec,
        segments: input.transcriptSegments,
        timeline,
      });

      // Reject heavy overlap (>35% of candidate duration) with an already selected stronger moment
      const overlaps = acceptedWindows.some((existing) => {
        const overlapSec = Math.max(
          0,
          Math.min(existing.endSec, window.endSec) -
            Math.max(existing.startSec, window.startSec),
        );
        const shorter = Math.min(
          existing.endSec - existing.startSec,
          window.endSec - window.startSec,
        );
        return shorter > 0 && overlapSec / shorter > 0.35;
      });
      if (overlaps) continue;

      const breakdown = computeWindowBreakdown({
        startSec: window.startSec,
        endSec: window.endSec,
        timeline,
        faceCamDetected: input.faceCam.detected,
        contextScore: window.contextScore,
      });

      const hasChatSignals =
        (breakdown.chatVelocityScore ?? 0) > 0.05 || timeline.some((b) => b.chatScore > 0.05);

      const finalScore = clamp01(
        hasChatSignals
          ? (breakdown.chatVelocityScore ?? 0) * 0.28 +
              breakdown.reactionScore * 0.24 +
              breakdown.motionScore * 0.20 +
              breakdown.speechScore * 0.16 +
              breakdown.sceneScore * 0.07 +
              breakdown.faceCamBonus
          : hasRealTranscript
            ? breakdown.speechScore * 0.32 +
                breakdown.reactionScore * 0.22 +
                breakdown.motionScore * 0.22 +
                breakdown.sceneScore * 0.12 +
                breakdown.contextScore * 0.07 +
                breakdown.faceCamBonus
            : breakdown.reactionScore * 0.30 +
                breakdown.motionScore * 0.30 +
                breakdown.sceneScore * 0.18 +
                breakdown.speechScore * 0.08 +
                breakdown.contextScore * 0.09 +
                breakdown.faceCamBonus,
      );

      // Apply threshold, but always allow at least 1 top moment so the user isn't left empty-handed
      if (finalScore < config.scoreThreshold && drafts.length > 0) {
        continue;
      }

      const captions = buildCaptionCuesForRange(
        input.transcriptSegments,
        window.startSec,
        window.endSec,
      );
      const excerpt = buildTranscriptExcerpt(
        input.transcriptSegments,
        window.startSec,
        window.endSec,
      );

      const windowLabels = collectWindowLabels(timeline, window.startSec, window.endSec);
      const hasSilenceToBurst = hasFlagInRange(timeline, window.startSec, window.endSec);

      const confidence = computeConfidence(breakdown, hasRealTranscript, captions);
      const reason = buildExplanation({
        breakdown,
        windowLabels,
        hasSilenceToBurst,
        faceCamDetected: input.faceCam.detected,
        hasRealTranscript,
        excerpt,
        startSec: window.startSec,
        endSec: window.endSec,
      });

      const title = suggestClipTitle({
        rank: drafts.length + 1,
        excerpt,
        windowLabels,
        breakdown,
        hasSilenceToBurst,
      });

      acceptedWindows.push({ startSec: window.startSec, endSec: window.endSec });
      drafts.push({
        rank: drafts.length + 1,
        title,
        startSec: round2(window.startSec),
        endSec: round2(window.endSec),
        score: round2(finalScore),
        confidence: round2(confidence),
        signalBreakdown: breakdown,
        reason,
        transcriptExcerpt: excerpt,
        layoutMode: defaultLayout,
        faceCamCrop: input.faceCam.region
          ? { ...input.faceCam.region, enabled: input.faceCam.detected }
          : null,
        captionLanguage: config.captionLanguage,
        captionStyle: "bold_gaming",
        captions,
        hasUnreviewedCaptions: captions.some((c) => c.needsReview),
      });
    }

    drafts.sort((a, b) => b.score - a.score);
    return drafts.map((d, i) => ({ ...d, rank: i + 1 }));
  }
}

function scoreTranscriptText(
  text: string,
  confidence: number,
): { score: number; labels: string[] } {
  const cleaned = text.trim();
  if (!cleaned) return { score: 0, labels: [] };

  let best = 0.25; // baseline for active speech
  const labels: string[] = [];

  for (const rule of HYPE_PATTERNS) {
    if (rule.pattern.test(cleaned)) {
      best = Math.max(best, rule.weight);
      labels.push(rule.label);
    }
  }

  // Discount low-confidence speech so ASR noise doesn't dominate ranking
  const confFactor = Math.max(0.45, Math.min(1, confidence));
  return { score: clamp01(best * confFactor), labels };
}

/**
 * Expands a peak into a coherent clip window that preserves lead-in setup and post-peak reaction/punchline.
 * Snaps to transcript sentence boundaries when available so speech is never cut mid-sentence.
 */
function snapContextWindow(params: {
  peakSec: number;
  duration: number;
  effectiveMinSec: number;
  effectiveMaxSec: number;
  effectiveTargetSec: number;
  segments: TranscriptSegmentData[];
  timeline: SecondSignal[];
}): { startSec: number; endSec: number; contextScore: number } {
  const { peakSec, duration, effectiveMinSec, effectiveMaxSec, effectiveTargetSec } = params;

  // Give slightly more setup before the peak (~45%) and generous reaction tail after (~55%)
  const idealLeadIn = Math.max(4, Math.min(18, effectiveTargetSec * 0.42));
  const idealTail = Math.max(4, Math.min(22, effectiveTargetSec - idealLeadIn));

  let startSec = Math.max(0, peakSec - idealLeadIn);
  let endSec = Math.min(duration, peakSec + idealTail);

  // If clamped at start or end of video, shift to preserve target duration
  if (endSec - startSec < effectiveMinSec) {
    if (startSec === 0) {
      endSec = Math.min(duration, effectiveMinSec);
    } else if (endSec >= duration) {
      startSec = Math.max(0, duration - effectiveMinSec);
    }
  }

  let snappedStart = false;
  let snappedEnd = false;

  // Snap startSec to nearest clean transcript segment start within [-5s, +3s]
  const realSegments = params.segments.filter(
    (s) => !s.text.startsWith("[Speech activity detected"),
  );
  if (realSegments.length > 0) {
    const startMatch = realSegments.find(
      (s) => s.startSec <= startSec + 3 && s.endSec >= startSec - 1,
    );
    if (startMatch && peakSec - startMatch.startSec <= effectiveMaxSec * 0.7) {
      const candidateStart = Math.max(0, startMatch.startSec - 0.35);
      if (endSec - candidateStart <= effectiveMaxSec) {
        startSec = candidateStart;
        snappedStart = true;
      }
    }

    // Snap endSec to finish any sentence active at endSec (never cut off a punchline/reaction!)
    const endMatch = realSegments.find(
      (s) => s.startSec <= endSec && s.endSec >= endSec - 0.5,
    );
    if (endMatch) {
      const candidateEnd = Math.min(duration, endMatch.endSec + 0.6);
      if (candidateEnd - startSec <= effectiveMaxSec) {
        endSec = candidateEnd;
        snappedEnd = true;
      }
    }
  }

  // Also ensure reaction tail doesn't end right in the middle of an audio reaction spike
  const endIdx = Math.min(params.timeline.length - 1, Math.floor(endSec));
  if (
    endIdx >= 0 &&
    params.timeline[endIdx] &&
    params.timeline[endIdx]!.reactionScore > 0.65 &&
    endSec + 3 <= duration &&
    endSec + 3 - startSec <= effectiveMaxSec
  ) {
    endSec = Math.min(duration, endSec + 3);
  }

  // Final guard on min/max bounds
  if (endSec - startSec > effectiveMaxSec) {
    endSec = Math.min(duration, startSec + effectiveMaxSec);
  }
  if (endSec - startSec < effectiveMinSec && duration >= effectiveMinSec) {
    endSec = Math.min(duration, startSec + effectiveMinSec);
    if (endSec - startSec < effectiveMinSec) {
      startSec = Math.max(0, endSec - effectiveMinSec);
    }
  }

  const leadRoom = peakSec - startSec >= 3.5 ? 0.5 : 0.25;
  const tailRoom = endSec - peakSec >= 3.5 ? 0.5 : 0.25;
  const snapBonus = (snappedStart ? 0.1 : 0) + (snappedEnd ? 0.1 : 0);
  const contextScore = clamp01(leadRoom + tailRoom + snapBonus);

  return { startSec, endSec, contextScore };
}

function computeWindowBreakdown(params: {
  startSec: number;
  endSec: number;
  timeline: SecondSignal[];
  faceCamDetected: boolean;
  contextScore: number;
}): SignalBreakdown {
  const startIdx = Math.max(0, Math.floor(params.startSec));
  const endIdx = Math.min(params.timeline.length - 1, Math.ceil(params.endSec));
  const slice = params.timeline.slice(startIdx, Math.max(startIdx + 1, endIdx + 1));

  // Blend top-25% peak intensity with average so a punchy climax inside a setup scores well
  const metricScore = (getter: (s: SecondSignal) => number): number => {
    if (slice.length === 0) return 0;
    const vals = slice.map(getter).sort((a, b) => b - a);
    const topCount = Math.max(1, Math.ceil(vals.length * 0.25));
    const topAvg = vals.slice(0, topCount).reduce((a, b) => a + b, 0) / topCount;
    const fullAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return clamp01(topAvg * 0.7 + fullAvg * 0.3);
  };

  return {
    speechScore: round2(metricScore((s) => s.speechScore)),
    reactionScore: round2(metricScore((s) => s.reactionScore)),
    motionScore: round2(metricScore((s) => s.motionScore)),
    sceneScore: round2(metricScore((s) => s.sceneScore)),
    chatVelocityScore: round2(metricScore((s) => s.chatScore)),
    faceCamBonus: params.faceCamDetected ? 0.05 : 0,
    contextScore: round2(params.contextScore),
  };
}

function buildTranscriptExcerpt(
  segments: TranscriptSegmentData[],
  startSec: number,
  endSec: number,
): string {
  const matching = segments
    .filter((s) => s.endSec > startSec && s.startSec < endSec)
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0 && !t.startsWith("[Speech activity detected"));

  if (matching.length === 0) {
    return "No automatic speech transcript available for this segment (visual & audio dynamics analyzed).";
  }

  const joined = matching.join(" ");
  return joined.length > 220 ? `${joined.slice(0, 217).trimEnd()}...` : joined;
}

function collectWindowLabels(
  timeline: SecondSignal[],
  startSec: number,
  endSec: number,
): string[] {
  const labels = new Set<string>();
  const startIdx = Math.max(0, Math.floor(startSec));
  const endIdx = Math.min(timeline.length - 1, Math.ceil(endSec));
  for (let i = startIdx; i <= endIdx; i++) {
    for (const label of timeline[i]?.matchedLabels ?? []) {
      labels.add(label);
    }
  }
  return Array.from(labels);
}

function hasFlagInRange(
  timeline: SecondSignal[],
  startSec: number,
  endSec: number,
): boolean {
  const startIdx = Math.max(0, Math.floor(startSec));
  const endIdx = Math.min(timeline.length - 1, Math.ceil(endSec));
  for (let i = startIdx; i <= endIdx; i++) {
    if (timeline[i]?.silenceToBurst) return true;
  }
  return false;
}

function computeConfidence(
  breakdown: SignalBreakdown,
  hasRealTranscript: boolean,
  captions: Array<{ needsReview: boolean }>,
): number {
  let activeSignals = 0;
  if (breakdown.speechScore >= 0.45) activeSignals++;
  if (breakdown.reactionScore >= 0.45) activeSignals++;
  if (breakdown.motionScore >= 0.45) activeSignals++;
  if (breakdown.sceneScore >= 0.45) activeSignals++;

  const agreementBonus = activeSignals >= 3 ? 0.25 : activeSignals === 2 ? 0.14 : 0.04;
  const transcriptBonus = hasRealTranscript ? 0.12 : 0;
  const reviewPenalty =
    captions.length > 0 && captions.every((c) => c.needsReview) ? 0.08 : 0;

  return clamp01(0.48 + agreementBonus + transcriptBonus - reviewPenalty);
}

function buildExplanation(params: {
  breakdown: SignalBreakdown;
  windowLabels: string[];
  hasSilenceToBurst: boolean;
  faceCamDetected: boolean;
  hasRealTranscript: boolean;
  excerpt: string;
  startSec: number;
  endSec: number;
}): string {
  const parts: string[] = [];

  if (params.windowLabels.length > 0) {
    parts.push(`detected ${params.windowLabels.slice(0, 2).join(" & ")} in speech`);
  } else if (params.hasRealTranscript && params.breakdown.speechScore >= 0.4) {
    parts.push("active commentary matched with gameplay peak");
  }

  if (params.windowLabels.includes("live chat velocity spike") || (params.breakdown.chatVelocityScore ?? 0) >= 0.45) {
    parts.push("live chat messages-per-second hype surge");
  }

  if (params.hasSilenceToBurst) {
    parts.push("sharp reaction burst following tense quiet buildup");
  } else if (params.breakdown.reactionScore >= 0.5) {
    parts.push("distinct vocal/audio reaction shift (relative to baseline)");
  }

  if (params.breakdown.motionScore >= 0.5 && params.breakdown.sceneScore >= 0.5) {
    parts.push("high gameplay motion paired with rapid scene transitions");
  } else if (params.breakdown.motionScore >= 0.5) {
    parts.push("sustained high-intensity gameplay action");
  } else if (params.breakdown.sceneScore >= 0.5) {
    parts.push("notable scene cut / event transition");
  }

  if (params.faceCamDetected) {
    parts.push("face-cam region detected for split-screen reaction framing");
  }

  if (parts.length === 0) {
    parts.push("strongest combined audiovisual momentum window in this section");
  }

  const durationSec = Math.round(params.endSec - params.startSec);
  const joined = parts.join("; ");
  const capitalized = joined.charAt(0).toUpperCase() + joined.slice(1);
  return `${capitalized}. Boundaries (${durationSec}s) preserve lead-in setup and reaction payoff.`;
}

function suggestClipTitle(params: {
  rank: number;
  excerpt: string;
  windowLabels: string[];
  breakdown: SignalBreakdown;
  hasSilenceToBurst: boolean;
}): string {
  if (params.windowLabels.includes("live chat velocity spike") || (params.breakdown.chatVelocityScore ?? 0) >= 0.5) {
    return `Live Chat Hype Surge #${params.rank}`;
  }
  if (params.windowLabels.includes("clutch play callout")) {
    return `Clutch Highlight #${params.rank}`;
  }
  if (params.windowLabels.includes("disbelief reaction")) {
    return `Unbelievable Reaction Moment #${params.rank}`;
  }
  if (params.windowLabels.includes("celebration reaction")) {
    return `Big Win Celebration #${params.rank}`;
  }
  if (params.hasSilenceToBurst && params.breakdown.motionScore >= 0.5) {
    return `Sudden Action & Reaction Spike #${params.rank}`;
  }
  if (params.breakdown.motionScore >= 0.6) {
    return `High-Intensity Gameplay Sequence #${params.rank}`;
  }
  if (params.breakdown.reactionScore >= 0.55) {
    return `Peak Reaction Moment #${params.rank}`;
  }
  return `Highlight Candidate #${params.rank}`;
}
