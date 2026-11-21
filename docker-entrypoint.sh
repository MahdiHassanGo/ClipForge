#!/bin/sh
set -e

echo "=== Starting ClipForge Production Container ==="

# 1. Ensure storage directories exist on persistent volume
echo "[Init] Setting up storage directories..."
mkdir -p /app/storage/uploads /app/storage/exports /app/tmp/clipforge-worker

# 2. Push Prisma database schema to PostgreSQL
echo "[Init] Pushing Prisma database schema to PostgreSQL..."
pnpm --filter @clipforge/db exec prisma db push --accept-data-loss

# 3. Start Background Worker
echo "[Init] Launching ClipForge Worker..."
node apps/worker/dist/index.js &
WORKER_PID=$!
echo "[Init] Worker started with PID ${WORKER_PID}"

# 4. Handle graceful shutdown
cleanup() {
  echo "[Shutdown] Caught signal, stopping worker and web..."
  kill -TERM "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# 5. Start Next.js Web App in foreground
echo "[Init] Starting Next.js Web App on port ${PORT:-3000}..."
exec pnpm --filter @clipforge/web exec next start -H 0.0.0.0 -p "${PORT:-3000}"
