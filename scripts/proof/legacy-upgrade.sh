#!/usr/bin/env bash
# scripts/proof/legacy-upgrade.sh
#
# PROOF: A user of the legacy `@opencode_weave/weave` OpenCode plugin can
# follow the documented upgrade steps and keep every agent they had.
#
# The steps under test are the ones the legacy README tells users to run:
#
#   1. weave init migrate --scope global   (and --scope local per project)
#   2. weave validate
#   3. swap `@opencode_weave/weave` for `@weaveio/weave-adapter-opencode`
#      in opencode.json, then check `opencode debug config`
#
# Everything runs under a throwaway HOME / XDG sandbox, so the real
# ~/.config/opencode and ~/.weave are never touched. The legacy baseline
# installs the published legacy plugin from npm, so this proof needs network.
#
# Projects (legacy config under .opencode/):
#   p1-categories          legacy examples/config/delegation-categories
#   p2-speckit             legacy examples/config/github-speckit
#                          ($schema + skill_directories only)
#   p3-kitchen-sink        heavily customised, comments + trailing commas,
#                          a prompt_file custom agent
#   p4-json                weave-opencode.json (not .jsonc): not migrated
#   p5-zero-config         plugin line only, no Weave config
#   p6-kitchen-sink-strict p3 without comments or trailing commas
# plus a user-level ~/.config/opencode/weave-opencode.jsonc.
#
# Claims asserted:
#   1. Migration exits 0 for p1, p2, p3, p6 and the user config, and exits 1
#      ("No legacy config found") for p4 and p5.
#   2. No migrated config contains starter-template content.
#   3. Migration reports only genuine warnings (no $schema or
#      "unknown legacy field" noise).
#   4. p3 and p6 produce equivalent configs and prompt files.
#   5. `weave validate` passes in every project.
#   6. Every agent the legacy plugin registered is still registered after
#      the upgrade (builtins, custom agents, category shuttles).
#   7. Every custom agent keeps its description and prompt.
#   8. No upgraded agent carries an unqualified model ID.
#   9. `opencode run --agent loom` in p5 no longer fails with
#      ProviderModelNotFoundError. (It runs with an explicit environment
#      allowlist and no credentials, so it uses OpenCode's free default
#      model or fails on credentials.)
#
# Environment:
#   WEAVE_PROOF_LEGACY_PLUGIN  legacy plugin spec (default @opencode_weave/weave@0.8.1)
#   WEAVE_PROOF_CLI            published CLI spec, e.g. @weaveio/weave-cli@0.2.0;
#                              installed with `bun add --global` into the sandbox
#                              (default: run the CLI from this checkout)
#   WEAVE_PROOF_ADAPTER        published adapter spec for opencode.json, e.g.
#                              @weaveio/weave-adapter-opencode@0.2.0
#                              (default: build the adapter from this checkout)
#   WEAVE_PROOF_KEEP=1         keep the sandbox and print its path
#
# Success: exit 0. Failure: exit non-zero identifying which claim broke.

set -euo pipefail

PROOF_TAG="proof:legacy-upgrade"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./lib.sh
source "${REPO_ROOT}/scripts/proof/lib.sh"

LEGACY_PLUGIN="${WEAVE_PROOF_LEGACY_PLUGIN:-@opencode_weave/weave@0.8.1}"
CLI_SPEC="${WEAVE_PROOF_CLI:-}"
ADAPTER_SPEC="${WEAVE_PROOF_ADAPTER:-}"
FIXTURES="${REPO_ROOT}/scripts/proof/fixtures/legacy-upgrade"
KITCHEN_SINK="${REPO_ROOT}/packages/cli/src/__fixtures__/legacy/kitchen-sink/.opencode"
PKG_DIR="${REPO_ROOT}/packages/adapters/opencode"
PLUGIN_ENTRY="${PKG_DIR}/dist/plugin.js"
WEAVE=(bun "${REPO_ROOT}/packages/cli/src/main.ts")
PROJECTS=(p1-categories p2-speckit p3-kitchen-sink p4-json p5-zero-config p6-kitchen-sink-strict)
MIGRATED=(p1-categories p2-speckit p3-kitchen-sink p6-kitchen-sink-strict)

# --- Preflight --------------------------------------------------------------
proof_require_bins opencode jq bun
proof_log "opencode version: $(opencode --version 2>&1 | head -1)"
proof_log "legacy plugin: ${LEGACY_PLUGIN}"
proof_log "cli: ${CLI_SPEC:-local checkout}"
proof_log "adapter: ${ADAPTER_SPEC:-local build}"

# --- Build the V1 adapter locally (unless testing a published one) ----------
if [ -n "${ADAPTER_SPEC}" ]; then
  UPGRADE_PLUGIN="${ADAPTER_SPEC}"
