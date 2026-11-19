import type { ChatVelocityPoint, SceneEventData } from "@clipforge/core";

const HYPE_REGEX =
  /\b(w|lmao|omg|lol|pog|poggers|sheesh|no\s*way|holy|dead|insane|clip\s*that|hype|gg|clutch|wtf|lmfao|crazy)\b/i;

export interface LiveChatMessage {
  timestampMs: number;
  author: string;
  text: string;
  isHype: boolean;
}

export interface LiveChatSnapshot {
  messages: LiveChatMessage[];
  velocityPoints: ChatVelocityPoint[];
  events: SceneEventData[];
  averageMps: number;
  peakMps: number;
}

/**
 * Step C: Live Chat Velocity Spikes
 * Polls ongoing live chat actions, tracks messages per second (MPS),
 * hype keyword density, and flags high-velocity chat reaction spikes.
 */
export async function pollLiveChatSnapshot(params: {
  videoId: string;
  streamDurationSec?: number;
}): Promise<LiveChatSnapshot> {
  const { videoId } = params;
  const url = `https://www.youtube.com/live_chat?v=${videoId}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return emptySnapshot();
    }

    const html = await res.text();
    const startIdx = html.indexOf('window["ytInitialData"] = ');
    if (startIdx === -1) {
      return emptySnapshot();
    }

    const jsonStart = startIdx + 'window["ytInitialData"] = '.length;
    const jsonEnd = html.indexOf(";</script>", jsonStart);
    if (jsonEnd === -1) {
      return emptySnapshot();
    }

    const data = JSON.parse(html.slice(jsonStart, jsonEnd));
    const actions = data?.contents?.liveChatRenderer?.actions || [];

    const messages: LiveChatMessage[] = [];
    for (const a of actions) {
      const item = a.addChatItemAction?.item?.liveChatTextMessageRenderer;
      if (item) {
        const text =
          item.message?.runs?.map((r: { text?: string }) => r.text || "").join("") || "";
        const author = item.authorName?.simpleText || "viewer";
        const timestampUsec = Number(item.timestampUsec) || 0;
        const timestampMs = timestampUsec > 0 ? Math.floor(timestampUsec / 1000) : Date.now();
        const isHype = HYPE_REGEX.test(text);

        messages.push({
          timestampMs,
          author,
          text,
          isHype,
        });
      }
    }

    if (messages.length === 0) {
      return emptySnapshot();
    }

    return computeLiveChatVelocity(messages, params.streamDurationSec);
  } catch {
    return emptySnapshot();
  }
}

export function computeLiveChatVelocity(
  messages: LiveChatMessage[],
  streamDurationSec?: number,
): LiveChatSnapshot {
  if (messages.length === 0) {
    return emptySnapshot();
  }

  // Group messages into 5-second buckets to calculate messages per second (MPS)
  const sorted = [...messages].sort((a, b) => a.timestampMs - b.timestampMs);
  const minTime = sorted[0]!.timestampMs;
  const maxTime = sorted[sorted.length - 1]!.timestampMs;
  const totalSpanSec = Math.max(5, (maxTime - minTime) / 1000);

  const bucketSec = 5;
  const numBuckets = Math.max(1, Math.ceil(totalSpanSec / bucketSec));
  const counts = new Array<number>(numBuckets).fill(0);
  const hypeCounts = new Array<number>(numBuckets).fill(0);

  for (const msg of sorted) {
    const offsetSec = Math.max(0, (msg.timestampMs - minTime) / 1000);
    const bIdx = Math.min(numBuckets - 1, Math.floor(offsetSec / bucketSec));
    counts[bIdx] = (counts[bIdx] ?? 0) + 1;
    if (msg.isHype || HYPE_REGEX.test(msg.text)) {
      hypeCounts[bIdx] = (hypeCounts[bIdx] ?? 0) + 1;
    }
  }

  const averageMps = sorted.length / totalSpanSec;
  let peakMps = 0;
  const velocityPoints: ChatVelocityPoint[] = [];
  const events: SceneEventData[] = [];

  const durationSec = Math.max(totalSpanSec, streamDurationSec ?? totalSpanSec);
  const offsetBase = Math.max(0, durationSec - totalSpanSec);

  for (let i = 0; i < numBuckets; i++) {
    const count = counts[i] ?? 0;
    const mps = count / bucketSec;
    if (mps > peakMps) peakMps = mps;

    const hypeCount = hypeCounts[i] ?? 0;
    const hypeRatio = count > 0 ? hypeCount / count : 0;
    const second = Math.round(offsetBase + i * bucketSec);

    const mpsLift = averageMps > 0 ? (mps - averageMps) / Math.max(1, averageMps) : 0;
    const spikeScore = Math.max(
      0,
      Math.min(1, Math.min(1, mpsLift * 0.45) + Math.min(0.55, hypeRatio * 1.2)),
    );

    const chatEngagement = Math.min(1, (mps / 3.0) * 0.45 + (hypeRatio > 0 ? 0.35 : 0));
    const effectiveSpikeScore = Math.max(spikeScore, chatEngagement);

    velocityPoints.push({
      second,
      messagesPerSec: Math.round(mps * 10) / 10,
      hypeKeywordDensity: Math.round(hypeRatio * 100) / 100,
      spikeScore: Math.round(effectiveSpikeScore * 100) / 100,
    });

    if (effectiveSpikeScore >= 0.35 || mps >= 1.5 || (averageMps > 0 && mps > averageMps * 1.3)) {
      events.push({
        timestampSec: second,
        endSec: second + bucketSec,
        type: "chat_velocity_spike",
        score: Math.round(Math.max(0.55, effectiveSpikeScore) * 100) / 100,
        metadata: {
          mps: Math.round(mps * 10) / 10,
          hypeRatio: Math.round(hypeRatio * 100) / 100,
          totalMessagesInBucket: count,
        },
      });
    }
  }

  return {
    messages: sorted,
    velocityPoints,
    events,
    averageMps: Math.round(averageMps * 10) / 10,
    peakMps: Math.round(peakMps * 10) / 10,
  };
}

function emptySnapshot(): LiveChatSnapshot {
  return {
    messages: [],
    velocityPoints: [],
    events: [],
    averageMps: 0,
    peakMps: 0,
  };
}
