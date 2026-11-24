import { NextRequest, NextResponse } from "next/server";
import {
  assertResourceOwnership,
  decryptApiKey,
  jobChatRequestSchema,
} from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { requireUser } from "@/lib/session";
import { handleApiError, serializeJson } from "@/lib/http";
import { runVideoDirectorAgent } from "@/lib/ai-video-agent";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      select: { id: true, userId: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404 });
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "clip job",
    });

    const messages = await prisma.jobChatMessage.findMany({
      where: { jobId, userId: user.id },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    return NextResponse.json({ messages: serializeJson(messages) });
  } catch (error) {
    return handleApiError(error, { route: "GET /api/jobs/[jobId]/chat" });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      select: { id: true, userId: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404 });
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "clip job",
    });

    const body = await request.json();
    const input = jobChatRequestSchema.parse(body);

    const providerConfig = input.providerId
      ? await prisma.aiProviderConfig.findFirst({
          where: { id: input.providerId, userId: user.id, isEnabled: true },
        })
      : (await prisma.aiProviderConfig.findFirst({
          where: { userId: user.id, isEnabled: true, isDefault: true },
        })) ??
        (await prisma.aiProviderConfig.findFirst({
          where: { userId: user.id, isEnabled: true },
          orderBy: { createdAt: "asc" },
        }));

    if (!providerConfig) {
      return NextResponse.json(
        {
          error:
            "No active AI API key connected yet. Connect Claude, ChatGPT, OpenRouter, or a local model in AI Keys first.",
          code: "NO_AI_PROVIDER",
        },
        { status: 400 },
      );
    }

    const apiKey = providerConfig.encryptedApiKey
      ? decryptApiKey(providerConfig.encryptedApiKey)
      : null;

    try {
      const result = await runVideoDirectorAgent({
        userId: user.id,
        jobId,
        providerType: providerConfig.provider,
        creds: {
          provider: providerConfig.provider,
          model: providerConfig.model,
          baseUrl: providerConfig.baseUrl,
          apiKey,
        },
        userMessage: input.message,
        selectedClipId: input.selectedClipId,
      });

      return NextResponse.json({
        userMessage: serializeJson(result.userMessage),
        assistantMessage: serializeJson(result.assistantMessage),
        actions: result.actions,
        jobUpdated: result.jobUpdated,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "AI model request failed.";
      return NextResponse.json(
        { error: message, code: "AI_EXECUTION_ERROR" },
        { status: 502 },
      );
    }
  } catch (error) {
    return handleApiError(error, { route: "POST /api/jobs/[jobId]/chat" });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.clipJob.findUnique({
      where: { id: jobId },
      select: { id: true, userId: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found.", code: "NOT_FOUND" }, { status: 404 });
    }

    assertResourceOwnership({
      actorUserId: user.id,
      ownerUserId: job.userId,
      resourceName: "clip job",
    });

    await prisma.jobChatMessage.deleteMany({
      where: { jobId, userId: user.id },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, { route: "DELETE /api/jobs/[jobId]/chat" });
  }
}
