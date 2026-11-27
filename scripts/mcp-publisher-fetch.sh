#!/usr/bin/env bash
# Downloads the MCP Registry publisher (mcp-publisher) into the current
# directory and verifies it before anything runs it. Used by the registry jobs
# in .github/workflows/deploy.yml (scripts/test-ci-gating.js reads this file).
#
#   MCP_PUBLISHER_VERSION  a release tag to pin (e.g. v1.2.3); unset = latest
#   MCP_PUBLISHER_SHA256   the exact tarball digest, for a hard pin
#   GH_API_TOKEN           the job's own token, for api.github.com reads only
#
# api.github.com reads (the latest tag, the release's asset names) go out
# under the job's token: an unauthenticated read shares the runner pool's rate
# limit and is refused 403 when it is spent. Only api.github.com gets the
# header; the github.com downloads stay plain.
set -euo pipefail
gh_api() { curl -fsSL -H "Authorization: Bearer $GH_API_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
asset="mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz"
if [ -n "${MCP_PUBLISHER_VERSION:-}" ]; then base="https://github.com/modelcontextprotocol/registry/releases/download/$MCP_PUBLISHER_VERSION"; else base="https://github.com/modelcontextprotocol/registry/releases/latest/download"; fi
# Download to disk and fail fast (no curl|tar of unverified bytes).
curl -fsSL -o "$asset" "$base/$asset"
# Verify the binary before executing it. Fail CLOSED: require either a
# hard-pinned digest (MCP_PUBLISHER_SHA256 repo var) or the release's
# published checksums.txt: never run an unverified download.
verified=""
if [ -n "${MCP_PUBLISHER_SHA256:-}" ]; then
  echo "$MCP_PUBLISHER_SHA256  $asset" | sha256sum -c - && verified=1
fi
if [ -z "$verified" ]; then
  # As of registry v1.7.0+ the checksums file is versioned -
  # registry_<ver>_checksums.txt: instead of a flat checksums.txt.
  # Resolve the actual filename from the GitHub release API rather
  # than guessing, then verify with sha256sum.
  tag_path="${MCP_PUBLISHER_VERSION:-}"
  if [ -z "$tag_path" ]; then
    tag_path=$(gh_api "https://api.github.com/repos/modelcontextprotocol/registry/releases/latest" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)
  fi
  checksums_name=$(gh_api "https://api.github.com/repos/modelcontextprotocol/registry/releases/tags/$tag_path" \
    | grep -oP '"name":\s*"\K[^"]*_checksums\.txt(?=")' | head -1)
  if [ -n "$checksums_name" ]; then
    curl -fsSL -o "$checksums_name" "https://github.com/modelcontextprotocol/registry/releases/download/$tag_path/$checksums_name" 2>/dev/null || true
    if [ -s "$checksums_name" ] && grep -q " $asset\$" "$checksums_name"; then
      grep " $asset\$" "$checksums_name" | sha256sum -c - && verified=1
    fi
  fi
  # Legacy fallback: pre-v1.7.0 releases used a flat checksums.txt.
  if [ -z "$verified" ]; then
    curl -fsSL -o checksums.txt "$base/checksums.txt" 2>/dev/null || true
    if [ -s checksums.txt ] && grep -q " $asset\$" checksums.txt; then
      grep " $asset\$" checksums.txt | sha256sum -c - && verified=1
    fi
  fi
fi
[ -n "$verified" ] || { echo "mcp-publisher could not be verified (no MCP_PUBLISHER_SHA256 and no checksums file): refusing to execute"; exit 1; }
tar -xzf "$asset" mcp-publisher
