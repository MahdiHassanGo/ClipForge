import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export interface StoredObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType?: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface ObjectStorageProvider {
  readonly providerName: string;
  putFromFile(key: string, localFilePath: string, contentType?: string): Promise<StoredObjectMetadata>;
  putFromBuffer(key: string, buffer: Buffer, contentType?: string): Promise<StoredObjectMetadata>;
  downloadToFile(key: string, destPath: string): Promise<void>;
  createReadStream(key: string, range?: ByteRange): Promise<{
    stream: Readable;
    totalSize: number;
    contentType?: string;
  }>;
  stat(key: string): Promise<StoredObjectMetadata | null>;
  delete(key: string): Promise<void>;
}

function sanitizeStorageKey(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid object storage key: ${key}`);
  }
  return normalized;
}

export class LocalObjectStorageProvider implements ObjectStorageProvider {
  readonly providerName = "local";
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolveKeyPath(key: string): string {
    const safeKey = sanitizeStorageKey(key);
    const resolved = path.resolve(this.rootDir, safeKey);
    if (!resolved.startsWith(this.rootDir + path.sep) && resolved !== this.rootDir) {
      throw new Error(`Path traversal attempt rejected for key: ${key}`);
    }
    return resolved;
  }

  async putFromFile(
    key: string,
    localFilePath: string,
    contentType?: string,
  ): Promise<StoredObjectMetadata> {
    const dest = this.resolveKeyPath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmpDest = `${dest}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fsp.copyFile(localFilePath, tmpDest);
    await fsp.rename(tmpDest, dest);
    const stat = await fsp.stat(dest);
    return { key: sanitizeStorageKey(key), sizeBytes: stat.size, contentType };
  }

  async putFromBuffer(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<StoredObjectMetadata> {
    const dest = this.resolveKeyPath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmpDest = `${dest}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(tmpDest, buffer);
    await fsp.rename(tmpDest, dest);
    return { key: sanitizeStorageKey(key), sizeBytes: buffer.length, contentType };
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const src = this.resolveKeyPath(key);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(src, destPath);
  }

  async createReadStream(
    key: string,
    range?: ByteRange,
  ): Promise<{ stream: Readable; totalSize: number; contentType?: string }> {
    const src = this.resolveKeyPath(key);
    const stat = await fsp.stat(src);
    const stream = range
      ? fs.createReadStream(src, { start: range.start, end: range.end })
      : fs.createReadStream(src);
    return { stream, totalSize: stat.size };
  }

  async stat(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const src = this.resolveKeyPath(key);
      const stat = await fsp.stat(src);
      return { key: sanitizeStorageKey(key), sizeBytes: stat.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const src = this.resolveKeyPath(key);
    await fsp.rm(src, { force: true });
  }
}

export class S3ObjectStorageProvider implements ObjectStorageProvider {
  readonly providerName = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle?: boolean;
  }) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async putFromFile(
    key: string,
    localFilePath: string,
    contentType?: string,
  ): Promise<StoredObjectMetadata> {
    const safeKey = sanitizeStorageKey(key);
    const stat = await fsp.stat(localFilePath);
    const body = fs.createReadStream(localFilePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey,
        Body: body,
        ContentType: contentType,
        ContentLength: stat.size,
      }),
    );
    return { key: safeKey, sizeBytes: stat.size, contentType };
  }

  async putFromBuffer(
    key: string,
    buffer: Buffer,
    contentType?: string,
  ): Promise<StoredObjectMetadata> {
    const safeKey = sanitizeStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      }),
    );
    return { key: safeKey, sizeBytes: buffer.length, contentType };
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const safeKey = sanitizeStorageKey(key);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: safeKey }),
    );
    if (!res.Body) throw new Error(`Object ${safeKey} has empty body`);
    await pipeline(res.Body as Readable, fs.createWriteStream(destPath));
  }

  async createReadStream(
    key: string,
    range?: ByteRange,
  ): Promise<{ stream: Readable; totalSize: number; contentType?: string }> {
    const safeKey = sanitizeStorageKey(key);
    const head = await this.stat(safeKey);
    if (!head) throw new Error(`Object not found: ${safeKey}`);

    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: safeKey,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    if (!res.Body) throw new Error(`Object ${safeKey} has empty body`);
    return {
      stream: res.Body as Readable,
      totalSize: head.sizeBytes,
      contentType: head.contentType,
    };
  }

  async stat(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const safeKey = sanitizeStorageKey(key);
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey }),
      );
      return {
        key: safeKey,
        sizeBytes: res.ContentLength ?? 0,
        contentType: res.ContentType,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const safeKey = sanitizeStorageKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey }),
    );
  }
}

export function createObjectStorageFromEnv(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = process.cwd(),
): ObjectStorageProvider {
  const provider = (env.STORAGE_PROVIDER ?? "local").toLowerCase();
  if (provider === "s3") {
    const bucket = env.S3_BUCKET;
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
      );
    }
    return new S3ObjectStorageProvider({
      bucket,
      region: env.S3_REGION ?? "us-east-1",
      endpoint: env.S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    });
  }

  const configuredDir = env.LOCAL_STORAGE_DIR ?? "./storage";
  let resolvedDir = path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(baseDir, configuredDir);

  try {
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
  } catch {
    resolvedDir = path.resolve(baseDir, "./storage");
    try {
      fs.mkdirSync(resolvedDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  return new LocalObjectStorageProvider(resolvedDir);
}
