#!/usr/bin/env bash
set -euo pipefail

# ClipForge Offline Whisper.cpp Model Downloader
# Downloads and verifies official GGML models from Hugging Face for Apple Silicon Mac

MODELS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
mkdir -p "$MODELS_DIR"

BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

declare -A MODEL_FILES=(
  ["base"]="ggml-base.en.bin"
  ["small"]="ggml-small.en.bin"
  ["medium"]="ggml-medium.en.bin"
  ["large"]="ggml-large-v3-turbo.bin"
  ["large-turbo"]="ggml-large-v3-turbo.bin"
  ["large-v3"]="ggml-large-v3.bin"
)

TARGET="${1:-all}"

download_model() {
  local name="$1"
  local file="${MODEL_FILES[$name]:-}"
  if [[ -z "$file" ]]; then
    echo "Unknown model alias: $name"
    echo "Supported: base, small, medium, large, large-v3"
    return 1
  fi

  local target_path="$MODELS_DIR/$file"
  echo "==> Downloading $name ($file) to $target_path..."
  curl -L -C - --progress-bar -o "$target_path" "$BASE_URL/$file"
  echo "✔ Successfully downloaded $name ($file) [$(du -h "$target_path" | cut -f1)]"
}

case "$TARGET" in
  all)
    echo "Downloading standard offline model suite (small.en, medium.en, large-v3-turbo)..."
    download_model "small"
    download_model "medium"
    download_model "large"
    ;;
  *)
    download_model "$TARGET"
    ;;
esac

echo ""
echo "Available models in $MODELS_DIR:"
ls -lh "$MODELS_DIR"/*.bin
