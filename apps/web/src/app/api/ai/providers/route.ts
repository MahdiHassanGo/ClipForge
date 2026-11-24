import { NextRequest, NextResponse } from "next/server";
import {
  AI_PROVIDER_LIST,
  createAiProviderSchema,
  encryptApiKey,
  extractKeyLast4,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError } from "@/lib/http";
import { listUserAiProviders, toSafeAiProviderDto } from "@/lib/ai-provider-store";

export async function GET() {
  try {
    const user = await requireUser();
    const providers = await listUserAiProviders(user.id);
    return NextResponse.json({
      providers,
      catalog: AI_PROVIDER_LIST,
    });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/ai/providers" });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const input = createAiProviderSchema.parse(body);

    const existingCount = await prisma.aiProviderConfig.count({
      where: { userId: user.id },
    });
    const shouldBeDefault = input.isDefault || existingCount === 0;

    const encryptedApiKey = input.apiKey?.trim()
      ? encryptApiKey(input.apiKey.trim())
      : null;
    const keyLast4 = extractKeyLast4(input.apiKey);

    const created = await prisma.$transaction(async (tx) => {
      if (shouldBeDefault) {
        await tx.aiProviderConfig.updateMany({
          where: { userId: user.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.aiProviderConfig.create({
        data: {
          userId: user.id,
          provider: input.provider,
          label: input.label,
          model: input.model,
          baseUrl: input.baseUrl ?? null,
          encryptedApiKey,
          keyLast4,
          isDefault: shouldBeDefault,
          isEnabled: true,
        },
      });
    });

    return NextResponse.json(
      { provider: toSafeAiProviderDto(created) },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error, { route: "POST /api/ai/providers" });
  }
}
