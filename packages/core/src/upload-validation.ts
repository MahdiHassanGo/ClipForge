import path from "node:path";

export const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "application/octet-stream", // Accepted only if extension & magic bytes pass
]);

export const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

export function getMaxUploadBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.MAX_UPLOAD_BYTES);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 1024 * 1024 * 1024; // 1 GiB default
}

export function sanitizeFileName(rawName: string): string {
  const base = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const collapsed = base.replace(/_+/g, "_").slice(0, 120);
  return collapsed || "upload.mp4";
}

export interface UploadValidationResult {
  valid: true;
  sanitizedFileName: string;
  extension: string;
}

export interface UploadValidationFailure {
  valid: false;
  code: "FILE_TOO_LARGE" | "FILE_EMPTY" | "UNSUPPORTED_FILE_TYPE" | "INVALID_MAGIC_BYTES";
  error: string;
}

export function validateUploadMetadata(params: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  maxBytes?: number;
}): UploadValidationResult | UploadValidationFailure {
  const maxBytes = params.maxBytes ?? getMaxUploadBytes();
  const sanitizedFileName = sanitizeFileName(params.fileName);
  const extension = path.extname(sanitizedFileName).toLowerCase();

  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes <= 0) {
    return {
      valid: false,
      code: "FILE_EMPTY",
      error: "The uploaded file is empty.",
    };
  }

  if (params.sizeBytes > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      valid: false,
      code: "FILE_TOO_LARGE",
      error: `File exceeds the maximum allowed upload size of ${maxMb} MB.`,
    };
  }

  if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
    return {
      valid: false,
      code: "UNSUPPORTED_FILE_TYPE",
      error: `Unsupported file extension '${extension || "(none)"}'. Supported formats: MP4, MOV, M4V, WebM, MKV.`,
    };
  }

  const normalizedMime = (params.mimeType || "application/octet-stream").toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalizedMime && !ALLOWED_VIDEO_MIME_TYPES.has(normalizedMime)) {
    return {
      valid: false,
      code: "UNSUPPORTED_FILE_TYPE",
      error: `Unsupported MIME type '${normalizedMime}'. Please upload an MP4, MOV, WebM, or MKV video file.`,
    };
  }

  return { valid: true, sanitizedFileName, extension };
}

/**
 * Inspects the first 16 bytes of an uploaded file to ensure it matches a supported video container.
 */
export function validateVideoMagicBytes(header: Buffer): boolean {
  if (header.length < 12) return false;

  // ISO BMFF (MP4 / MOV / M4V): bytes 4..7 == "ftyp" or "moov" or "mdat" or "wide" or "free"
  const boxType = header.subarray(4, 8).toString("ascii");
  if (boxType === "ftyp" || boxType === "moov" || boxType === "wide" || boxType === "free") {
    return true;
  }

  // EBML (WebM / MKV): 0x1A 0x45 0xDF 0xA3
  if (
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3
  ) {
    return true;
  }

  return false;
}
