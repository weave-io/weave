#!/usr/bin/env bash
# `verify:opencode2` orchestrator (Task E1). Runs every independent
# verification layer for the V2 (opencode2) adapter, in order, aborting on
# the first failure and emitting a machine-readable summary.
#
# Layers:
#   1. Isolated unit tests (`bun test`) — V2-only MockPluginContext, no
#      real harness, no container.
#   2. `bun run typecheck` for the V2 package against the exact pinned V2
#      types.
#   3. Embedded SDK integration test — `OpenCode.create({ plugins:
#      [weavePlugin] })` inside the Podman container.
#   4. Real `opencode2` plugin-loader test — loads the built V2 adapter via
#      a fixture `opencode.jsonc`, inside the Podman container.
#   5. Agent-materialization test (embedded SDK) — boots
#      `OpenCode.create({ plugins: [weavePlugin] })` against a fixture
#      project directory with `.weave/config.weave`, then asserts
#      `host.agent.list()` contains a Weave-owned `loom` entry. Runs inside
#      the Podman container.
#   6. Agent-materialization test (real opencode2 CLI) — closes the seam
#      layer 4 left open (marker files prove the real CLI ran the plugin's
#      setup/cleanup but never assert the CLI's own view of agents). Runs
#      the real `opencode2` CLI against a fixture whose plugin-wrapper,
#      after calling the real adapter's `setup(ctx)`, calls
#      `ctx.agent.list()` (envelope-unwrapped per A4) and writes the result
#      to a marker file. The layer reads that marker and asserts the CLI's
#      own ctx surfaces a `loom` entry with the V2 ownership marker. No
#      embedded host is created; the observation is strictly CLI-side. Runs
#      inside the Podman container.
#   7. (Covered by layer 1) Assertions over the materialized V2 agent shape
#      — `system`, structured model ref, ordered `permissions`, `mode`, and
#      the V2-package-local ownership marker — live in
#      `src/__tests__/translate-agent.test.ts` and `src/__tests__/adapter.test.ts`.
#      Idempotence, foreign-agent collision, cleanup/disposal, model
#      catalog, skill list, command registration/execution, and event
#      cancellation live across `src/__tests__/*.test.ts` (see
#      `reconcile-agent.test.ts`, `adapter.test.ts`,
#      `runtime-command-projection.test.ts`, `run-workflow.test.ts`).
#   8. Source-boundary check — `verify/checks/source-boundary.ts`.
#   9. Version-drift check — `verify/checks/version-drift.ts`.
#
# Layers 10 (no real LLM calls) and 11 (no V1 package/binary present) are
# enforced structurally: no layer here ever creates a real session or sends
# a prompt to a model, and the Containerfile (layers 3-4) asserts V1
# absence as an image-build step.
#
# Podman is authoritative. Docker compatibility is optional and
# unsupported — this script only shells out to `podman`.
#
# If Podman is unavailable, layers 3-4 (container-required) are skipped
# with a clear message, and the script exits non-zero (per Task E1's
# instructions: do not silently pass when container layers are skipped).
set -uo pipefail

VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${VERIFY_DIR}/.." && pwd)"
IMAGE_TAG="opencode2-verify:latest"

declare -a SUMMARY=()
OVERALL_STATUS=0

record() {
  local layer="$1"
  local status="$2"
  local detail="$3"
  SUMMARY+=("{\"layer\":\"${layer}\",\"status\":\"${status}\",\"detail\":\"${detail}\"}")
}

abort_on_failure() {
  local layer="$1"
  local status="$2"
  local detail="$3"
  record "${layer}" "${status}" "${detail}"
  if [ "${status}" != "passed" ]; then
    echo "FAIL: layer ${layer} — ${detail}" >&2
    print_summary
    exit 1
  fi
}

print_summary() {
  echo "==> verify:opencode2 summary"
  echo "["
  local first=true
  for entry in "${SUMMARY[@]}"; do
    if [ "${first}" = true ]; then
      first=false
    else
      echo ","
    fi
    printf "  %s" "${entry}"
  done
  echo ""
  echo "]"
}

echo "==> Layer 1/9: isolated unit tests (bun test)"
if (cd "${PKG_DIR}" && bun test) ; then
  abort_on_failure "1-unit-tests" "passed" "bun test exited 0"
else
  abort_on_failure "1-unit-tests" "failed" "bun test exited non-zero"
fi

echo "==> Layer 2/9: typecheck"
if (cd "${PKG_DIR}" && bun run typecheck); then
  abort_on_failure "2-typecheck" "passed" "tsc --noEmit exited 0"
else
  abort_on_failure "2-typecheck" "failed" "tsc --noEmit exited non-zero"
fi

echo "==> Layer 8/9: source-boundary check"
if (cd "${PKG_DIR}" && bun run verify/checks/source-boundary.ts); then
  abort_on_failure "8-source-boundary" "passed" "no forbidden V1 imports/identifiers found"
