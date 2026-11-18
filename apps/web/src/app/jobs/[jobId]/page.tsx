import { redirect, notFound } from "next/navigation";
import { prisma } from "@clipforge/db";
import { getCurrentUser } from "@/lib/session";
import { getAppCapabilities } from "@/lib/env";
import { serializeJson } from "@/lib/http";
import { JobWorkspaceClient } from "@/components/job-workspace-client";
import type { ClipJobDetailDto } from "@/components/types";

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

  const job = await prisma.clipJob.findUnique({
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
  });

  if (!job || job.userId !== user.id) {
    notFound();
  }

  const serialized = serializeJson(job) as ClipJobDetailDto;
  const capabilities = getAppCapabilities();

  return (
    <JobWorkspaceClient
      user={user}
      capabilities={capabilities}
      initialJob={serialized}
    />
  );
}
