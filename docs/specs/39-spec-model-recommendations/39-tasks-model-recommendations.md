# Spec 39 Tasks — Model Recommendations

Task tracking for [Spec 39](39-spec-model-recommendations.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 39](39-spec-model-recommendations.md) and the [spike record](../../artifacts/model-recommendations-spike.md) (code on branch `spike/model-recommendations`, a starting point but not production quality), then [Config Loading](../../config-loading.md), [Model Resolution](../../model-resolution.md#builtin-default-models) and the [Adapter Boundary](../../adapter-boundary.md).
2. Take the first group below whose boxes are not all ticked. Groups are in working order.
3. One pull request per group. Write the tests first. Reference the tracking issue (#275) in the PR.
4. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.

**Order and dependencies:** 1 → 2 → 3 → 4 → 5 → 6 → 8. Group 7 (website) needs group 2's `weave models check` released on `next`, and may land any time after that. Group 8 needs groups 6 and 7, or a locally served signed file. Group 0 runs alongside: the feature can ship without it, but no list that changes a model is published until group 0's blocking gaps are closed for that agent.

## 0. Eval readiness — PR:

The gaps are described, with evidence, in the [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md). One PR per task; 0.1, 0.2, 0.4 and 0.6 first.

- [ ] 0.1 (G1) Builtins-only config mode for `eval run`: no project or global `.weave` is read, as in `tapestry-category-config.ts`. Make it the default for runs cited as evidence and record the mode in the bundle. Then re-score Shuttle and Weft on their shipped prompts.
- [ ] 0.2 (G2) A model comparison over one bundle: candidate against current, per suite, with Fisher's exact test and Holm adjustment, the per-case guard (a case at least 4/5 on current that drops below 3/5 on the candidate fails), and the cost difference. Tests with fixture bundles, including the Spindle 29 Sep shape (suite-level p ≈ 0.17, one case 8/8 → 4/8).
- [ ] 0.3 (G3) Grow suites to at least 12 text cases, one PR per suite, with rubrics: shuttle-execution (+9), weft-review (+8), spindle-tools (+10), warp-security (+8), pattern-planning (+8), tapestry-execution (+8). Shuttle and Weft first. Cover failure modes from the [session audit](../../artifacts/session-audit-2026-09.md). This picks up Spec 37 task 19.2.
- [ ] 0.4 (G4) Add the current defaults (Opus 5.5, Sonnet 5.5, Haiku 4.5, GPT 6 Sol, GPT 6 Luna) to the `allowed_models` of every trajectory case.
- [ ] 0.5 (G5) Catalog fixtures for Copilot, Anthropic, OpenAI, OpenRouter and Copilot + OpenAI, used by `weave models check` (task 2.5) to print and check each section's resolution.
- [ ] 0.6 (G6) Store prompt and completion tokens per attempt in the score file, and report cost per attempt per model at the matrix's prices.
- [ ] 0.7 (G7) Publish the candidate run through the CI eval workflow so the file's `evidence` link resolves; needs the credit top-up planned in Spec 38 task 10.2.
- [ ] 0.8 (G8) A tier table in the evidence for Claude Code sections, and a check that each tier's measured model is in the eval matrix.
- [ ] 0.9 Later (G9–G13): harder cases for the saturated suites, a Thread suite, an OpenCode 2 trajectory runner, provider smoke runs, and defect 4. Each widens which agents a list may change.

## 1. DSL setting — PR:

- [ ] 1.1 `SettingsConfigSchema` gains an optional strict `model_updates` object: `mode` (`off` | `notify` | `auto`, required in the block), `channel` (`stable` | `next`, default `stable`). The spike showed the parser and validator need no change.
- [ ] 1.2 Tests at all four levels named in [AGENTS.md](../../../AGENTS.md#schema-evolution-and-test-maintenance): schema, parser, validate, parse_config. Each valid mode and channel accepted; unknown mode, unknown channel, missing `mode` and unknown fields rejected with readable paths.
- [ ] 1.3 Merge tests: project `mode off` overrides global `mode auto`; an omitted project block keeps the global one.
- [ ] 1.4 [DSL reference](../../dsl-reference.md) documents the block; marked as having no effect until group 3 lands.

## 2. File format and signature — PR:

- [ ] 2.1 `ModelRecommendationsFile` Zod schema in `@weaveio/weave-config`, matching [the field table](39-spec-model-recommendations.md#the-published-file): required `default` and `evidence`, optional `harnesses` keyed `opencode2`, `claude-code`, `pi`; `claude-code` entries limited to `opus`, `sonnet`, `haiku`; the 64 KiB and count limits.
- [ ] 2.2 Ed25519 verification with `crypto.subtle` over the exact file bytes, against a list of embedded public keys. Confirm Bun's WebCrypto supports Ed25519 verify; record the Bun version in the PR.
- [ ] 2.3 Typed error union (for example `SignatureInvalid`, `SchemaInvalid`, `ChannelMismatch`, `ClientTooOld`, `TooLarge`). Fixtures for each, plus a valid fixture signed with a test-only key.
- [ ] 2.4 Key-generation and signing script for maintainers under `scripts/`, documented; the private key never enters the repository.
- [ ] 2.5 `weave models check <file> [--sig <file>]` validates (and verifies when a signature is given), then resolves every section against the catalog fixtures of task 0.5 and prints the chosen model per agent and provider. Exit codes documented in [CLI](../../cli.md).

## 3. Loader layer — PR:

- [ ] 3.1 `loadConfig` reads the merged `model_updates.mode` before deciding to read the cache. With `off` or no block, output is identical to today's for every existing loader fixture (assert it).
- [ ] 3.2 A verified `applied.json` becomes a layer of builtin-agent `models` only, merged between builtins and global. Tests: user entries first, then recommended, then builtin, duplicates removed; a recommended name that is not a builtin is skipped; `disable agents` still wins.
- [ ] 3.3 A missing, unreadable, unsigned or invalid `applied.json` skips the layer, loads the rest, and returns the reason alongside the config for `validate` and adapters to report.
- [ ] 3.4 Cache paths honour `WEAVE_GLOBAL_CONFIG_DIR`. File access goes through the injected reader, so tests use string fixtures.
- [ ] 3.5 `loadConfig` takes an optional harness ID from the adapter and selects that section, else `default`; no harness ID means no layer. OpenCode 2, Claude Code and Pi pass theirs.
- [ ] 3.6 The Claude Code adapter accepts `opus`, `sonnet` and `haiku` as `models` entries and writes them through unchanged.
- [ ] 3.7 [Config Loading](../../config-loading.md) describes the fourth layer; [Model Resolution](../../model-resolution.md#builtin-default-models) says how recommendations combine with the builtin defaults.

## 4. Fetch and cache — PR:

- [ ] 4.1 `ModelRecommendations` class with injected `fetch`, clock and file access; `refresh({ force })` returns `ResultAsync` with a typed error.
- [ ] 4.2 24-hour throttle per channel after success and 1-hour after failure, `If-None-Match`/ETag, 5-second timeout, 64 KiB body cap, no identifying headers. `WEAVE_MODEL_RECOMMENDATIONS_URL` overrides the base URL.
- [ ] 4.3 `latest` and `applied` are single envelope files (`{ file, sig }`) written to a temporary name and renamed into place. `latest` written only after verification; `auto` promotes to `applied` only when `issued` is later; `notify` holds. Rollback (older `issued`) and replay (same `issued`) leave `applied` unchanged.
- [ ] 4.4 Every failure path leaves both files unchanged and records an error code in `state.json`. No test touches the network.

## 5. CLI — PR:

- [ ] 5.1 `weave models status`: mode, channel, applied `issued` and `evidence`, waiting update, last check and error, per-agent merged list with each entry's source, skipped agent names.
- [ ] 5.2 `weave models update` (forced refresh), `weave models apply` (promote `latest`), `weave models pin` (write explicit `models` into the global config after printing the diff and asking; `--yes` for scripts).
- [ ] 5.3 `weave validate` (every form) reports the mode, the applied date, and a skipped layer with its reason.
- [ ] 5.4 [CLI](../../cli.md) documents the `models` command group; API report (`packages/cli/etc/weave-cli.api.md`) updated.

## 6. OpenCode 2 — PR:

- [ ] 6.1 After the first catalog publish, and on refresh probes when the throttle is due, call `refresh()` without awaiting it in the refresh path. Never in `build`, so a catalog attempt's exact bytes stay deterministic.
- [ ] 6.2 Test that `applied.json` appears in the catalog's source manifest (recorded as missing when absent) and that a promotion triggers the existing rebuild and reload. The spike showed no adapter change is needed: the loader reads it through the source cache's `FileReader`.
- [ ] 6.3 `status` gains the optional bounded `modelUpdates` object and the `model_updates_unavailable` issue code; RPC schema tests updated.
- [ ] 6.4 TUI notice when a reload changes an agent's resolved model because of an applied recommendation. Verify the notice mechanism live and record it in [OpenCode 2 core](../../adapters/opencode2-core.md).
- [ ] 6.5 Adapter scenario in `tests/adapters/`: with `mode auto` and a stub fetch, a newly promoted file changes Loom's registered model after one refresh, with no restart; with `mode off`, no fetch happens.

## 7. Website (`pgermishuys/weave-website`) — PR:

- [ ] 7.1 `public/models/stable.v1.json` and `next.v1.json`, initially repeating today's builtin lists.
- [ ] 7.2 Deploy workflow: `weave models check` each file (schema, catalog resolution, `evidence` present), sign with the secret key, publish the `.sig` files; fail the deploy on any error.
- [ ] 7.3 nginx: `/models/` served as `application/json`, `Cache-Control: public, max-age=300`, ETag.
- [ ] 7.4 User docs page: how to opt in, the commands, channels, what the request sends.

## 8. Live proof — PR:

- [ ] 8.1 On a real OpenCode 2 host with `mode auto` and `WEAVE_MODEL_RECOMMENDATIONS_URL` pointing at a locally served signed file: publish a new list, observe Loom's model change after the refresh with no restart.
- [ ] 8.2 Serve a tampered file: it is rejected, `status` reports it, and Loom keeps its model.
- [ ] 8.2a Corrupt the local `applied.json` by hand: the layer is skipped, agents fall back to their builtin lists, and `status` carries `model_updates_unavailable` until the next successful promotion replaces the file. Promotions under load never produce that state (atomic envelopes).
- [ ] 8.3 Record both under `docs/artifacts/` and link them from Spec 39.
