import { NextResponse } from "next/server";
import { getAppCapabilities } from "@/lib/env";

export async function GET() {
  return NextResponse.json({
    ok: true,
    capabilities: getAppCapabilities(),
  });
}
