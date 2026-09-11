#!/usr/bin/env bash
# scripts/proof/opencode-v1-active-agent.sh
#
# PROOF: The V1 @weaveio/weave-adapter-opencode plugin, when installed into
# a real opencode environment, correctly materializes the full Weave
# agent+command surface with Loom as the default agent.
#
# See docs/active-agent-proofs.md for the pattern this script instantiates
# and scripts/proof/lib.sh for the shared toolkit.
#
# Claims asserted (each is a single `jq -e` filter against the real
# `opencode debug config` output — no session, no LLM):
#
#   1. .default_agent == "loom"                              (active agent)
#   2. Every expected builtin agent is present in .agent
#      (loom, shuttle, pattern, tapestry, thread, weft, warp)
#      — spindle is intentionally disabled by the user config
#      and MUST be absent                                    (materialization
#                                                             + disable
#                                                             semantics)
#   3. Loom's mode is "primary"                              (mode surface)
#   4. Loom's tool policy maps into the harness permission
#      shape (.permission is a non-empty object with
#      known-mapped keys)                                    (tool policy)
#   5. Loom's prompt is composed and rendered — the
#      builtin prompt header AND the delegation section
#      appear literally in the resolved prompt string        (prompt
#                                                             composition)
#   6. Both Weave slash commands are registered:
#      "start-work" and "weave:start"                        (command
#                                                             registration)
#   7. The user override of Loom's temperature (0.42) took
#      effect end-to-end                                     (user override
#                                                             merge)
#   8. The custom user agent `proof-scout` was materialized
#      with its inline prompt                                (custom agent
#                                                             merge)
#
# Success: exit 0. Failure: exit non-zero identifying which claim broke.

set -euo pipefail

PROOF_TAG="proof:v1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./lib.sh
source "${REPO_ROOT}/scripts/proof/lib.sh"

PKG_DIR="${REPO_ROOT}/packages/adapters/opencode"
PLUGIN_ENTRY="${PKG_DIR}/dist/plugin.js"

# --- Preflight --------------------------------------------------------------
proof_require_bins opencode jq bun
proof_log "opencode version: $(opencode --version 2>&1 | head -1)"

# --- Build the V1 adapter locally -------------------------------------------
proof_build_adapter \
  "${PKG_DIR}" \
  "${PKG_DIR}/dist" \
  ./src/index.ts ./src/plugin.ts \
  -- \
  "@opencode-ai/plugin" "@opencode-ai/sdk" mustache neverthrow zod
[ -f "${PLUGIN_ENTRY}" ] || proof_fail "expected build output missing: ${PLUGIN_ENTRY}"
proof_ok "adapter built: ${PLUGIN_ENTRY}"

# --- Stage ephemeral project + install plugin via file:// URL ---------------
PROOF_DIR="$(proof_make_project weave-v1-proof)"
trap 'rm -rf "${PROOF_DIR}"' EXIT
proof_log "Ephemeral project: ${PROOF_DIR}"

# Isolated opencode config/data/state homes so ambient user config (e.g. a
# globally-installed @weaveio/weave-adapter-opencode) can never contaminate
# the proof. This is what "hermetic" actually means.
export XDG_CONFIG_HOME="${PROOF_DIR}/.xdg/config"
export XDG_DATA_HOME="${PROOF_DIR}/.xdg/data"
export XDG_STATE_HOME="${PROOF_DIR}/.xdg/state"
export XDG_CACHE_HOME="${PROOF_DIR}/.xdg/cache"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${XDG_STATE_HOME}" "${XDG_CACHE_HOME}"

cat > "${PROOF_DIR}/opencode.jsonc" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://${PLUGIN_ENTRY}"]
}
JSON
proof_ok "plugin installed via opencode.jsonc: file://${PLUGIN_ENTRY}"

# Non-empty user config that exercises real Weave features end-to-end:
#   - override an existing builtin agent's temperature
#   - disable one builtin agent
#   - define one custom user agent with an inline prompt
# The proof then asserts the merge semantics were honoured by the real
# harness (not just by @weaveio/weave-config in isolation).
cat > "${PROOF_DIR}/.weave/config.weave" <<'WEAVE'
# Non-empty user config: override loom temperature, disable spindle,
# add a custom agent. Exercised end-to-end by the real opencode CLI.

