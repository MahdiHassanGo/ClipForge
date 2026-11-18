import { NextResponse } from "next/server";
import { revokeCurrentSession } from "@/lib/session";
import { handleApiError } from "@/lib/http";

export async function POST() {
  try {
    await revokeCurrentSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, { route: "POST /api/auth/logout" });
  }
}
