import { z } from "zod";
import type { AnalysisConfig } from "./types.js";

export const registerSchema = z.object({
  email: z.string().trim().email("Please enter a valid email address.").max(255),
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters.")
    .max(80, "Name must be 80 characters or fewer."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(128, "Password must be 128 characters or fewer."),
});

export const loginSchema = z.object({
  email: z.string().trim().email("Please enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export const inspectYoutubeSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Please paste a YouTube URL.")
    .max(2048, "URL is too long."),
});

export const analysisConfigSchema = z
  .object({
    minClipSec: z.coerce.number().min(5).max(120).default(20),
    maxClipSec: z.coerce.number().min(10).max(180).default(60),
    targetClipSec: z.coerce.number().min(10).max(120).default(35),
    scoreThreshold: z.coerce.number().min(0.1).max(0.95).default(0.45),
    maxCandidates: z.coerce.number().int().min(1).max(20).default(8),
    captionLanguage: z
      .enum(["auto", "en", "es", "fr", "de", "pt", "ja", "ko", "hi"])
      .default("en"),
  })
  .refine((cfg) => cfg.minClipSec <= cfg.maxClipSec, {
    message: "Minimum clip duration must be less than or equal to maximum duration.",
    path: ["minClipSec"],
  })
  .refine(
    (cfg) => cfg.targetClipSec >= cfg.minClipSec && cfg.targetClipSec <= cfg.maxClipSec,
    {
      message: "Target clip duration must fall between min and max duration.",
      path: ["targetClipSec"],
    },
  );

export const createJobSchema = z.object({
  youtubeUrl: z.string().trim().min(1, "YouTube or Live Stream URL is required.").max(2048),
  isLiveStream: z.boolean().optional().default(false),
  liveManifestUrl: z.string().trim().url().optional(),
  liveAudioManifestUrl: z.string().trim().url().optional(),
  analysisConfig: analysisConfigSchema.optional(),
});

export const faceCamRegionSchema = z.object({
  x: z.number().min(0).max(0.95),
  y: z.number().min(0).max(0.95),
  width: z.number().min(0.05).max(1),
  height: z.number().min(0.05).max(1),
  corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right", "custom"]),
  confidence: z.number().min(0).max(1),
  enabled: z.boolean().optional(),
});

export function normalizeFaceCamRegion(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.x !== "number" ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.y) ||
    typeof candidate.width !== "number" ||
    !Number.isFinite(candidate.width) ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.height)
  ) {
    return null;
  }
  const parsed = faceCamRegionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export const captionCueSchema = z
  .object({
    id: z.string().min(1).max(120),
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    text: z.string().trim().max(240),
    confidence: z.number().min(0).max(1),
    needsReview: z.boolean(),
  })
  .refine((cue) => cue.endSec > cue.startSec, {
    message: "Caption end time must be after start time.",
    path: ["endSec"],
  });

export const layoutModeSchema = z.enum([
  "split_cam_top",
  "pip_overlay",
  "gameplay_focus",
]);

export const captionStyleSchema = z.enum([
  "bold_gaming",
  "clean_minimal",
  "boxed_high_contrast",
]);

export const candidateStatusSchema = z.enum(["suggested", "selected", "discarded"]);

export const exportPresetSchema = z.enum([
  "youtube_shorts",
  "tiktok",
  "instagram_reels",
]);

export const updateCandidateSchema = z
  .object({
    title: z.string().trim().min(1, "Title cannot be empty.").max(140).optional(),
    startSec: z.number().min(0).optional(),
    endSec: z.number().positive().optional(),
    status: candidateStatusSchema.optional(),
    layoutMode: layoutModeSchema.optional(),
    faceCamCrop: z.preprocess(
      (val) => (val === undefined ? undefined : normalizeFaceCamRegion(val)),
      faceCamRegionSchema.nullable().optional(),
    ),
    captionLanguage: z
      .enum(["auto", "en", "es", "fr", "de", "pt", "ja", "ko", "hi"])
      .optional(),
    captionStyle: captionStyleSchema.optional(),
    captionsEnabled: z.boolean().optional(),
    captions: z.array(captionCueSchema).max(400).optional(),
  })
  .refine(
    (data) => {
      if (data.startSec !== undefined && data.endSec !== undefined) {
        return data.endSec - data.startSec >= 3;
      }
      return true;
    },
    {
      message: "Clip must be at least 3 seconds long.",
      path: ["endSec"],
    },
  );

