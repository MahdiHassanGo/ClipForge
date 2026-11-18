import { NextRequest, NextResponse } from "next/server";
import { loginSchema, verifyPassword } from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { createUserSession } from "@/lib/session";
import { handleApiError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const input = loginSchema.parse(body);
    const normalizedEmail = input.email.toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      return NextResponse.json(
        { error: "Invalid email or password.", code: "INVALID_CREDENTIALS" },
        { status: 401 },
      );
    }

    await createUserSession(user.id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/auth/login" });
  }
}
