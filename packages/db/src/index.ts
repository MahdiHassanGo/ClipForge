import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  __clipforgePrisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__clipforgePrisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__clipforgePrisma = prisma;
}

export * from "@prisma/client";