agent loom {
  temperature 0.42
}

agent proof-scout {
  description "Custom user agent added by the active-agent proof"
  prompt "You are proof-scout, a bespoke scout agent."
  mode subagent
  temperature 0.7
}

disable agents ["spindle"]
WEAVE
proof_ok "wrote non-empty .weave/config.weave (override + disable + custom agent)"

# --- Probe: opencode debug config (introspection, no LLM, no session) -------
proof_log "Running: opencode debug config (hermetic XDG_*_HOME)"
CONFIG_JSON="$(cd "${PROOF_DIR}" && opencode debug config 2>/dev/null)" \
  || proof_fail "opencode debug config exited non-zero"

# ---------------------------------------------------------------------------
# Assertions. Each `proof_assert_json` is one atomic claim; a failure
# reports which claim broke and dumps a compact preview for triage.
# ---------------------------------------------------------------------------

# 1. default_agent == "loom"
proof_assert_json "${CONFIG_JSON}" \
  '.default_agent == "loom"' \
  'default_agent == "loom"'

# 2. Expected builtin agents present, AND `spindle` is absent (disabled by
#    user config). This exercises both the materialization surface AND the
#    disable semantics end-to-end through the real harness.
proof_assert_json "${CONFIG_JSON}" \
  '. as $c
   | (["loom","shuttle","pattern","tapestry","thread","weft","warp"]
       | all(. as $name | ($c.agent[$name] != null)))
     and ($c.agent.spindle == null)' \
  'builtins present (loom,shuttle,pattern,tapestry,thread,weft,warp) AND spindle disabled'

# 3. Loom's mode is "primary" — proves the mode surface flows through the
#    adapter's translate-agent path.
proof_assert_json "${CONFIG_JSON}" \
  '.agent.loom.mode == "primary"' \
  'loom.mode == "primary"'

# 4. Loom's tool policy actually mapped into the harness permission shape.
#    We don't hard-code every mapped key (that would over-couple to the
#    current mapping table); we assert the shape is a non-empty object AND
#    contains at least one of the well-known mapped capabilities.
proof_assert_json "${CONFIG_JSON}" \
  '(.agent.loom.permission | type == "object")
   and ((.agent.loom.permission | length) > 0)
   and ((.agent.loom.permission | keys) as $k
        | (($k | index("edit")) != null) or (($k | index("bash")) != null))' \
  'loom.permission is a non-empty object with mapped tool keys'

# 5. Prompt composition ran end-to-end: builtin prompt content AND the
#    delegation section both appear literally in the resolved prompt.
#    This proves Mustache rendered `{{{delegation.section}}}` and the
#    engine composed the final prompt string.
proof_assert_json "${CONFIG_JSON}" \
  '(.agent.loom.prompt | type == "string")
   and ((.agent.loom.prompt | length) > 500)
   and (.agent.loom.prompt | contains("loom — Main Orchestrator"))
   and (.agent.loom.prompt | contains("Delegation"))' \
  'loom.prompt is composed with builtin content AND delegation section'

# 6. Slash commands are registered.
proof_assert_json "${CONFIG_JSON}" \
  '(.command // {} | keys) as $k
   | (($k | index("start-work")) != null)
   and (($k | index("weave:start")) != null)' \
  'commands registered: start-work, weave:start'

# 7. User override of loom's temperature took effect end-to-end.
proof_assert_json "${CONFIG_JSON}" \
  '.agent.loom.temperature == 0.42' \
  'user override applied: loom.temperature == 0.42'

# 8. Custom user agent materialized with its inline prompt.
proof_assert_json "${CONFIG_JSON}" \
  '(.agent["proof-scout"] // null) as $s
   | ($s != null)
   and ($s.mode == "subagent")
   and ($s.prompt | contains("proof-scout"))' \
  'custom user agent proof-scout materialized with inline prompt'

proof_done "V1: default agent + full builtin surface + prompt + commands + user overrides all check out"
