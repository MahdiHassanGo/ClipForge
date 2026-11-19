import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createLogger } from "@clipforge/core";
import { prisma } from "@clipforge/db";
import { ClipWorkerProcessor } from "./processor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(repoRoot, ".env") });

const logger = createLogger("clipforge-worker");
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS) || 2000;

let running = true;

async function main() {
  const processor = new ClipWorkerProcessor({ repoRoot });
  await processor.init();

  let lastCleanup = Date.now();

  const shutdown = async (signal: string) => {
    logger.info("Worker shutting down", { signal });
    running = false;
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Worker polling loop started", { pollIntervalMs });

  while (running) {
    try {
      const didAnalyze = await processor.processNextAnalysisJob();
      const didRender = await processor.processNextRenderExport();
      const didLiveStream = await processor.processNextLiveStreamJob();

      if (Date.now() - lastCleanup > 30 * 60 * 1000) {
        await processor.cleanupStaleTempDirs();
        lastCleanup = Date.now();
      }

      if (!didAnalyze && !didRender && !didLiveStream) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } catch (error) {
      logger.error("Worker loop error", { error });
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 2));
    }
  }

  await prisma.$disconnect();
  logger.info("Worker stopped cleanly");
}

void main();
