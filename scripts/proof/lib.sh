#!/usr/bin/env bash
# scripts/proof/lib.sh
#
# Shared shell library for harness "active-agent" proofs.
#
# The proof pattern (see docs/opencode-proofs.md for the canonical write-up):
#
#   1. Preflight: assert required binaries are on PATH.
#   2. Build:     targeted `bun build` of the adapter to a known dist path.
#   3. Stage:     mktemp -d; write a minimal ephemeral harness project with
#                 - a `.weave/config.weave` (empty — builtins compose Loom)
#                 - a harness config file that installs the plugin via a
#                   file:// URL / directory reference to the just-built dist.
#   4. Probe:     run a harness INTROSPECTION command (never a session, never
#                 an LLM). Deterministic, fast, offline, free.
#   5. Assert:    one concrete claim about `loom`, via `jq` or exit code.
#
# Every per-harness proof script sources this library, then only supplies:
#   - the harness CLI binary name
#   - the adapter package directory
#   - the build entry points
#   - the config-file writer
#   - the introspection command
#   - the single assertion
#
# Do NOT put harness-specific logic here. This file is a toolkit; the proof
# scripts are the specifications.

# Guard against double-sourcing.
if [ "${_WEAVE_PROOF_LIB_SOURCED:-0}" = "1" ]; then
  return 0
fi
_WEAVE_PROOF_LIB_SOURCED=1

set -euo pipefail

# Ensure common install locations are on PATH so non-interactive shells (CI,
# hooks) find bun and locally-installed harness CLIs.
export PATH="${HOME}/.bun/bin:${HOME}/.opencode/bin:${PATH}"

# ---------------------------------------------------------------------------
# Logging helpers. Every proof script sets PROOF_TAG (e.g. "proof:v1") before
# sourcing, or falls back to "proof".
# ---------------------------------------------------------------------------
: "${PROOF_TAG:=proof}"

proof_log()  { printf "\033[1;34m[%s]\033[0m %s\n" "${PROOF_TAG}" "$*" >&2; }
proof_ok()   { printf "\033[1;32m[%s] PASS:\033[0m %s\n" "${PROOF_TAG}" "$*" >&2; }
proof_fail() { printf "\033[1;31m[%s] FAIL:\033[0m %s\n" "${PROOF_TAG}" "$*" >&2; exit 1; }
proof_done() { printf "\n\033[1;32m==> %s PROOF PASSED: %s\033[0m\n" "${PROOF_TAG}" "$*" >&2; }

# ---------------------------------------------------------------------------
# Preflight: require every named binary to be on PATH. Fails fast with a
# specific error identifying which binary is missing.
# ---------------------------------------------------------------------------
proof_require_bins() {
  local bin
  for bin in "$@"; do
    command -v "${bin}" >/dev/null 2>&1 \
      || proof_fail "required binary not on PATH: ${bin}"
  done
}

# ---------------------------------------------------------------------------
# Targeted adapter build. Uses `bun build` directly (not the public-package
# release script) so proofs are decoupled from packaging / API-Extractor.
#
# Usage:
#   proof_build_adapter <pkg_dir> <outdir> <entry1.ts> [entry2.ts ...] \
#     -- <external_pkg1> [external_pkg2 ...]
#
# The `--` separator divides source entry points from `--external` deps.
# Workspace @weaveio/* packages are intentionally NOT external — they are
# bundled directly into dist/, matching what verify:opencode2 does.
# ---------------------------------------------------------------------------
proof_build_adapter() {
  local pkg_dir="$1"; shift
  local outdir="$1"; shift

  local entries=()
  local externals=()
  local seen_sep=0
  local arg
  for arg in "$@"; do
    if [ "${arg}" = "--" ]; then
      seen_sep=1
      continue
    fi
    if [ "${seen_sep}" -eq 0 ]; then
      entries+=("${arg}")
    else
      externals+=("--external" "${arg}")
    fi
  done

  [ "${#entries[@]}" -gt 0 ] || proof_fail "proof_build_adapter: no entry points supplied"

  proof_log "Building adapter: pkg=${pkg_dir##*/} entries=${entries[*]}"
  rm -rf "${outdir}"
  mkdir -p "${outdir}"

  (
    cd "${pkg_dir}"
    bun build "${entries[@]}" \
      --outdir "${outdir}" \
      --target bun \
      "${externals[@]}" >/dev/null
  ) || proof_fail "adapter build failed (pkg=${pkg_dir})"
}

# ---------------------------------------------------------------------------
# Create an ephemeral hermetic project directory. The caller receives the
# path via stdout; the caller is responsible for `trap 'rm -rf …' EXIT`.
#
# Every ephemeral project gets an empty `.weave/config.weave` so builtins
# (including Loom) compose. If the caller wants a non-empty config, they
# overwrite the file after this returns.
# ---------------------------------------------------------------------------
proof_make_project() {
  local prefix="${1:-weave-proof}"
  local dir
  dir="$(mktemp -d -t "${prefix}-XXXXXX")"
  mkdir -p "${dir}/.weave"
  cat > "${dir}/.weave/config.weave" <<'WEAVE'
# Intentionally empty. Builtin agents (including `loom`) are composed by
# @weaveio/weave-config.
WEAVE
  printf "%s\n" "${dir}"
}

# ---------------------------------------------------------------------------
# Assert a JSON blob (passed via stdin OR as $1) matches a `jq -e` filter.
# On failure, prints a short summary of the JSON for debugging.
#
# Usage:
#   proof_assert_json "$config_json" '.default_agent == "loom"' \
#     "default_agent is loom"
# ---------------------------------------------------------------------------
proof_assert_json() {
  local json="$1"
  local filter="$2"
  local claim="$3"

  echo "${json}" | jq . >/dev/null 2>&1 \
    || proof_fail "assertion input is not valid JSON (claim: ${claim})"

  if echo "${json}" | jq -e "${filter}" >/dev/null 2>&1; then
    proof_ok "${claim}"
    return 0
  fi

  # Failure: dump a compact preview for diagnosis.
  echo "${json}" | jq '{default_agent, agent_keys: (.agent // {} | keys)}' >&2 || true
  proof_fail "assertion failed: ${filter} (claim: ${claim})"
}
