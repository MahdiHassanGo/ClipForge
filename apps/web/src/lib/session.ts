import { cookies } from "next/headers";
import {
  AuthorizationError,
  generateSessionToken,
  hashSessionToken,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";

export const SESSION_COOKIE_NAME = "clipforge_session";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

function getSessionTtlMs(): number {
  const days = Number(process.env.SESSION_TTL_DAYS) || 14;
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
}

export async function createUserSession(userId: string): Promise<void> {
  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + getSessionTtlMs());

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function revokeCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    const tokenHash = hashSessionToken(rawToken);
    await prisma.session.deleteMany({ where: { tokenHash } }).catch(() => {});
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;

  const tokenHash = hashSessionToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: { id: true, email: true, name: true, createdAt: true },
      },
    },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    createdAt: session.user.createdAt.toISOString(),
  };
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthorizationError("Please sign in to continue.", 401, "UNAUTHORIZED");
  }
  return user;
}
