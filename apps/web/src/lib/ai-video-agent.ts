import crypto from "node:crypto";
import { z } from "zod";
import {
  assertJobTransition,
  buildCaptionCuesForRange,
  captionCueSchema,
  captionStyleSchema,
  candidateStatusSchema,
  exportPresetSchema,
  layoutModeSchema,
  normalizeFaceCamRegion,
  transliterateBengaliToBanglish,
  validateCandidateBounds,
  type AiAgentActionRecord,
  type AiProviderType,
  type FaceCamRegion,
  type TranscriptSegmentData,
  type TranscriptWord,
} from "@clipforge/core";
import { prisma, Prisma } from "@clipforge/db";
import {
  runLlmCompletion,
  type AgentConversationMessage,
  type AgentToolDefinition,
  type ResolvedProviderCredentials,
} from "@/lib/ai-provider-client";

const CORNER_PRESETS: Record<
  "top_left" | "top_right" | "bottom_left" | "bottom_right",
  Omit<FaceCamRegion, "confidence" | "enabled">
> = {
  top_left: { corner: "top_left", x: 0.02, y: 0.03, width: 0.23, height: 0.24 },
  top_right: { corner: "top_right", x: 0.75, y: 0.03, width: 0.23, height: 0.24 },
  bottom_left: { corner: "bottom_left", x: 0.02, y: 0.72, width: 0.23, height: 0.24 },
  bottom_right: { corner: "bottom_right", x: 0.75, y: 0.72, width: 0.23, height: 0.24 },
};

const searchTranscriptArgsSchema = z.object({
  query: z.string().trim().max(200).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(60).optional().default(25),
});

const getTimelineEventsArgsSchema = z.object({
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  types: z
    .array(
      z.enum([
        "scene_cut",
        "motion_burst",
        "audio_reaction",
        "speech_peak",
        "silence_to_burst",
        "chat_velocity_spike",
      ]),
    )
    .optional(),
  minScore: z.number().min(0).max(1).optional().default(0.3),
  limit: z.number().int().min(1).max(60).optional().default(25),
});

const createClipArgsSchema = z.object({
  title: z.string().trim().min(1).max(140),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  reason: z.string().trim().min(1).max(500).optional().default("Selected by AI Video Director"),
  layoutMode: layoutModeSchema.optional(),
  captionStyle: captionStyleSchema.optional().default("bold_gaming"),
  captionsEnabled: z.boolean().optional().default(true),
  status: candidateStatusSchema.optional().default("selected"),
});

const updateClipArgsSchema = z.object({
  clipId: z.string().min(1),
  title: z.string().trim().min(1).max(140).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().positive().optional(),
  status: candidateStatusSchema.optional(),
  layoutMode: layoutModeSchema.optional(),
  captionStyle: captionStyleSchema.optional(),
  captionLanguage: z
    .enum(["auto", "en", "bn", "bn_en", "es", "fr", "de", "pt", "ja", "ko", "hi"])
    .optional(),
  captionsEnabled: z.boolean().optional(),
  faceCamCorner: z
    .enum(["top_left", "top_right", "bottom_left", "bottom_right"])
    .optional(),
  transliterateToBanglish: z.boolean().optional(),
  captions: z.array(captionCueSchema).max(200).optional(),
});

const queueRenderArgsSchema = z.object({
  clipIds: z.array(z.string().min(1)).min(1).max(10),
  presets: z.array(exportPresetSchema).min(1).max(3).optional().default(["youtube_shorts"]),
});

