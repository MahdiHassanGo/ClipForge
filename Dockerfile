FROM node:22-bookworm-slim

# Install system dependencies: FFmpeg, python3, curl, ca-certificates, openssl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp for live stream & metadata manifest resolution
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Enable pnpm via Corepack
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate

WORKDIR /app

# Copy dependency manifests first for optimal Docker layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/

# Install workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application source code
COPY . .

# Generate Prisma client and build all workspaces (core, db, worker, web)
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

# Setup entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Expose default HTTP port
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