else
  proof_build_adapter \
    "${PKG_DIR}" \
    "${PKG_DIR}/dist" \
    ./src/index.ts ./src/plugin.ts \
    -- \
    "@opencode-ai/plugin" "@opencode-ai/sdk" mustache neverthrow zod
  [ -f "${PLUGIN_ENTRY}" ] || proof_fail "expected build output missing: ${PLUGIN_ENTRY}"
  proof_ok "adapter built: ${PLUGIN_ENTRY}"
  UPGRADE_PLUGIN="file://${PLUGIN_ENTRY}"
fi

# --- Sandbox ----------------------------------------------------------------
SANDBOX="$(mktemp -d -t weave-legacy-upgrade-XXXXXX)"
if [ "${WEAVE_PROOF_KEEP:-0}" = "1" ]; then
  trap 'proof_log "sandbox kept: ${SANDBOX}"' EXIT
else
  trap 'rm -rf "${SANDBOX}"' EXIT
fi
RESULTS="${SANDBOX}/results"
mkdir -p "${RESULTS}/legacy" "${RESULTS}/upgrade"

# lib.sh already put the real bun and opencode on PATH; from here on HOME is
# the sandbox, so nothing below can read or write the real user config.
export HOME="${SANDBOX}/home"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_DATA_HOME="${HOME}/.local/share"
export XDG_STATE_HOME="${HOME}/.local/state"
export XDG_CACHE_HOME="${HOME}/.cache"
mkdir -p "${XDG_CONFIG_HOME}/opencode" "${XDG_DATA_HOME}" "${XDG_STATE_HOME}" "${XDG_CACHE_HOME}"
# Keep runs free and deterministic: no provider credentials in the sandbox.
unset ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY \
  GOOGLE_GENERATIVE_AI_API_KEY GITHUB_TOKEN GH_TOKEN 2>/dev/null || true

cp "${FIXTURES}/user-config/weave-opencode.jsonc" "${XDG_CONFIG_HOME}/opencode/weave-opencode.jsonc"

# A published CLI is installed the way the upgrade guide says, with
# `bun add --global`, into a sandboxed BUN_INSTALL.
if [ -n "${CLI_SPEC}" ]; then
  export BUN_INSTALL="${HOME}/.bun"
  bun add --global "${CLI_SPEC}" >"${RESULTS}/cli-install.log" 2>&1 \
    || { cat "${RESULTS}/cli-install.log" >&2; proof_fail "bun add --global ${CLI_SPEC} failed"; }
  WEAVE=("${BUN_INSTALL}/bin/weave")
  [ -x "${WEAVE[0]}" ] || proof_fail "weave binary missing after install: ${WEAVE[0]}"
  proof_ok "installed ${CLI_SPEC}"
fi

stage_project() {
  local name="$1" dir="${SANDBOX}/${1}"
  mkdir -p "${dir}/.opencode"
  case "${name}" in
    p1-categories)
      cp "${FIXTURES}/delegation-categories/weave-opencode.jsonc" "${dir}/.opencode/" ;;
    p2-speckit)
      cp "${FIXTURES}/github-speckit/weave-opencode.jsonc" "${dir}/.opencode/" ;;
    p3-kitchen-sink)
      cp -R "${KITCHEN_SINK}/." "${dir}/.opencode/" ;;
    p4-json)
      cp "${FIXTURES}/delegation-categories/weave-opencode.jsonc" "${dir}/.opencode/weave-opencode.json" ;;
    p5-zero-config) ;;
    p6-kitchen-sink-strict)
      cp -R "${KITCHEN_SINK}/." "${dir}/.opencode/"
      (cd "${REPO_ROOT}/packages/cli" && bun -e '
        import { parse } from "jsonc-parser";
        const path = process.argv[1];
        const value = parse(await Bun.file(path).text(), [], { allowTrailingComma: true });
        await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
      ' "${dir}/.opencode/weave-opencode.jsonc") ;;
  esac
}

write_opencode_json() {
  local dir="$1" plugin="$2"
  cat > "${dir}/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["${plugin}"]
}
JSON
}

# OpenCode installs plugin dependencies into each project's .opencode/.
# Drop them between runs so the sandbox stays small.
debug_config() {
  local dir="$1" out="$2"
  (cd "${dir}" && timeout 300 opencode debug config >"${out}" 2>"${out%.json}.stderr") \
    || proof_fail "opencode debug config failed in ${dir##*/} (see ${out%.json}.stderr)"
  rm -rf "${dir}/.opencode/node_modules" "${dir}/.opencode/package.json" "${dir}/.opencode/bun.lock"
  jq -e . "${out}" >/dev/null || proof_fail "debug config output is not JSON: ${out}"
}

