#!/bin/bash

# Build and push pixdcon Docker image to GHCR
#
# USAGE: ./scripts/build-and-push.sh [TAG]
# EXAMPLES:
#   ./scripts/build-and-push.sh           # latest
#   ./scripts/build-and-push.sh v0.1.0   # versioned
#
# REQUIRES:
#   - Docker logged into GHCR: gh auth login
#   - Or set GH_TOKEN env var

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Get version from package.json or use latest
VERSION="${1:-latest}"
IMAGE="ghcr.io/markus-barta/pixdcon"

echo "[build-and-push] Building ${IMAGE}:${VERSION} (linux/amd64 + linux/arm64)..."

# Multi-platform build: hsb1 is x86_64, but builds may run on Apple Silicon
# --push streams directly to the registry (buildx requirement for multi-platform)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --push \
  .

echo "[build-and-push] ✅ Done!"
echo "  Image: ${IMAGE}:${VERSION}"
echo "  Latest: ${IMAGE}:latest"
