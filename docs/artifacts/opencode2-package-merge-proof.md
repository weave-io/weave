# Separate OpenCode Packages: Merge Verification

> Non-normative evidence for PR #167. See the [V2 core guide](../adapters/opencode2-core.md)
> and [verification procedure](../testing/opencode2-verification.md).

Date: 2026-09-09. Verification ran on the resolved merge of `origin/main`
(`0fff7629`) into the PR branch (`237040d3`), before the merge commit.

## Package decision

V1 remains in `@weaveio/weave-adapter-opencode`, with runtime source unchanged
from remote main. Stale conflict markers in its changelog were removed.
The new native V2 implementation lives in `@weaveio/weave-adapter-opencode2`.
Its root adapter facade remains available; `./server` selects the new core
implementation. No adapter imports source from the other package.

## V1 fallback

`scripts/proof/opencode-v1-active-agent.sh` passed on OpenCode `1.18.9`
with an isolated HOME/XDG environment. The live config dump confirmed Loom
as default, enabled builtins, the disabled-agent exclusion, primary mode,
permissions, composed prompt/delegation text, both commands, the explicit
temperature override, and a custom agent.

## Packaged V2 runtime

`bun scripts/opencode2/verify-runtime.ts` exited zero with all 20 verdicts
passing. It installed the packed V2 package under an isolated HOME/XDG root
and used a deterministic local provider.

- Host: `0.0.0-beta-19151`
- Adapter: `@weaveio/weave-adapter-opencode2@0.1.2`
- Packed tarball SHA-256: `83f7c84ce88ff1129944a664892f50b50954df04aeb764a184878044a121ff35`
- Installed `dist/server.js` SHA-256: `32f0849b685685611377bb150abe2f26136edeb40b3edcf83cb53c804defb316`

The checks cover activation, inventories, composed prompts, model/variant
intent, configured skills, tool policy, plan RPC/commands, collision safety,
foreground and background children, valid/invalid refresh, negative resources,
Location validation, denied delegation, concurrent admission, interruption,
and cleanup. This proves native dispatch, not real-model routing accuracy.

## Repository checks

- Full suite: 5,780 passed, 12 skipped, zero failed.
- Typecheck, build, declaration checks, and documentation links passed.
- Lint passed with existing warnings and informational diagnostics.

The earlier [runtime](opencode2-core-runtime-proof.md) and
[UI](opencode2-core-ui-proof.md) records retain their original pre-merge
identities. No new interactive UI proof is claimed here. Fast mode and strict
per-parent foreground-plus-background concurrency remain configuration intent
only; neither is enforced by the V2 adapter.