for project in "${PROJECTS[@]}"; do stage_project "${project}"; done
proof_ok "staged ${#PROJECTS[@]} projects and a user-level legacy config under ${SANDBOX}"

# --- Baseline: the legacy plugin --------------------------------------------
for project in "${PROJECTS[@]}"; do
  write_opencode_json "${SANDBOX}/${project}" "${LEGACY_PLUGIN}"
  debug_config "${SANDBOX}/${project}" "${RESULTS}/legacy/${project}.json"
done
proof_ok "captured legacy baseline with ${LEGACY_PLUGIN}"

# --- Upgrade: README steps --------------------------------------------------
set +e
(cd "${HOME}" && "${WEAVE[@]}" init migrate --scope global --yes) \
  >"${RESULTS}/upgrade/global.migrate.log" 2>&1
echo $? >"${RESULTS}/upgrade/global.migrate.exit"
set -e

for project in "${PROJECTS[@]}"; do
  dir="${SANDBOX}/${project}"
  set +e
  (cd "${dir}" && "${WEAVE[@]}" init migrate --scope local --yes) \
    >"${RESULTS}/upgrade/${project}.migrate.log" 2>&1
  echo $? >"${RESULTS}/upgrade/${project}.migrate.exit"
  if [ "${project}" = "p4-json" ]; then
    # The legacy README tells .json users to rename to .jsonc first.
    mv "${dir}/.opencode/weave-opencode.json" "${dir}/.opencode/weave-opencode.jsonc"
    (cd "${dir}" && "${WEAVE[@]}" init migrate --scope local --yes) \
      >"${RESULTS}/upgrade/${project}.renamed.migrate.log" 2>&1
    echo $? >"${RESULTS}/upgrade/${project}.renamed.migrate.exit"
  fi
  (cd "${dir}" && "${WEAVE[@]}" validate) \
    >"${RESULTS}/upgrade/${project}.validate.log" 2>&1
  echo $? >"${RESULTS}/upgrade/${project}.validate.exit"
  set -e
  write_opencode_json "${dir}" "${UPGRADE_PLUGIN}"
  debug_config "${dir}" "${RESULTS}/upgrade/${project}.json"
done
proof_ok "ran weave init migrate + weave validate and captured upgraded debug config"

# --- p5: run Loom (claim 9) --------------------------------------------------
# This is the only step that can reach a model provider, so it runs with an
# explicit environment allowlist: no inherited credentials of any kind (AWS,
# Azure, Vertex, provider API keys) can reach it.
set +e
(cd "${SANDBOX}/p5-zero-config" && env -i \
  PATH="${PATH}" HOME="${HOME}" TMPDIR="${TMPDIR:-/tmp}" TERM="${TERM:-dumb}" \
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" XDG_DATA_HOME="${XDG_DATA_HOME}" \
  XDG_STATE_HOME="${XDG_STATE_HOME}" XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
  timeout 180 opencode run --agent loom "Reply with the single word: ready") \
  >"${RESULTS}/upgrade/p5-zero-config.run.log" 2>&1
echo $? >"${RESULTS}/upgrade/p5-zero-config.run.exit"
set -e
rm -rf "${SANDBOX}/p5-zero-config/.opencode/node_modules"

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

exit_code() { cat "${RESULTS}/upgrade/${1}.exit"; }

# 1. Migration exit codes.
[ "$(exit_code global.migrate)" = "0" ] || proof_fail "global migration exited $(exit_code global.migrate)"
for project in "${MIGRATED[@]}"; do
  [ "$(exit_code "${project}.migrate")" = "0" ] \
    || proof_fail "${project}: migration exited $(exit_code "${project}.migrate")"
done
for project in p4-json p5-zero-config; do
  [ "$(exit_code "${project}.migrate")" = "1" ] \
    && grep -q "No legacy config found" "${RESULTS}/upgrade/${project}.migrate.log" \
    || proof_fail "${project}: expected 'No legacy config found' (exit 1)"
done
[ "$(exit_code p4-json.renamed.migrate)" = "0" ] \
  || proof_fail "p4-json: migration after renaming to .jsonc exited $(exit_code p4-json.renamed.migrate)"
proof_ok "migration exits 0 for p1, p2, p3, p6 and the user config; 1 with 'No legacy config found' for p4 (.json, then 0 after the README rename) and p5"

# 2. No starter-template content anywhere.
CONFIGS=("${HOME}/.weave/config.weave" "${SANDBOX}/p4-json/.weave/config.weave")
for project in "${MIGRATED[@]}"; do CONFIGS+=("${SANDBOX}/${project}/.weave/config.weave"); done
for config in "${CONFIGS[@]}"; do
  [ -f "${config}" ] || proof_fail "missing migrated config: ${config}"
  if grep -Eq "Weave starter config|workflow quick-fix|^continuation|^analytics" "${config}"; then
    proof_fail "starter-template content in ${config}"
  fi
