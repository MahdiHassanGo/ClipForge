import crypto from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;

export class AuthorizationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 403, code = "FORBIDDEN") {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (expectedBuf.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(expectedBuf, derivedKey);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, secret?: string): string {
  const pepper = secret ?? process.env.SESSION_SECRET ?? "clipforge-dev-session-secret";
  return crypto.createHmac("sha256", pepper).update(token).digest("hex");
}

export function assertAuthenticated(
  userId: string | null | undefined,
): asserts userId is string {
  if (!userId) {
    throw new AuthorizationError("Authentication required. Please sign in.", 401, "UNAUTHORIZED");
  }
}

export function assertResourceOwnership(params: {
  actorUserId: string | null | undefined;
  ownerUserId: string | null | undefined;
  resourceName?: string;
}): void {
  assertAuthenticated(params.actorUserId);
  if (!params.ownerUserId || params.actorUserId !== params.ownerUserId) {
    throw new AuthorizationError(
      `You do not have permission to access this ${params.resourceName ?? "resource"}.`,
      403,
      "FORBIDDEN",
    );
  }
}
