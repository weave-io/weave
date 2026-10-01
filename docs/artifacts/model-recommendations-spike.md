# Spike: model recommendations on a live OpenCode 2 host

**Spec**: [Spec 39 — Model Recommendations](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md) · **Issue**: #275 · **Date**: 2026-10-01 · **Host**: `@opencode/cli@2.0.16`, Bun 1.4.2 · **Code**: branch `spike/model-recommendations` (throwaway, not for merge)

This spike tests the riskiest parts of Spec 39 end to end before any production code: signature verification, the config layer, and a live model change on OpenCode 2 without a restart. The spike code is deliberately rough (one module in `@weaveio/weave-config`, a few lines in the OpenCode 2 plugin, and a keygen/sign/serve tool) and is not meant to merge.

## Summary

| Question | Answer |
| --- | --- |
| 1. Can Bun verify Ed25519 without a dependency? | **Yes.** `crypto.subtle` signs and verifies Ed25519 in Bun 1.4.2, and inside the OpenCode 2.0.16 host process. A one-byte change fails verification. |
| 2. Does a models-only layer merge as the spec says? | **Yes.** Loom's list became `[user…, recommended…, builtin…]` with duplicates removed. A recommended agent the version doesn't know was skipped. `notify` held the file without applying it, a project's `mode off` overrode a global `mode auto`, and a tampered `applied.json` was rejected. |
| 3. Does a published change reach a running OpenCode 2 host? | **Yes, without a restart.** Loom moved from `proof/claude-opus-5-5` to `proof/claude-opus-5-6`, and the next session selected the new model. The scripted provider was not running, so no model call completed. |
| Found: a skipped layer flips agents back to the builtins | A corrupt local `applied.json` is a valid catalog without recommendations, so OpenCode 2 published it and Loom fell back to `claude-opus-5-5` until the file was fixed. The spike corrupted the file by hand; it did not show a non-atomic write producing that state. Atomic promotion is the proposed mitigation, because a torn write would reach the same state. |
| Found: a failed fetch waits the full 24 hours | The spike recorded `lastCheck` on errors too, so one network failure delayed the next attempt by a day. |
| Found: Weave's logs are not in the host log | Weave's pino output does not appear in OpenCode 2's `opencode.log`, so a user cannot see recommendation errors there. `status` and `weave models status` are the only places they show up. |

## Setup

- Isolated host from `scripts/proof/opencode2-live/main.ts --host pinned --plugin local --keep`, with the spike adapter built and installed from the branch.
- The host's `proof` provider was given two extra catalog entries, `claude-opus-5-5` and `claude-opus-5-6`, so the bare builtin IDs resolve and a change is visible in `opencode2 api agent.list`.
- Global Weave config: `settings { model_updates { mode auto } }`.
- A local Bun server served `/models/stable.v1.json` and its `.sig`, with an ETag. The plugin found it through `WEAVE_MODEL_RECOMMENDATIONS_URL`, the public key through `WEAVE_MODEL_RECOMMENDATIONS_PUBKEY`, and a 5-second throttle through `WEAVE_MODEL_RECOMMENDATIONS_THROTTLE_MS`. All three are spike-only.

## Observations

1. **Activation.** The plugin fetched the list in the background right after the first catalog publish (server log 12:07:01) and promoted it to `applied.json`. Loom was registered on `proof/claude-opus-5-5`.
2. **New list published** (`issued` one day later; Loom → `["claude-opus-5-6", "claude-opus-5-5"]`):
   - The first `opencode2 run --agent loom` triggered the fetch (12:07:28). Its catalog refresh had already started, so that session still selected `claude-opus-5-5`.
   - The second run's prompt hook found `applied.json` changed, rebuilt and reloaded agents. `agent.list` then showed Loom on `claude-opus-5-6`, and that session selected it.
   - The following fetch sent `If-None-Match` and got a 304.
3. **Bad remote signature.** The server published a newer file with a stale signature. The fetch rejected it, `state.json` recorded `SignatureInvalid`, and Loom stayed on `claude-opus-5-6`.
4. **Corrupt local file.** Editing `applied.json` by hand made the loader skip the layer, and the next refresh published Loom on `claude-opus-5-5`. Restoring the file brought `claude-opus-5-6` back on the next refresh.

Runs timed out because the scripted provider was not running. The prompt hook, and so the refresh, runs before the model call, so this does not affect the result.

## What changes in Spec 39

- **Atomic promotion.** `applied` becomes one envelope file holding the exact signed bytes and the signature, written to a temporary name and renamed into place with `node:fs/promises` (precedent: [`plan-task-reader.ts`](../../packages/config/src/plan-task-reader.ts)). A reader then sees either the old or the new file, never a mix.
- **Error backoff.** A failed check is retried after one hour, not 24.
- **When a change lands on OpenCode 2.** Refresh runs on admitted work (a prompt or a plan start), not on a timer. A change lands on the prompt after the one that fetched it.
- **No OpenCode 2 source plumbing.** Reading `applied.json` through the loader's injected `FileReader` is enough. OpenCode 2's `CatalogSourceCache` records it and the existing probe detects the change. Task 6.2 becomes a test only.
- **DSL needs only a schema change.** The parser and validator already handle a nested block inside `settings`. Tests are still needed at all four levels.

## Also found: live harness port collision

`opencode2 service start` waited out its 120-second timeout because the managed-service default port (49374) was held by another OpenCode 2 host on the same machine. The host log said so; the harness reported only exit 130. Running `opencode2 service set port <free port>` in the isolated home fixed it. The harness could pick a free port before starting.
