#!/bin/bash

# Build and push pixdcon Docker image to GHCR
#
# USAGE: ./scripts/build-and-push.sh [TAG]
# EXAMPLES:
#   ./scripts/build-and-push.sh             # version.json + latest
#   ./scripts/build-and-push.sh v<version>   # must match version.json
#
# REQUIRES:
#   - Docker logged into GHCR: gh auth login
#   - Or set GH_TOKEN env var

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Use the reserved canonical coordinate; an optional tag must match it.
if (( $# > 1 )); then
  echo "Usage: ./scripts/build-and-push.sh [v<version>]" >&2
  exit 1
fi
VERSION="$(node scripts/verify-versioning.mjs)"
if (( $# == 1 )); then
  node scripts/verify-versioning.mjs --tag "v${1#v}" > /dev/null
fi
node scripts/verify-versioning-bundle.mjs
IMAGE="ghcr.io/markus-barta/pixdcon"

echo "[build-and-push] Building ${IMAGE}:${VERSION} (linux/amd64 + linux/arm64)..."

# Multi-platform build: hsb1 is x86_64, but builds may run on Apple Silicon
# --push streams directly to the registry (buildx requirement for multi-platform)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --label "org.opencontainers.image.version=${VERSION}" \
  --label "org.opencontainers.image.version_scheme=inspr-calver-3" \
  --push \
  .

echo "[build-and-push] ✅ Done!"
echo "  Image: ${IMAGE}:${VERSION}"
echo "  Latest: ${IMAGE}:latest"
