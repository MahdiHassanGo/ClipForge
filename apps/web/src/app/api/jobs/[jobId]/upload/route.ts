import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  assertJobTransition,
  assertResourceOwnership,
  getMaxUploadBytes,
  validateUploadMetadata,
  validateVideoMagicBytes,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { getObjectStorage, getUploadTempDir } from "@/lib/env";
import { handleApiError, serializeJson } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  let tempFilePath: string | null = null;
  let jobIdForError: string | null = null;

  try {
    const user = await requireUser();
    const { jobId } = await context.params;
    jobIdForError = jobId;

    const job = await prisma.clipJob.findUnique({ where: { id: jobId } });
    if (!job) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404 });
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "clip job",
    });

    assertJobTransition(job.status, "uploading");

    const maxBytes = getMaxUploadBytes();
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.toLowerCase().includes("multipart/form-data");

    const uploadTmpDir = getUploadTempDir();
    await fsp.mkdir(uploadTmpDir, { recursive: true });
    tempFilePath = path.join(
      uploadTmpDir,
      `upload_${jobId}_${crypto.randomBytes(6).toString("hex")}.tmp`,
    );

    let fileName = "video.mp4";
    let mimeType = "video/mp4";
    let totalBytes = 0;

    // Transition into uploading state so UI and refreshes reflect live progress
    await prisma.clipJob.update({
      where: { id: jobId },
      data: {
        status: "uploading",
        progressPct: 10,
        progressMessage: "Receiving authorized source video file...",
        errorCode: null,
        errorMessage: null,
      },
    });

    if (isMultipart) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new UploadClientError("UPLOAD_MISSING_FILE", "No video file was provided.");
      }
      fileName = file.name || "video.mp4";
      mimeType = file.type || "application/octet-stream";

      const metaCheck = validateUploadMetadata({
        fileName,
        mimeType,
        sizeBytes: file.size,
        maxBytes,
      });
      if (!metaCheck.valid) {
        throw new UploadClientError(metaCheck.code, metaCheck.error);
      }

      const reader = file.stream().getReader();
      totalBytes = await streamReaderToFile(reader, tempFilePath, maxBytes);
      fileName = metaCheck.sanitizedFileName;
    } else {
      const rawNameHeader = request.headers.get("x-file-name") ?? "video.mp4";
      fileName = decodeURIComponent(rawNameHeader);
      mimeType = contentType.split(";")[0]?.trim() || "application/octet-stream";
      const declaredLength = Number(request.headers.get("content-length") ?? "0");

      const metaCheck = validateUploadMetadata({
        fileName,
        mimeType,
        sizeBytes: declaredLength > 0 ? declaredLength : 1,
        maxBytes,
      });
      if (!metaCheck.valid) {
        throw new UploadClientError(metaCheck.code, metaCheck.error);
      }

      if (!request.body) {
        throw new UploadClientError("FILE_EMPTY", "Upload stream body is empty.");
      }

      const reader = request.body.getReader();
      totalBytes = await streamReaderToFile(reader, tempFilePath, maxBytes);
      fileName = metaCheck.sanitizedFileName;

      if (totalBytes <= 0) {
        throw new UploadClientError("FILE_EMPTY", "The uploaded file is empty.");
      }
    }

    // Verify file container magic bytes so disguised non-video files are rejected cleanly
    const fd = await fsp.open(tempFilePath, "r");
    const headerBuf = Buffer.alloc(16);
    try {
      await fd.read(headerBuf, 0, 16, 0);
    } finally {
      await fd.close();
    }

    if (!validateVideoMagicBytes(headerBuf)) {
      throw new UploadClientError(
        "INVALID_MAGIC_BYTES",
        "Uploaded file header is not a valid MP4, MOV, WebM, or MKV video container.",
      );
    }

    const storage = getObjectStorage();
    const storageKey = `uploads/${user.id}/${jobId}/${fileName}`;

    // Delete any previous source file on re-upload
    if (job.sourceStorageKey && job.sourceStorageKey !== storageKey) {
      await storage.delete(job.sourceStorageKey).catch(() => {});
    }

    await storage.putFromFile(storageKey, tempFilePath, mimeType);

    assertJobTransition("uploading", "analyzing");

    const updated = await prisma.clipJob.update({
      where: { id: jobId },
      data: {
        status: "analyzing",
        sourceStorageKey: storageKey,
        sourceFileName: fileName,
        sourceMimeType: mimeType,
        sourceFileSizeBytes: BigInt(totalBytes),
        progressPct: 5,
        progressMessage: "Upload complete. Queued for background video analysis...",
        errorCode: null,
        errorMessage: null,
        failedFromStatus: null,
        workerLockedAt: null,
        workerId: null,
      },
    });

    return NextResponse.json({ job: serializeJson(updated) }, { status: 200 });
  } catch (error) {
    if (jobIdForError) {
      const errCode =
        error instanceof UploadClientError ? error.code : "UPLOAD_FAILED";
      const errMsg =
        error instanceof Error ? error.message : "Failed to upload video file.";

      await prisma.clipJob
        .updateMany({
          where: { id: jobIdForError, status: "uploading" },
          data: {
            status: "failed",
            failedFromStatus: "uploading",
            errorCode: errCode,
            errorMessage: errMsg.slice(0, 500),
            progressMessage: "Upload failed — please fix the issue and upload again.",
          },
        })
        .catch(() => {});
    }

    if (error instanceof UploadClientError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "FILE_TOO_LARGE" ? 413 : 400 },
      );
    }
    return handleApiError(error, { route: "POST /api/jobs/[jobId]/upload" });
  } finally {
    if (tempFilePath) {
      await fsp.rm(tempFilePath, { force: true }).catch(() => {});
    }
  }
}

class UploadClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function streamReaderToFile(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const writer = fs.createWriteStream(destPath);
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        const maxMb = Math.round(maxBytes / (1024 * 1024));
        throw new UploadClientError(
          "FILE_TOO_LARGE",
          `File exceeds the maximum allowed upload size of ${maxMb} MB.`,
        );
      }

      if (!writer.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            writer.off("error", onError);
            resolve();
          };
          const onError = (err: Error) => {
            writer.off("drain", onDrain);
            reject(err);
          };
          writer.once("drain", onDrain);
          writer.once("error", onError);
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return total;
  } catch (err) {
    writer.destroy();
    throw err;
  }
}