export const createRenderRequestSchema = z.object({
  clipIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one clip to render.")
    .max(20),
  presets: z
    .array(exportPresetSchema)
    .min(1, "Select at least one export preset.")
    .max(3),
});

export const aiProviderTypeSchema = z.enum([
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "groq",
  "custom",
]);

export const createAiProviderSchema = z
  .object({
    provider: aiProviderTypeSchema,
    label: z.string().trim().min(1, "Label is required.").max(80),
    model: z.string().trim().min(1, "Model ID is required.").max(120),
    baseUrl: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined))
      .refine((v) => !v || /^https?:\/\/.+/.test(v), {
        message: "Base URL must start with http:// or https://.",
      }),
    apiKey: z.string().trim().max(512).optional(),
    isDefault: z.boolean().optional().default(false),
  })
  .refine(
    (data) => {
      if (data.provider === "custom") return true;
      return Boolean(data.apiKey && data.apiKey.length >= 6);
    },
    {
      message: "API key is required for this provider.",
      path: ["apiKey"],
    },
  );

export const updateAiProviderSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+/.test(v), {
      message: "Base URL must start with http:// or https://.",
    }),
  apiKey: z.string().trim().max(512).optional(),
  isDefault: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
});

export const testAiProviderSchema = z.object({
  providerId: z.string().min(1).optional(),
  provider: aiProviderTypeSchema.optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(512).optional(),
});

export const jobChatRequestSchema = z.object({
  message: z.string().trim().min(1, "Message cannot be empty.").max(4000),
  providerId: z.string().min(1).optional(),
  selectedClipId: z.string().min(1).optional(),
});

export function validateCandidateBounds(input: {
  startSec: number;
  endSec: number;
  mediaDurationSec: number;
  minAllowedSec?: number;
  maxAllowedSec?: number;
}): { valid: true } | { valid: false; error: string } {
  const minAllowed = input.minAllowedSec ?? 3;
  const maxAllowed = input.maxAllowedSec ?? 180;

  if (!Number.isFinite(input.startSec) || !Number.isFinite(input.endSec)) {
    return { valid: false, error: "Start and end times must be finite numbers." };
  }
  if (input.startSec < 0) {
    return { valid: false, error: "Start time cannot be negative." };
  }
  if (input.endSec <= input.startSec) {
    return { valid: false, error: "End time must be greater than start time." };
  }
  const duration = input.endSec - input.startSec;
  if (duration < minAllowed) {
    return { valid: false, error: `Clip duration must be at least ${minAllowed}s.` };
  }
  if (duration > maxAllowed) {
    return { valid: false, error: `Clip duration cannot exceed ${maxAllowed}s.` };
  }
  if (input.mediaDurationSec > 0 && input.endSec > input.mediaDurationSec + 0.25) {
    return {
      valid: false,
      error: `End time (${input.endSec.toFixed(1)}s) exceeds source video duration (${input.mediaDurationSec.toFixed(1)}s).`,
    };
  }
  return { valid: true };
}

export function getDefaultAnalysisConfig(
  env: Record<string, string | undefined> = process.env,
): AnalysisConfig {
  const parsed = analysisConfigSchema.safeParse({
    minClipSec: env.CLIP_DEFAULT_MIN_SECONDS ?? 20,
    maxClipSec: env.CLIP_DEFAULT_MAX_SECONDS ?? 60,
    targetClipSec: env.CLIP_DEFAULT_TARGET_SECONDS ?? 35,
    scoreThreshold: env.CLIP_SCORE_THRESHOLD ?? 0.45,
    maxCandidates: env.CLIP_MAX_CANDIDATES ?? 8,
    captionLanguage: "en",
  });
  if (parsed.success) {
    return parsed.data;
  }
  return {
    minClipSec: 20,
    maxClipSec: 60,
    targetClipSec: 35,
    scoreThreshold: 0.45,
    maxCandidates: 8,
    captionLanguage: "en",
  };
}
