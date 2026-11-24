import { NextRequest, NextResponse } from "next/server";
import {
  AI_PROVIDER_CATALOG,
  assertResourceOwnership,
  decryptApiKey,
  testAiProviderSchema,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError } from "@/lib/http";
import { runLlmCompletion } from "@/lib/ai-provider-client";

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const input = testAiProviderSchema.parse(body);

    let provider = input.provider;
    let model = input.model;
    let baseUrl = input.baseUrl;
    let apiKey = input.apiKey;

    if (input.providerId) {
      const saved = await prisma.aiProviderConfig.findUnique({
        where: { id: input.providerId },
      });
      if (!saved) {
        return NextResponse.json(
          { error: "AI provider configuration not found.", code: "NOT_FOUND" },
          { status: 404 },
        );
      }
      assertResourceOwnership({
        actorUserId: user.id,
        ownerUserId: saved.userId,
        resourceName: "AI provider configuration",
      });
      provider = saved.provider;
      model = model ?? saved.model;
      baseUrl = baseUrl ?? saved.baseUrl ?? undefined;
      if (!apiKey && saved.encryptedApiKey) {
        apiKey = decryptApiKey(saved.encryptedApiKey);
      }
    }

    if (!provider || !model) {
      return NextResponse.json(
        { error: "Provider and model are required to test connection.", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    if (AI_PROVIDER_CATALOG[provider].requiresApiKey && !apiKey?.trim()) {
      return NextResponse.json(
        { error: "Please enter an API key before testing.", code: "API_KEY_MISSING" },
        { status: 400 },
      );
    }

    const start = Date.now();
    try {
      const res = await runLlmCompletion({
        creds: { provider, model, baseUrl, apiKey },
        messages: [
          {
            role: "user",
            content: "Reply with the two words: Connection ready",
          },
        ],
        maxTokens: 32,
        timeoutMs: 15_000,
      });

      return NextResponse.json({
        ok: true,
        latencyMs: Date.now() - start,
        modelUsed: res.modelUsed,
        replyPreview: res.content.slice(0, 120) || "Connection ready",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reach AI provider.";
      return NextResponse.json(
        { ok: false, error: message, code: "PROVIDER_TEST_FAILED" },
        { status: 400 },
      );
    }
  } catch (error) {
    return handleApiError(error, { route: "POST /api/ai/providers/test" });
  }
}
