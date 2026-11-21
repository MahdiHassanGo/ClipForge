#!/bin/bash
set -eo pipefail

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

# 4. Start Next.js Web App
echo "[Init] Starting Next.js Web App on port ${PORT:-3000}..."
pnpm --filter @clipforge/web exec next start -H 0.0.0.0 -p "${PORT:-3000}" &
WEB_PID=$!
echo "[Init] Next.js Web App started with PID ${WEB_PID}"

# 5. Trap termination signals and forward to child processes
cleanup() {
  echo "[Shutdown] Received termination signal. Stopping services..."
  kill -TERM "$WORKER_PID" 2>/dev/null || true
  kill -TERM "$WEB_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

# 6. Wait for any child process to exit
wait -n "$WORKER_PID" "$WEB_PID"
EXIT_CODE=$?
echo "[Container] A child process exited with code $EXIT_CODE. Shutting down..."
cleanup
exit $EXIT_CODE
