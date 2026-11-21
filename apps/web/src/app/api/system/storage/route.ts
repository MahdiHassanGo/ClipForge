import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { getRepoRoot, syncEnvFile } from "@/lib/env";
import { handleApiError } from "@/lib/http";

export interface VolumeInfo {
  name: string;
  mountPath: string;
  clipForgePath: string;
  freeBytes: number;
  totalBytes: number;
  freeFormatted: string;
  isLowSpace: boolean;
  isRecommended: boolean;
}

function formatGigabytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

function scanAvailableVolumes(): VolumeInfo[] {
  const volumes: VolumeInfo[] = [];

  // Check /Volumes on macOS
  if (fs.existsSync("/Volumes")) {
    try {
      const entries = fs.readdirSync("/Volumes");
      for (const entry of entries) {
        const mountPath = path.join("/Volumes", entry);
        try {
          const stat = fs.statfsSync(mountPath);
          const freeBytes = Number(stat.bavail) * Number(stat.bsize);
          const totalBytes = Number(stat.blocks) * Number(stat.bsize);
          const isLowSpace = freeBytes < 5 * 1024 * 1024 * 1024;
          const isExternal = entry !== "Macintosh HD";

          volumes.push({
            name: entry,
            mountPath,
            clipForgePath: path.join(mountPath, "ClipForge"),
            freeBytes,
            totalBytes,
            freeFormatted: formatGigabytes(freeBytes),
            isLowSpace,
            isRecommended: isExternal && freeBytes > 20 * 1024 * 1024 * 1024,
          });
        } catch {
          // ignore unreadable volume
        }
      }
    } catch {
      // ignore
    }
  }

  // Also include internal default repo storage
  const repoRoot = getRepoRoot();
  try {
    const stat = fs.statfsSync(repoRoot);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const isLowSpace = freeBytes < 5 * 1024 * 1024 * 1024;

    if (!volumes.some((v) => v.mountPath === "/" || v.name === "Macintosh HD")) {
      volumes.push({
        name: "Internal Disk",
        mountPath: repoRoot,
        clipForgePath: path.join(repoRoot, "storage"),
        freeBytes,
        totalBytes,
        freeFormatted: formatGigabytes(freeBytes),
        isLowSpace,
        isRecommended: freeBytes > 20 * 1024 * 1024 * 1024,
      });
    }
  } catch {
    // ignore
  }

  // Sort: recommended volumes first, then descending by free space
  return volumes.sort((a, b) => {
    if (a.isRecommended && !b.isRecommended) return -1;
    if (!a.isRecommended && b.isRecommended) return 1;
    return b.freeBytes - a.freeBytes;
  });
}

export async function GET() {
  try {
    await requireUser();
    syncEnvFile();

    const repoRoot = getRepoRoot();
    const currentStorageDir = process.env.LOCAL_STORAGE_DIR
      ? path.isAbsolute(process.env.LOCAL_STORAGE_DIR)
        ? process.env.LOCAL_STORAGE_DIR
        : path.resolve(repoRoot, process.env.LOCAL_STORAGE_DIR)
      : path.resolve(repoRoot, "storage");

    const currentTempDir = process.env.TEMP_WORK_DIR
      ? path.isAbsolute(process.env.TEMP_WORK_DIR)
        ? process.env.TEMP_WORK_DIR
        : path.resolve(repoRoot, process.env.TEMP_WORK_DIR)
      : path.resolve(repoRoot, "tmp/clipforge-worker");

    let currentFreeBytes = 0;
    try {
      const stat = fs.statfsSync(currentStorageDir);
      currentFreeBytes = Number(stat.bavail) * Number(stat.bsize);
    } catch {
      try {
        const stat = fs.statfsSync(repoRoot);
        currentFreeBytes = Number(stat.bavail) * Number(stat.bsize);
      } catch {
        currentFreeBytes = 0;
      }
    }

    const volumes = scanAvailableVolumes();

    return NextResponse.json({
      currentStorageDir,
      currentTempDir,
      currentClipsDir: path.join(currentStorageDir, "clips"),
      currentFreeBytes,
      currentFreeFormatted: formatGigabytes(currentFreeBytes),
      isLowSpace: currentFreeBytes < 5 * 1024 * 1024 * 1024,
      volumes,
    });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/system/storage" });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireUser();
    const body = await request.json();
    const targetDir = typeof body.storageDir === "string" ? body.storageDir.trim() : "";

    if (!targetDir) {
      return NextResponse.json({ error: "Storage directory path is required." }, { status: 400 });
    }

    const repoRoot = getRepoRoot();
    const resolvedPath = path.isAbsolute(targetDir) ? targetDir : path.resolve(repoRoot, targetDir);

    // Ensure target base directory exists and has subdirectories storage, tmp, clips
    const storageSubdir = path.join(resolvedPath, "storage");
    const tmpSubdir = path.join(resolvedPath, "tmp");
    const clipsSubdir = path.join(resolvedPath, "clips");

    await fsp.mkdir(storageSubdir, { recursive: true });
    await fsp.mkdir(tmpSubdir, { recursive: true });
    await fsp.mkdir(clipsSubdir, { recursive: true });

    // Verify write permissions
    const testFile = path.join(storageSubdir, `.write_test_${Date.now()}`);
    await fsp.writeFile(testFile, "ok");
    await fsp.rm(testFile);

    // Update .env file in repo root
    const envPath = path.join(repoRoot, ".env");
    let envContent = fs.existsSync(envPath) ? await fsp.readFile(envPath, "utf-8") : "";

    // Replace or add LOCAL_STORAGE_DIR
    if (/^LOCAL_STORAGE_DIR=.*$/m.test(envContent)) {
      envContent = envContent.replace(/^LOCAL_STORAGE_DIR=.*$/m, `LOCAL_STORAGE_DIR="${storageSubdir}"`);
    } else {
      envContent += `\nLOCAL_STORAGE_DIR="${storageSubdir}"`;
    }

    // Replace or add TEMP_WORK_DIR
    if (/^TEMP_WORK_DIR=.*$/m.test(envContent)) {
      envContent = envContent.replace(/^TEMP_WORK_DIR=.*$/m, `TEMP_WORK_DIR="${tmpSubdir}"`);
    } else {
      envContent += `\nTEMP_WORK_DIR="${tmpSubdir}"`;
    }

    await fsp.writeFile(envPath, envContent, "utf-8");

    // Sync process.env in current Next.js process
    process.env.LOCAL_STORAGE_DIR = storageSubdir;
    process.env.TEMP_WORK_DIR = tmpSubdir;
    syncEnvFile();

    const stat = fs.statfsSync(storageSubdir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);

    return NextResponse.json({
      success: true,
      storageDir: storageSubdir,
      tempDir: tmpSubdir,
      clipsDir: clipsSubdir,
      freeBytes,
      freeFormatted: formatGigabytes(freeBytes),
      isLowSpace: freeBytes < 5 * 1024 * 1024 * 1024,
    });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/system/storage" });
  }
}
