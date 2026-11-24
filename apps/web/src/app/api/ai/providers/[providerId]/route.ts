import { NextRequest, NextResponse } from "next/server";
import {
  assertResourceOwnership,
  encryptApiKey,
  extractKeyLast4,
  updateAiProviderSchema,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError } from "@/lib/http";
import { toSafeAiProviderDto } from "@/lib/ai-provider-store";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    const user = await requireUser();
    const { providerId } = await context.params;

    const existing = await prisma.aiProviderConfig.findUnique({
      where: { id: providerId },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "AI provider configuration not found.", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: existing.userId,
      resourceName: "AI provider configuration",
    });

    const body = await request.json();
    const input = updateAiProviderSchema.parse(body);

    const updated = await prisma.$transaction(async (tx) => {
      if (input.isDefault === true) {
        await tx.aiProviderConfig.updateMany({
          where: { userId: user.id, isDefault: true, id: { not: providerId } },
          data: { isDefault: false },
        });
      }

      const data: {
        label?: string;
        model?: string;
        baseUrl?: string | null;
        encryptedApiKey?: string;
        keyLast4?: string | null;
        isDefault?: boolean;
        isEnabled?: boolean;
      } = {};

      if (input.label !== undefined) data.label = input.label;
      if (input.model !== undefined) data.model = input.model;
      if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl;
      if (input.isDefault !== undefined) data.isDefault = input.isDefault;
      if (input.isEnabled !== undefined) data.isEnabled = input.isEnabled;
      if (input.apiKey && input.apiKey.trim().length > 0) {
        data.encryptedApiKey = encryptApiKey(input.apiKey.trim());
        data.keyLast4 = extractKeyLast4(input.apiKey);
      }

      return tx.aiProviderConfig.update({
        where: { id: providerId },
        data,
      });
    });

    return NextResponse.json({ provider: toSafeAiProviderDto(updated) });
  } catch (error) {
    return handleApiError(error, { route: "PATCH /api/ai/providers/[providerId]" });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    const user = await requireUser();
    const { providerId } = await context.params;

    const existing = await prisma.aiProviderConfig.findUnique({
      where: { id: providerId },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "AI provider configuration not found.", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: existing.userId,
      resourceName: "AI provider configuration",
    });

    await prisma.$transaction(async (tx) => {
      await tx.aiProviderConfig.delete({ where: { id: providerId } });
      if (existing.isDefault) {
        const next = await tx.aiProviderConfig.findFirst({
          where: { userId: user.id, isEnabled: true },
          orderBy: { createdAt: "asc" },
        });
        if (next) {
          await tx.aiProviderConfig.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, { route: "DELETE /api/ai/providers/[providerId]" });
  }
}