else
  abort_on_failure "8-source-boundary" "failed" "forbidden V1 import or identifier found"
fi

echo "==> Layer 9/9: version-drift check"
if (cd "${PKG_DIR}" && bun run verify/checks/version-drift.ts); then
  abort_on_failure "9-version-drift" "passed" "all V2 SDK pins match 0.0.0-beta-19151"
else
  abort_on_failure "9-version-drift" "failed" "a V2 SDK pin has drifted from 0.0.0-beta-19151"
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman required for layers 3-6 (embedded SDK integration, real plugin-loader, embedded materialization, real-CLI materialization)." >&2
  echo "Podman was not found on PATH — layers 3-6 were NOT run." >&2
  abort_on_failure "3-6-container-layers" "skipped-not-run" "podman not found on PATH; layers 3-6 require Podman and were not executed"
fi

echo "==> Staging build context for Podman"
BUILD_STAGE="${VERIFY_DIR}/.build"
rm -rf "${BUILD_STAGE}"
mkdir -p "${BUILD_STAGE}/adapter/dist"

echo "==> Building adapter bundle (bun build) for the container"
if ! (cd "${PKG_DIR}" && bun build ./src/index.ts \
  --outdir "${BUILD_STAGE}/adapter/dist" \
  --target bun \
  --external @opencode-ai/plugin --external @opencode-ai/sdk \
  --external @opencode-ai/client --external mustache \
  --external neverthrow --external zod); then
  abort_on_failure "3-6-build" "failed" "bun build of src/index.ts failed"
fi
if ! (cd "${PKG_DIR}" && bun build ./src/server.ts \
  --outdir "${BUILD_STAGE}/adapter/dist" \
  --target bun \
  --external @opencode-ai/plugin --external @opencode-ai/sdk \
  --external @opencode-ai/client --external mustache \
  --external neverthrow --external zod); then
  abort_on_failure "3-6-build" "failed" "bun build of src/server.ts failed"
fi

# Container-facing package.json: exports map only, no workspace:* deps (the
# private @weaveio/weave-* packages are bundled directly into dist/ by the
# `bun build` calls above, so no runtime dependency on them is declared
# here).
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

echo "==> Building Podman image"
if ! podman build -t "${IMAGE_TAG}" -f "${VERIFY_DIR}/Containerfile" "${VERIFY_DIR}"; then
  abort_on_failure "3-6-image-build" "failed" "podman build failed"
fi

echo "==> Layer 3/9: embedded SDK integration test (OpenCode.create)"
if podman run --rm "${IMAGE_TAG}" -c 'cd /work && timeout 30 bun run verify/container-smoke.ts embedded'; then
  abort_on_failure "3-embedded-sdk" "passed" "OpenCode.create + awaitActivation + close completed without throwing"
else
  abort_on_failure "3-embedded-sdk" "failed" "embedded OpenCode.create smoke test failed"
fi

echo "==> Layer 4/9: real opencode2 plugin-loader test"
if podman run --rm -e FIXTURE_DIR=/work/verify/fixtures "${IMAGE_TAG}" -c 'cd /work && timeout 30 bun run verify/container-smoke.ts real-loader'; then
  abort_on_failure "4-real-loader" "passed" "opencode2 run --standalone exited 0 against the fixture opencode.jsonc"
else
  abort_on_failure "4-real-loader" "failed" "real opencode2 plugin-loader smoke test failed"
fi

echo "==> Layer 5/9: agent-materialization test — embedded (Loom via host.agent.list())"
if podman run --rm -e FIXTURE_DIR=/work/verify/fixtures/agent-materialization "${IMAGE_TAG}" -c 'cd /work && timeout 30 bun run verify/container-smoke.ts agent-materialization'; then
  abort_on_failure "5-agent-materialization" "passed" "host.agent.list() reports a Weave-owned loom agent"
else
  abort_on_failure "5-agent-materialization" "failed" "host.agent.list() did not report a Weave-owned loom agent"
fi

echo "==> Layer 6/9: agent-materialization test — real opencode2 CLI (Loom via ctx.agent.list())"
if podman run --rm \
    -e FIXTURE_DIR=/work/verify/fixtures-layer6 \
    -e WEAVE_VERIFY_MARKER_DIR=/tmp/weave-verify-markers-layer6 \
    "${IMAGE_TAG}" -c 'cd /work && timeout 45 bun run verify/container-smoke.ts real-cli-materialization'; then
  abort_on_failure "6-real-cli-materialization" "passed" "real opencode2 CLI's ctx.agent.list() reports a Weave-owned loom agent"
else
  abort_on_failure "6-real-cli-materialization" "failed" "real opencode2 CLI's ctx.agent.list() did not report a Weave-owned loom agent"
fi

print_summary
echo "==> verify:opencode2 — ALL LAYERS PASSED"
exit 0