const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "search_transcript",
    description:
      "Search the full video/stream transcript by keyword(s) or time window [startSec, endSec]. Always use this to locate exact moments, topics, jokes, quotes, or reactions in long videos.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keyword or phrase to search (case-insensitive). Supports space-separated terms.",
        },
        startSec: { type: "number", description: "Optional start time filter in seconds." },
        endSec: { type: "number", description: "Optional end time filter in seconds." },
        limit: { type: "number", description: "Max segments to return (default 25, max 60)." },
      },
    },
  },
  {
    name: "get_timeline_events",
    description:
      "Fetch detected audio reactions, silence-to-burst moments, motion bursts, scene cuts, speech peaks, and chat velocity spikes across the video or within a time window.",
    parameters: {
      type: "object",
      properties: {
        startSec: { type: "number" },
        endSec: { type: "number" },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "scene_cut",
              "motion_burst",
              "audio_reaction",
              "speech_peak",
              "silence_to_burst",
              "chat_velocity_spike",
            ],
          },
        },
        minScore: { type: "number", description: "Minimum event score 0..1 (default 0.3)." },
        limit: { type: "number", description: "Max events to return (default 25, max 60)." },
      },
    },
  },
  {
    name: "create_clip_candidate",
    description:
      "Create a new clip candidate at an exact [startSec, endSec] range from the video/stream. Automatically builds synced captions from the transcript in that range.",
    parameters: {
      type: "object",
      required: ["title", "startSec", "endSec"],
      properties: {
        title: { type: "string", description: "Short descriptive clip title." },
        startSec: { type: "number", description: "Clip start timestamp in seconds." },
        endSec: { type: "number", description: "Clip end timestamp in seconds (3s to 180s after startSec)." },
        reason: { type: "string", description: "Why this moment is compelling." },
        layoutMode: {
          type: "string",
          enum: ["split_cam_top", "pip_overlay", "gameplay_focus", "podcast_center_fill"],
        },
        captionStyle: {
          type: "string",
          enum: ["bold_gaming", "clean_minimal", "boxed_high_contrast"],
        },
        captionsEnabled: { type: "boolean" },
        status: {
          type: "string",
          enum: ["suggested", "selected", "discarded"],
          description: "Defaults to 'selected' so it is ready for export.",
        },
      },
    },
  },
  {
    name: "update_clip_candidate",
    description:
      "Edit an existing clip candidate: adjust trim timestamps, rename title, change status (selected/suggested/discarded), switch 9:16 layoutMode, change captionStyle or captionLanguage, move faceCamCorner, convert Bengali captions to Banglish (transliterateToBanglish=true), or rewrite caption cues.",
    parameters: {
      type: "object",
      required: ["clipId"],
      properties: {
        clipId: { type: "string", description: "ID of the candidate clip to modify." },
        title: { type: "string" },
        startSec: { type: "number" },
        endSec: { type: "number" },
        status: { type: "string", enum: ["suggested", "selected", "discarded"] },
        layoutMode: {
          type: "string",
          enum: ["split_cam_top", "pip_overlay", "gameplay_focus", "podcast_center_fill"],
        },
        captionStyle: {
          type: "string",
          enum: ["bold_gaming", "clean_minimal", "boxed_high_contrast"],
        },
        captionLanguage: {
          type: "string",
          enum: ["auto", "en", "bn", "bn_en", "es", "fr", "de", "pt", "ja", "ko", "hi"],
        },
        captionsEnabled: { type: "boolean" },
        faceCamCorner: {
          type: "string",
          enum: ["top_left", "top_right", "bottom_left", "bottom_right"],
        },
        transliterateToBanglish: {
          type: "boolean",
          description: "Set true to convert Bengali script captions on this clip into Romanized Banglish.",
        },
        captions: {
          type: "array",
          description: "Optional updated caption cues array with id, startSec, endSec, text, confidence, needsReview.",
          items: {
            type: "object",
            required: ["id", "startSec", "endSec", "text", "confidence", "needsReview"],
            properties: {
              id: { type: "string" },
              startSec: { type: "number" },
              endSec: { type: "number" },
              text: { type: "string" },
              confidence: { type: "number" },
              needsReview: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "queue_clip_render",
    description:
      "Queue 9:16 vertical MP4 export renders for one or more non-discarded clip IDs. Only call this when the user asks to render or export MP4s.",
    parameters: {
      type: "object",
      required: ["clipIds"],
      properties: {
        clipIds: {
          type: "array",
          items: { type: "string" },
        },
        presets: {
          type: "array",
          items: {
            type: "string",
            enum: ["youtube_shorts", "tiktok", "instagram_reels"],
          },
        },
      },
    },
  },
];

function formatSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

function mapSegmentRow(row: {
  segmentIndex: number;
  startSec: number;
  endSec: number;
  text: string;
  language: string;
  confidence: number;
  lowConfidence: boolean;
  needsReview: boolean;
  wordsJson: Prisma.JsonValue | null;
}): TranscriptSegmentData {
  return {
    index: row.segmentIndex,
    startSec: row.startSec,
    endSec: row.endSec,
    text: row.text,
    language: row.language,
    confidence: row.confidence,
    lowConfidence: row.lowConfidence,
    needsReview: row.needsReview,
    words: Array.isArray(row.wordsJson) ? (row.wordsJson as unknown as TranscriptWord[]) : [],
  };
}

export async function runVideoDirectorAgent(params: {
  userId: string;
  jobId: string;
  creds: ResolvedProviderCredentials;
  providerType: AiProviderType;
  userMessage: string;
  selectedClipId?: string;
}) {
  const job = await prisma.clipJob.findUnique({
    where: { id: params.jobId },
    include: {
      candidates: { orderBy: { rank: "asc" } },
      transcriptSegments: { orderBy: { segmentIndex: "asc" }, take: 2500 },
      sceneEvents: { orderBy: { score: "desc" }, take: 250 },
    },
  });

  if (!job) {
    throw new Error("Clip job not found.");
  }

  const recentHistory = await prisma.jobChatMessage.findMany({
    where: { jobId: params.jobId, userId: params.userId },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  const historyOrdered = [...recentHistory].reverse();

  // Persist user message immediately
  const savedUserMsg = await prisma.jobChatMessage.create({
    data: {
      jobId: params.jobId,
      userId: params.userId,
      role: "user",
      content: params.userMessage,
    },
  });

  const durationSec = job.mediaDurationSec ?? job.youtubeDurationSec ?? 0;
  const candidateLines = job.candidates.map(
    (c) =>
      `- id="${c.id}" | #${c.rank} | "${c.title}" | ${c.startSec.toFixed(1)}s–${c.endSec.toFixed(1)}s (${formatSec(c.startSec)}–${formatSec(c.endSec)}) | status=${c.status} | layout=${c.layoutMode} | captionStyle=${c.captionStyle} | score=${Math.round(c.score * 100)}`,
  );

  // Provide direct transcript excerpt when concise, or sampled overview + search tool for long VODs
  const realSegments = job.transcriptSegments.filter(
    (s) => !s.text.startsWith("[Speech activity detected") && s.text.trim().length > 0,
  );

  let transcriptContext = "No spoken transcript segments recorded yet.";
  if (realSegments.length > 0 && realSegments.length <= 80) {
    transcriptContext = realSegments
      .map((s) => `[${s.startSec.toFixed(1)}s-${s.endSec.toFixed(1)}s] ${s.text.trim()}`)
      .join("\n");
  } else if (realSegments.length > 80) {
    const step = Math.ceil(realSegments.length / 60);
    const sampled = realSegments.filter((_, idx) => idx % step === 0);
    transcriptContext =
      `Long transcript (${realSegments.length} segments total). Sampled overview below — call search_transcript for full keyword or time-range search:\n` +
      sampled
        .map((s) => `[${s.startSec.toFixed(1)}s-${s.endSec.toFixed(1)}s] ${s.text.trim()}`)
        .join("\n");
  }

  const topEventsContext = job.sceneEvents
    .slice(0, 25)
    .map(
      (ev) =>
        `[${ev.timestampSec.toFixed(1)}s] ${ev.type} (score=${ev.score.toFixed(2)})`,
    )
    .join("\n");

  const systemPrompt = [
    "You are ClipForge AI Video Director, an expert video editor & highlight finder embedded inside ClipForge Studio.",
    "You operate directly on the user's current scraped/uploaded video or livestream.",
    "CRITICAL RULES:",
    "1. Never invent timestamps, quotes, or edits. Always verify timestamps from the transcript or scene events using your tools (`search_transcript`, `get_timeline_events`).",
    "2. When the user asks to find moments, create clips, trim/edit clips, change layout/captions, or render MP4s, USE the tools (`create_clip_candidate`, `update_clip_candidate`, `queue_clip_render`) to perform the actual work in the database.",
    "3. Keep clips well-paced (typically 15–60s for Shorts/Reels/TikTok unless the user specifies another length), starting slightly before setup and ending after the payoff.",
    "4. Do NOT call `queue_clip_render` unless the user explicitly asks to render or export MP4s.",
    "5. After completing tool calls, summarize concisely what moments you found and what edits were applied, citing exact `MM:SS` timestamps.",
    "",
    "VIDEO CONTEXT:",
    `- Title: ${job.youtubeTitle ?? job.sourceFileName ?? job.youtubeVideoId}`,
    `- Duration: ${durationSec.toFixed(1)}s (${formatSec(durationSec)})`,
    `- Resolution: ${job.mediaWidth ?? "?"}x${job.mediaHeight ?? "?"} @ ${job.mediaFps ?? "?"}fps`,
    `- Face-cam detected: ${job.faceCamDetected ? "Yes" : "No"}`,
    `- Currently selected clip in UI: ${params.selectedClipId ?? "None"}`,
    "",
    "EXISTING CANDIDATE CLIPS:",
    candidateLines.length > 0 ? candidateLines.join("\n") : "(none yet)",
    "",
    "TOP AUDIO/MOTION/SCENE PEAKS:",
    topEventsContext || "(none)",
    "",
    "TRANSCRIPT:",
    transcriptContext,
  ].join("\n");

  const conversation: AgentConversationMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyOrdered.map(
      (m): AgentConversationMessage => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }),
    ),
    { role: "user", content: params.userMessage },
  ];

  const actions: AiAgentActionRecord[] = [];
  let mutatingChanges = false;
  let finalReply = "";
  let modelUsed = params.creds.model;

  const MAX_ROUNDS = 6;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const completion = await runLlmCompletion({
      creds: params.creds,
      messages: conversation,
      tools: AGENT_TOOLS,
      maxTokens: 1800,
      timeoutMs: 45_000,
    });

    modelUsed = completion.modelUsed;

    if (completion.toolCalls.length === 0) {
      finalReply = completion.content;
      break;
    }

    conversation.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    for (const tc of completion.toolCalls) {
      let rawArgs: unknown = {};
      try {
        rawArgs = JSON.parse(tc.argumentsJson || "{}");
      } catch {
        rawArgs = {};
      }

      const result = await executeAgentTool({
        toolName: tc.name,
        rawArgs,
        jobId: params.jobId,
        userId: params.userId,
        mediaDurationSec: durationSec,
        faceCamDetected: job.faceCamDetected,
        defaultFaceCam: (job.faceCamRegionJson as FaceCamRegion | null) ?? null,
      });

      actions.push(result.action);
      if (result.mutated) {
        mutatingChanges = true;
      }

      conversation.push({
        role: "tool",
        toolCallId: tc.id,
        name: tc.name,
        content: JSON.stringify(result.output),
      });
    }
  }

  if (!finalReply.trim()) {
    finalReply =
      actions.length > 0
        ? "Completed the requested edits on your project."
        : "I reviewed the video context. Let me know what moments or edits you want to apply.";
  }

  const savedAssistantMsg = await prisma.jobChatMessage.create({
    data: {
      jobId: params.jobId,
      userId: params.userId,
      role: "assistant",
      content: finalReply,
      provider: params.providerType,
      model: modelUsed,
      actionsJson: actions as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    userMessage: savedUserMsg,
    assistantMessage: savedAssistantMsg,
    actions,
    jobUpdated: mutatingChanges,
  };
}

async function executeAgentTool(params: {
  toolName: string;
  rawArgs: unknown;
  jobId: string;
  userId: string;
  mediaDurationSec: number;
  faceCamDetected: boolean;
  defaultFaceCam: FaceCamRegion | null;
}): Promise<{
  output: Record<string, unknown>;
  action: AiAgentActionRecord;
  mutated: boolean;
}> {
  try {
    switch (params.toolName) {
      case "search_transcript": {
        const args = searchTranscriptArgsSchema.parse(params.rawArgs);
        const where: Prisma.TranscriptSegmentWhereInput = {
          jobId: params.jobId,
        };
        if (args.startSec !== undefined) {
          where.endSec = { gte: args.startSec };
        }
        if (args.endSec !== undefined) {
          where.startSec = { lte: args.endSec };
        }
        const rows = await prisma.transcriptSegment.findMany({
          where,
          orderBy: { segmentIndex: "asc" },
          take: 800,
        });

        let filtered = rows.filter((r) => !r.text.startsWith("[Speech activity detected"));
        if (args.query) {
          const terms = args.query
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          filtered = filtered.filter((r) => {
            const lower = r.text.toLowerCase();
            return terms.some((t) => lower.includes(t));
          });
        }
        const slice = filtered.slice(0, args.limit);
        return {
          mutated: false,
          output: {
            totalMatched: filtered.length,
            segments: slice.map((s) => ({
              startSec: Number(s.startSec.toFixed(2)),
              endSec: Number(s.endSec.toFixed(2)),
              text: s.text,
            })),
          },
          action: {
            tool: "search_transcript",
            summary: args.query
              ? `Searched transcript for "${args.query}" (${filtered.length} matches)`
              : `Read ${slice.length} transcript segments`,
            status: "ok",
          },
        };
      }

      case "get_timeline_events": {
        const args = getTimelineEventsArgsSchema.parse(params.rawArgs);
        const where: Prisma.SceneEventWhereInput = {
          jobId: params.jobId,
          score: { gte: args.minScore },
        };
        if (args.startSec !== undefined || args.endSec !== undefined) {
          where.timestampSec = {
            ...(args.startSec !== undefined ? { gte: args.startSec } : {}),
            ...(args.endSec !== undefined ? { lte: args.endSec } : {}),
          };
        }
        if (args.types && args.types.length > 0) {
          where.type = { in: args.types };
        }
        const events = await prisma.sceneEvent.findMany({
          where,
          orderBy: { score: "desc" },
          take: args.limit,
        });
        return {
          mutated: false,
          output: {
            events: events.map((e) => ({
              timestampSec: Number(e.timestampSec.toFixed(2)),
              endSec: e.endSec ? Number(e.endSec.toFixed(2)) : null,
              type: e.type,
              score: Number(e.score.toFixed(2)),
            })),
          },
          action: {
            tool: "get_timeline_events",
            summary: `Inspected ${events.length} timeline signal peak(s)`,
            status: "ok",
          },
        };
      }

      case "create_clip_candidate": {
        const args = createClipArgsSchema.parse(params.rawArgs);
        const bounds = validateCandidateBounds({
          startSec: args.startSec,
          endSec: args.endSec,
          mediaDurationSec: params.mediaDurationSec,
        });
        if (!bounds.valid) {
          return {
            mutated: false,
            output: { error: bounds.error },
            action: {
              tool: "create_clip_candidate",
              summary: `Rejected invalid clip bounds: ${bounds.error}`,
              status: "error",
            },
          };
        }

        const existingCount = await prisma.candidateClip.count({
          where: { jobId: params.jobId },
        });
        const overlappingSegments = await prisma.transcriptSegment.findMany({
          where: {
            jobId: params.jobId,
            endSec: { gt: args.startSec },
            startSec: { lt: args.endSec },
          },
          orderBy: { segmentIndex: "asc" },
        });
        const mappedSegments = overlappingSegments.map(mapSegmentRow);
        const cues = buildCaptionCuesForRange(mappedSegments, args.startSec, args.endSec);
        const excerpt = mappedSegments
          .filter((s) => !s.text.startsWith("[Speech activity detected"))
          .map((s) => s.text.trim())
          .join(" ")
          .slice(0, 280) || "AI-curated clip segment";

        const layoutMode =
          args.layoutMode ??
          (params.faceCamDetected && params.defaultFaceCam ? "split_cam_top" : "gameplay_focus");

        const validDefaultFaceCam = normalizeFaceCamRegion(params.defaultFaceCam);

        const created = await prisma.candidateClip.create({
          data: {
            jobId: params.jobId,
            rank: existingCount + 1,
            title: args.title,
            startSec: args.startSec,
            endSec: args.endSec,
            originalStartSec: args.startSec,
            originalEndSec: args.endSec,
            score: 0.9,
            confidence: 0.9,
            signalBreakdown: {
              speechScore: 0.85,
              reactionScore: 0.8,
              motionScore: 0.75,
              sceneScore: 0.7,
              faceCamBonus: params.faceCamDetected ? 0.1 : 0,
              contextScore: 0.9,
            } as Prisma.InputJsonValue,
            reason: args.reason,
            transcriptExcerpt: excerpt,
            status: args.status,
            layoutMode,
            ...(validDefaultFaceCam
              ? {
                  faceCamCropJson:
                    validDefaultFaceCam as unknown as Prisma.InputJsonValue,
                }
              : {}),
            captionLanguage: "en",
            captionStyle: args.captionStyle,
            captionsEnabled: args.captionsEnabled,
            captionsJson: cues as unknown as Prisma.InputJsonValue,
            hasUnreviewedCaptions: cues.some((c) => c.needsReview),
          },
        });

        return {
          mutated: true,
          output: {
            clipId: created.id,
            rank: created.rank,
            title: created.title,
            startSec: created.startSec,
            endSec: created.endSec,
            captionCues: cues.length,
          },
          action: {
            tool: "create_clip_candidate",
            summary: `Created "${created.title}" (${formatSec(created.startSec)}–${formatSec(created.endSec)})`,
            clipId: created.id,
            startSec: created.startSec,
            endSec: created.endSec,
            status: "ok",
          },
        };
      }

      case "update_clip_candidate": {
        const args = updateClipArgsSchema.parse(params.rawArgs);
        const existing = await prisma.candidateClip.findUnique({
          where: { id: args.clipId },
        });
        if (!existing || existing.jobId !== params.jobId) {
          return {
            mutated: false,
            output: { error: `Clip ID '${args.clipId}' not found in this job.` },
            action: {
              tool: "update_clip_candidate",
              summary: `Clip ${args.clipId} not found`,
              status: "error",
            },
          };
        }

        const nextStart = args.startSec ?? existing.startSec;
        const nextEnd = args.endSec ?? existing.endSec;
        const bounds = validateCandidateBounds({
          startSec: nextStart,
          endSec: nextEnd,
          mediaDurationSec: params.mediaDurationSec,
        });
        if (!bounds.valid) {
          return {
            mutated: false,
            output: { error: bounds.error },
            action: {
              tool: "update_clip_candidate",
              summary: `Invalid clip bounds: ${bounds.error}`,
              status: "error",
            },
          };
        }

        const updateData: Prisma.CandidateClipUpdateInput = {};
        if (args.title !== undefined) updateData.title = args.title;
        if (args.startSec !== undefined) updateData.startSec = args.startSec;
        if (args.endSec !== undefined) updateData.endSec = args.endSec;
        if (args.status !== undefined) updateData.status = args.status;
        if (args.layoutMode !== undefined) updateData.layoutMode = args.layoutMode;
        if (args.captionStyle !== undefined) updateData.captionStyle = args.captionStyle;
        if (args.captionLanguage !== undefined) updateData.captionLanguage = args.captionLanguage;
        if (args.captionsEnabled !== undefined) updateData.captionsEnabled = args.captionsEnabled;

        if (args.faceCamCorner !== undefined) {
          updateData.faceCamCropJson = {
            ...CORNER_PRESETS[args.faceCamCorner],
            confidence: 1,
            enabled: true,
          } as unknown as Prisma.InputJsonValue;
        }

        if (args.captions !== undefined) {
          const finalCues = args.transliterateToBanglish
            ? args.captions.map((c) => ({
                ...c,
                text: transliterateBengaliToBanglish(c.text),
              }))
            : args.captions;
          updateData.captionsJson = finalCues as unknown as Prisma.InputJsonValue;
          updateData.hasUnreviewedCaptions = finalCues.some((c) => c.needsReview);
        } else if (args.startSec !== undefined || args.endSec !== undefined) {
          const segs = await prisma.transcriptSegment.findMany({
            where: {
              jobId: params.jobId,
              endSec: { gt: nextStart },
              startSec: { lt: nextEnd },
            },
            orderBy: { segmentIndex: "asc" },
          });
          const rebuilt = buildCaptionCuesForRange(segs.map(mapSegmentRow), nextStart, nextEnd);
          if (rebuilt.length > 0) {
            const finalCues = args.transliterateToBanglish
              ? rebuilt.map((c) => ({
                  ...c,
                  text: transliterateBengaliToBanglish(c.text),
                }))
              : rebuilt;
            updateData.captionsJson = finalCues as unknown as Prisma.InputJsonValue;
            updateData.hasUnreviewedCaptions = finalCues.some((c) => c.needsReview);
          }
        } else if (args.transliterateToBanglish) {
          const existingCues = Array.isArray(existing.captionsJson)
            ? (existing.captionsJson as unknown as Array<{
                id: string;
                startSec: number;
                endSec: number;
                text: string;
                confidence: number;
                needsReview: boolean;
              }>)
            : [];
          const banglishCues = existingCues.map((c) => ({
            ...c,
            text: transliterateBengaliToBanglish(c.text),
          }));
          updateData.captionsJson = banglishCues as unknown as Prisma.InputJsonValue;
          updateData.captionLanguage = "bn_en";
        }

        const updated = await prisma.candidateClip.update({
          where: { id: existing.id },
          data: updateData,
        });

        return {
          mutated: true,
          output: {
            clipId: updated.id,
            title: updated.title,
            startSec: updated.startSec,
            endSec: updated.endSec,
            status: updated.status,
            layoutMode: updated.layoutMode,
            captionStyle: updated.captionStyle,
          },
          action: {
            tool: "update_clip_candidate",
            summary: `Updated "${updated.title}" (${formatSec(updated.startSec)}–${formatSec(updated.endSec)})`,
            clipId: updated.id,
            startSec: updated.startSec,
            endSec: updated.endSec,
            status: "ok",
          },
        };
      }

      case "queue_clip_render": {
        const args = queueRenderArgsSchema.parse(params.rawArgs);
        const job = await prisma.clipJob.findUnique({
          where: { id: params.jobId },
          include: { candidates: true },
        });
        if (!job || !job.sourceStorageKey) {
          return {
            mutated: false,
            output: { error: "Source media is not ready for rendering yet." },
            action: {
              tool: "queue_clip_render",
              summary: "Cannot queue render before source media is ready",
              status: "error",
            },
          };
        }

        assertJobTransition(job.status, "rendering");
        const candidateMap = new Map(job.candidates.map((c) => [c.id, c]));
        const clips = args.clipIds
          .map((id) => candidateMap.get(id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c && c.status !== "discarded"));

        if (clips.length === 0) {
          return {
            mutated: false,
            output: { error: "No valid non-discarded clips matched clipIds." },
            action: {
              tool: "queue_clip_render",
              summary: "No valid clips to render",
              status: "error",
            },
          };
        }

        let queuedCount = 0;
        for (const clip of clips) {
          for (const preset of args.presets) {
            const fingerprint = crypto
              .createHash("sha256")
              .update(
                JSON.stringify({
                  clipId: clip.id,
                  preset,
                  startSec: clip.startSec,
                  endSec: clip.endSec,
                  layoutMode: clip.layoutMode,
                  captionStyle: clip.captionStyle,
                  captionLanguage: clip.captionLanguage,
                  captionsEnabled: clip.captionsEnabled,
                  faceCamCropJson: clip.faceCamCropJson,
                  captionsJson: clip.captionsJson,
                }),
              )
              .digest("hex")
              .slice(0, 28);

            const existing = await prisma.renderExport.findUnique({
              where: { idempotencyKey: fingerprint },
            });
            if (existing && (existing.status === "queued" || existing.status === "rendering" || existing.status === "complete")) {
              continue;
            }
            if (existing) {
              await prisma.renderExport.update({
                where: { id: existing.id },
                data: {
                  status: "queued",
                  progressPct: 0,
                  progressMessage: "Queued for vertical 9:16 render...",
                  errorCode: null,
                  errorMessage: null,
                  workerLockedAt: null,
                  workerId: null,
                  retryCount: { increment: 1 },
                },
              });
              queuedCount++;
              continue;
            }

            const validClipFaceCam = normalizeFaceCamRegion(clip.faceCamCropJson);
            await prisma.renderExport.create({
              data: {
                jobId: job.id,
                clipId: clip.id,
                userId: params.userId,
                preset,
                status: "queued",
                startSec: clip.startSec,
                endSec: clip.endSec,
                layoutMode: clip.layoutMode,
                captionStyle: clip.captionStyle,
                captionLanguage: clip.captionLanguage,
                captionsEnabled: clip.captionsEnabled,
                ...(validClipFaceCam
                  ? {
                      faceCamCropJson:
                        validClipFaceCam as unknown as Prisma.InputJsonValue,
                    }
                  : {}),
                captionsJson: clip.captionsJson as unknown as Prisma.InputJsonValue,
                progressPct: 0,
                progressMessage: "Queued for vertical 9:16 render...",
                idempotencyKey: fingerprint,
              },
            });
            queuedCount++;
          }
        }

        if (queuedCount > 0) {
          await prisma.clipJob.update({
            where: { id: job.id },
            data: {
              status: "rendering",
              progressMessage: `Queued ${queuedCount} vertical export(s) via AI Director...`,
            },
          });
        }

        return {
          mutated: true,
          output: { queuedCount, clipCount: clips.length, presets: args.presets },
          action: {
            tool: "queue_clip_render",
            summary: `Queued ${queuedCount} render export(s) (${args.presets.join(", ")})`,
            status: "ok",
          },
        };
      }

      default:
        return {
          mutated: false,
          output: { error: `Unknown tool '${params.toolName}'.` },
          action: {
            tool: "search_transcript",
            summary: `Unknown tool ${params.toolName}`,
            status: "error",
          },
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    return {
      mutated: false,
      output: { error: message },
      action: {
        tool: "search_transcript",
        summary: message,
        status: "error",
      },
    };
  }
}
