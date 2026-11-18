import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Load shared monorepo root .env if present (does not override already-set env vars)
const rootEnvPath = path.resolve(process.cwd(), "../../.env");
if (fs.existsSync(rootEnvPath) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(rootEnvPath);
  } catch {
    // Ignore if already loaded or malformed
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@clipforge/core", "@clipforge/db"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
    ],
  },
};

export default nextConfig;
