import { NextRequest, NextResponse } from "next/server";
import { hashPassword, registerSchema } from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { createUserSession } from "@/lib/session";
import { handleApiError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = registerSchema.parse(body);
    const normalizedEmail = input.email.toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists.", code: "EMAIL_EXISTS" },
        { status: 409 },
      );
    }

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name: input.name,
        passwordHash,
      },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    await createUserSession(user.id);

    return NextResponse.json(
      {
        user: {
          ...user,
          createdAt: user.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/auth/register" });
  }
}
