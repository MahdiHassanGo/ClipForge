import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1:";

function deriveAesKey(secret?: string): Buffer {
  const raw =
    secret ??
    process.env.AI_KEY_ENCRYPTION_SECRET ??
    process.env.SESSION_SECRET ??
    "clipforge-dev-session-secret";
  return crypto.createHash("sha256").update(`clipforge-ai-key:${raw}`).digest();
}

/**
 * Encrypts a user-supplied API key using AES-256-GCM for local DB storage.
 */
export function encryptApiKey(plaintext: string, secret?: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    throw new Error("Cannot encrypt an empty API key.");
  }
  const key = deriveAesKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTION_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

/**
 * Decrypts a stored API key encrypted with encryptApiKey.
 */
export function decryptApiKey(payload: string, secret?: string): string {
  if (!payload.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Unsupported encrypted API key format.");
  }
  const parts = payload.slice(ENCRYPTION_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted API key payload.");
  }
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Incomplete encrypted API key payload.");
  }

  const key = deriveAesKey(secret);
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(dataB64, "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Produces a non-sensitive masked preview of an API key (never exposes full key).
 */
export function maskApiKey(apiKey: string | null | undefined): string {
  const trimmed = apiKey?.trim();
  if (!trimmed) return "No key (local)";
  if (trimmed.length <= 8) return "••••••••";
  const prefix = trimmed.slice(0, Math.min(6, trimmed.indexOf("-") > 0 ? trimmed.indexOf("-") + 4 : 4));
  const last4 = trimmed.slice(-4);
  return `${prefix}...${last4}`;
}

export function extractKeyLast4(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim();
  if (!trimmed) return null;
  if (trimmed.length < 4) return "••••";
  return trimmed.slice(-4);
}