done
proof_ok "no migrated config contains starter-template content"

# 3. Only genuine warnings.
if grep -lE '\$schema|unknown legacy field' "${RESULTS}"/upgrade/*.migrate.log >&2; then
  proof_fail "migration reported \$schema or unknown-field warnings (files above)"
fi
proof_ok "migration warnings are genuine (no \$schema / unknown-field noise)"

# 4. p3 (trailing commas) and p6 (strict JSON) migrate identically.
diff <(grep -v '^# Source:' "${SANDBOX}/p3-kitchen-sink/.weave/config.weave") \
     <(grep -v '^# Source:' "${SANDBOX}/p6-kitchen-sink-strict/.weave/config.weave") >&2 \
  || proof_fail "p3 and p6 migrated configs differ"
diff -r "${SANDBOX}/p3-kitchen-sink/.weave/prompts" "${SANDBOX}/p6-kitchen-sink-strict/.weave/prompts" >&2 \
  || proof_fail "p3 and p6 migrated prompt files differ"
proof_ok "p3 (comments + trailing commas) and p6 (strict JSON) produce equivalent configs"

# 5. weave validate passes everywhere.
for project in "${PROJECTS[@]}"; do
  [ "$(exit_code "${project}.validate")" = "0" ] \
    || proof_fail "${project}: weave validate exited $(exit_code "${project}.validate")"
done
proof_ok "weave validate passes in every project"

# 6–8. Compare each project's agents with the legacy baseline. Legacy keys
# Loom and Tapestry by display name ("Loom (Main Orchestrator)"); the adapter
# appends an ownership tag to descriptions.
BUILTINS='["loom","tapestry","shuttle","pattern","thread","spindle","weft","warp"]'
for project in "${PROJECTS[@]}"; do
  report="$(jq -n \
    --slurpfile legacy "${RESULTS}/legacy/${project}.json" \
    --slurpfile upgrade "${RESULTS}/upgrade/${project}.json" \
    --argjson builtins "${BUILTINS}" '
    def canon: ascii_downcase | split(" ") | .[0];
    def desc: (. // "") | sub(" ?\\[weave-managed\\]"; "");
    def trimmed: (. // "") | gsub("^\\s+|\\s+$"; "");
    def custom: select((. as $k | $builtins | index($k)) == null)
      | select(startswith("shuttle-") | not);
    ($legacy[0].agent // {} | with_entries(.key |= canon)) as $old
    | ($upgrade[0].agent // {}) as $new
    | {
        missing: [$old | keys[] | select($new[.] == null)],
        custom: [$old | keys[] | custom],
        custom_mismatch: [
          $old | to_entries[] | select(.key | custom != null)
          | select(
              ($new[.key] == null)
              or ((.value.description | desc) != ($new[.key].description | desc))
              or ((.value.prompt | trimmed) != ($new[.key].prompt | trimmed)))
          | .key
        ],
        bare_models: [
          $new | to_entries[]
          | select(.value.model != null
              and (.value.model | test("^[^/\\s]+/\\S+$") | not))
          | "\(.key)=\(.value.model)"
        ]
      }')"
  echo "${report}" >"${RESULTS}/upgrade/${project}.compare.json"
  echo "${report}" | jq -e '.missing == []' >/dev/null \
    || proof_fail "${project}: agents missing after upgrade: $(echo "${report}" | jq -c .missing)"
  echo "${report}" | jq -e '.custom_mismatch == []' >/dev/null \
    || proof_fail "${project}: custom agent description/prompt changed: $(echo "${report}" | jq -c .custom_mismatch)"
  echo "${report}" | jq -e '.bare_models == []' >/dev/null \
    || proof_fail "${project}: unqualified model IDs: $(echo "${report}" | jq -c .bare_models)"
  proof_ok "${project}: every legacy agent present; custom agents $(echo "${report}" | jq -c .custom) keep description + prompt; no bare models"
done

# 9. p5 no longer fails on the bare builtin default model.
if grep -Eq "ProviderModelNotFoundError|Model not found: claude-sonnet-4-5" \
  "${RESULTS}/upgrade/p5-zero-config.run.log"; then
  cat "${RESULTS}/upgrade/p5-zero-config.run.log" >&2
  proof_fail "p5: opencode run --agent loom still fails on a bare model"
fi
proof_ok "p5: opencode run --agent loom does not fail with ProviderModelNotFoundError (exit $(exit_code p5-zero-config.run))"

proof_done "legacy ${LEGACY_PLUGIN} users keep every agent, description, and prompt after the documented upgrade"
