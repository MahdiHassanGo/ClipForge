import { redirect, notFound } from "next/navigation";
import { prisma } from "@clipforge/db";
import { getCurrentUser } from "@/lib/session";
import { getAppCapabilities } from "@/lib/env";
import { serializeJson } from "@/lib/http";
import { listUserAiProviders } from "@/lib/ai-provider-store";
import { JobWorkspaceClient } from "@/components/job-workspace-client";
import type {
  AiProviderDto,
  ClipJobDetailDto,
  JobChatMessageDto,
} from "@/components/types";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/");
  }

  const { jobId } = await params;

  const [job, aiProviders, chatMessages] = await Promise.all([
    prisma.clipJob.findUnique({
      where: { id: jobId },
      include: {
        candidates: { orderBy: { rank: "asc" } },
        sceneEvents: { orderBy: { timestampSec: "asc" }, take: 500 },
        renderExports: {
          orderBy: { createdAt: "desc" },
          include: {
            clip: { select: { id: true, title: true, rank: true } },
          },
        },
      },
    }),
    listUserAiProviders(user.id),
    prisma.jobChatMessage.findMany({
      where: { jobId, userId: user.id },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
  ]);

  if (!job || job.userId !== user.id) {
    notFound();
  }

  const serialized = serializeJson(job) as ClipJobDetailDto;
  const serializedMessages = serializeJson(chatMessages) as JobChatMessageDto[];
  const capabilities = getAppCapabilities();

  return (
    <JobWorkspaceClient
      user={user}
      capabilities={capabilities}
      initialJob={serialized}
      initialAiProviders={aiProviders as AiProviderDto[]}
      initialChatMessages={serializedMessages}
    />
  );
}
