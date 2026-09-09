#!/usr/bin/env bash
# scripts/proof/opencode-v2-active-agent.sh
#
# PROOF: The V2 @weaveio/weave-adapter-opencode2 plugin, when installed into
# a real opencode2 CLI environment, materializes `loom` as a Weave-owned
# agent that the real CLI's own ctx.agent.list() reports.
#
# See docs/opencode-proofs.md for the pattern this script instantiates and
# scripts/proof/lib.sh for the shared toolkit.
#
# Why not `default_agent`? V2's plugin surface does not yet expose that
# field (see docs/opencode2-adapter.md and ADR 0010). The strongest
# verifiable "active agent" claim on V2 today is that the real CLI's ctx
# sees Loom as a Weave-owned agent. This mirrors Layer 6 of the full
# `verify:opencode2` harness, exposed as a single-command proof.
#
# Success: exit 0. Failure: exit non-zero with a specific reason on stderr.

set -euo pipefail

PROOF_TAG="proof:v2"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./lib.sh
source "${REPO_ROOT}/scripts/proof/lib.sh"

PKG_DIR="${REPO_ROOT}/packages/adapters/opencode2"
VERIFY_DIR="${PKG_DIR}/verify"
IMAGE_TAG="opencode2-proof:latest"
BUILD_STAGE="${VERIFY_DIR}/.build"

# --- Preflight --------------------------------------------------------------
proof_require_bins podman bun

# --- Build V2 adapter into the Podman build context -------------------------
proof_build_adapter \
  "${PKG_DIR}" \
  "${BUILD_STAGE}/adapter/dist" \
  ./src/index.ts ./src/server.ts \
  -- \
  "@opencode-ai/plugin" "@opencode-ai/sdk" "@opencode-ai/client" \
  mustache neverthrow zod

cat > "${BUILD_STAGE}/adapter/package.json" <<'JSON'
{
  "name": "@weaveio/weave-adapter-opencode2",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "exports": {
    ".": { "import": "./dist/index.js" },
    "./server": { "import": "./dist/server.js" }
  }
}
JSON
proof_ok "V2 adapter built into ${BUILD_STAGE}/adapter/dist"

# --- Build the Podman image (pinned opencode2 SDK + CLI) --------------------
proof_log "Building Podman image (pinned opencode2 SDK + CLI)..."
podman build -t "${IMAGE_TAG}" -f "${VERIFY_DIR}/Containerfile" "${VERIFY_DIR}" >/dev/null \
  || proof_fail "podman build failed"
proof_ok "image built: ${IMAGE_TAG}"

# --- Probe + Assert: real opencode2 CLI reports Weave-owned primary agents -
# The fixture's plugin-wrapper calls ctx.agent.list() after the real
# adapter's setup(ctx) and writes a marker file the extended smoke reads.
# V2's ctx.agent.list() surfaces only primary-mode agents in a summary
# shape (no permission, no prompt) — see issue #165. Assertions here match
# what that surface actually exposes:
#
#   A. plugin setup + cleanup ran (lifecycle)
#   B. ctx.agent.list() succeeded, non-empty
#   C. Both primary-mode Weave builtins present: loom + tapestry
#   D. Both are Weave-owned (ownership marker on description)
#   E. Both have a mode string reported by the CLI
#
# subagent-mode builtins (shuttle, pattern, thread, spindle, weft, warp),
# tool-policy → permission mapping, and prompt composition are all covered
# by V2 unit tests against MockPluginContext — see
# packages/adapters/opencode2/src/__tests__/. When V2 grows a
# resolved-config dump (issue #165), those claims move here too.
proof_log "Running real opencode2 CLI against fixture; asserting full observable active-agent surface..."
if podman run --rm \
    -e FIXTURE_DIR=/work/verify/fixtures-layer6 \
    -e WEAVE_VERIFY_MARKER_DIR=/tmp/weave-verify-markers-layer6 \
    "${IMAGE_TAG}" -c 'cd /work && timeout 60 bun run verify/container-smoke.ts active-agent-proof-extended'; then
  proof_ok "real opencode2 CLI: both primary Weave builtins (loom + tapestry) present, Weave-owned, mode-labelled"
  proof_done "V2: full observable active-agent surface materialized end-to-end via real opencode2 CLI"
else
  proof_fail "extended active-agent proof failed inside real opencode2 CLI"
fi
