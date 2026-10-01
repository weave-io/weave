# Spec 39 Tasks — Model Recommendations

Task tracking for [Spec 39](39-spec-model-recommendations.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 39](39-spec-model-recommendations.md) and the [spike record](../../artifacts/model-recommendations-spike.md) (code on branch `spike/model-recommendations`, a starting point but not production quality), then [Config Loading](../../config-loading.md), [Model Resolution](../../model-resolution.md#builtin-default-models) and the [Adapter Boundary](../../adapter-boundary.md).
2. Take the first group below whose boxes are not all ticked. Groups are in working order.
3. One pull request per group. Write the tests first. Reference the tracking issue (#275) in the PR.
4. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.

**Order and dependencies:** 1 → 2 → 3 → 4 → 5 → 6 → 8. Group 7 (website) needs group 2's `weave models check` released on `next`, and may land any time after that. Group 8 needs groups 6 and 7, or a locally served signed file. Group 0 runs alongside: the feature can ship without it, but no list that changes a model is published until group 0's blocking gaps are closed for that agent.

## 0. Eval readiness — PRs: #280, #281, #282, #283, #284

The gaps are described, with evidence, in the [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md). One PR per task; 0.1, 0.2, 0.4 and 0.6 first.

- [x] 0.1 (G1) Builtins-only config mode for `eval run`: no project or global `.weave` is read, as in `tapestry-category-config.ts`. Make it the default for runs cited as evidence and record the mode in the bundle. Then re-score Shuttle and Weft on their shipped prompts. Code: #281. Re-scoring Shuttle and Weft on shipped prompts is still open.
- [x] 0.2 (G2) A model comparison over one bundle: candidate against current, per suite, with equal repeat counts, Fisher's exact test and Holm adjustment, the per-case guard (a case at ≥ 80% on current that falls below 60% on the candidate fails), and the cost difference. Tests with fixture bundles, including the Spindle 29 Sep shape (suite-level p ≈ 0.17, one case 8/8 → 4/8). #284: `weave eval compare-models` (text track only).
- [ ] 0.3 (G3) Grow suites to at least 12 text cases, one PR per suite, with rubrics: shuttle-execution (+9), weft-review (+8), spindle-tools (+10), warp-security (+8), pattern-planning (+8), tapestry-execution (+8). Shuttle and Weft first. Cover failure modes from the [session audit](../../artifacts/session-audit-2026-09.md). This picks up Spec 37 task 19.2. Done: shuttle-execution, 3 → 12 (#286: nine judged `own-envelope` cases). weft-review: #289, 4 → 12 (three `judgment` approvals and five rejections judged on the expected outcome). warp-security: #290, 4 → 12 (six `judge-scored` blocks and two `judgment` approvals).
- [x] 0.4 (G4) Every trajectory case's `allowed_models` includes every `default: true` model in `evals/model-matrix.json`, enforced by a test. A candidate must be a default model in the matrix before it is evaluated, so adding it there makes it runnable on every trajectory case. #280.
- [x] 0.5 (G5) Catalog fixtures for Copilot, Anthropic, OpenAI, OpenRouter and Copilot + OpenAI, used by `weave models check` (task 2.5) to print and check each section's resolution. #282: `packages/cli/src/models/catalogs/`, bundled into the CLI.
- [x] 0.6 (G6) Store prompt and completion tokens per attempt in the score file, and report cost per attempt per model at the matrix's prices. #283: cost in local score files only, not the public report.
- [ ] 0.7 (G7) Publish the candidate run through the CI eval workflow so the file's `evidence` link resolves; needs the credit top-up planned in Spec 38 task 10.2.
- [ ] 0.8 (G8) A tier table in the evidence for Claude Code sections, and a check that each tier's measured model is in the eval matrix.
- [ ] 0.9 Later (G9–G13): harder cases for the saturated suites, a Thread suite, an OpenCode 2 trajectory runner, provider smoke runs, and defect 4. Each widens which agents a list may change.

## 1. DSL setting — PR: #278

- [x] 1.1 `SettingsConfigSchema` gains an optional strict `model_updates` object: `mode` (`off` | `notify` | `auto`, required in the block), `channel` (`stable` | `next`, default `stable`). The spike showed the parser and validator need no change.
- [x] 1.2 Tests at all four levels named in [AGENTS.md](../../../AGENTS.md#schema-evolution-and-test-maintenance): schema, parser, validate, parse_config. Each valid mode and channel accepted; unknown mode, unknown channel, missing `mode` and unknown fields rejected with readable paths.
- [x] 1.3 Merge tests: project `mode off` overrides global `mode auto`; an omitted project block keeps the global one.
- [x] 1.4 [DSL reference](../../dsl-reference.md) documents the block; marked as having no effect until group 3 lands.

## 2. File format and signature — PR: #282

- [x] 2.1 `ModelRecommendationsFile` Zod schema in `@weaveio/weave-config`, matching [the field table](39-spec-model-recommendations.md#the-published-file), inside the `{ payload, sig }` envelope: required `default`, `evidence` and `expires`; freshness rules (rollback, 24-hour future skew, `BUILTIN_MODELS_ISSUED` baseline, expiry) with an injected clock; optional `harnesses` keyed `opencode2`, `claude-code`, `pi`; `claude-code` entries limited to `opus`, `sonnet`, `haiku`; the 64 KiB and count limits.
- [x] 2.2 Ed25519 verification with `crypto.subtle` over the exact file bytes, against a list of embedded public keys. Confirm Bun's WebCrypto supports Ed25519 verify; record the Bun version in the PR. Bun 1.4.2.
- [x] 2.3 Typed error union (for example `SignatureInvalid`, `SchemaInvalid`, `ChannelMismatch`, `ClientTooOld`, `TooLarge`). Fixtures for each, plus a valid fixture signed with a test-only key.
- [x] 2.4 Key-generation and signing script for maintainers under `scripts/`, documented; the private key never enters the repository.
- [x] 2.5 `weave models check <file> [--expect <file>] [--envelope]` validates a list (and verifies an envelope's signature), then resolves every section against the catalog fixtures of task 0.5, prints the chosen model per agent and provider, and with `--expect` fails on any mismatch. Exit codes documented in [CLI](../../cli.md). Also `--key`, `--issued-after` (the served list's `issued`, for the website's rollback check) and `--json`; the expectations format is in [CLI](../../cli.md#the-expectations-file).

## 3. Loader layer — PR: #287

- [x] 3.1 `loadConfig` reads the merged `model_updates.mode` before deciding to read the cache. With `off` or no block, output is identical to today's for every existing loader fixture (assert it).
- [x] 3.2 A verified `applied.json` becomes a layer of builtin-agent `models` only, merged between builtins and global. Tests: user entries first, then recommended, then builtin, duplicates removed; a recommended name that is not a builtin is skipped; `disable agents` still wins.
- [x] 3.3 A missing, unreadable, unsigned or invalid `applied.json` skips the layer, loads the rest, and returns the reason alongside the config for `validate` and adapters to report.
- [x] 3.4 Cache paths honour `WEAVE_GLOBAL_CONFIG_DIR`. File access goes through the injected reader, so tests use string fixtures.
- [x] 3.5 New `loadConfigDetailed(projectRoot, reader, { harness })` returning `{ config, diagnostics }`; `loadConfig` keeps its signature and returns `config`. It selects the harness's section, else `default`; no harness ID means no layer. OpenCode 2, Claude Code and Pi pass theirs. OpenCode 2's catalog passes `opencode2` and reports a skipped layer as `model_updates_unavailable` (the 6.3 issue code, landed early); `weave compose --adapter claude-code` passes `claude-code`. Pi's adapter source is outside this repository, so it adopts the API in 6b.2.
- [x] 3.6 The Claude Code adapter accepts `opus`, `sonnet` and `haiku` as `models` entries and writes them through unchanged.
- [x] 3.7 [Config Loading](../../config-loading.md) describes the fourth layer; [Model Resolution](../../model-resolution.md#builtin-default-models) says how recommendations combine with the builtin defaults. Also [Claude Code](../../adapters/claude-code.md#models) (tier entries) and [OpenCode 2 core](../../adapters/opencode2-core.md#model-recommendations).

## 4. Fetch and cache — PR: #288

- [x] 4.1 `ModelRecommendations` class with injected `fetch`, clock and file access; `refresh({ force })` returns `ResultAsync` with a typed error.
- [x] 4.2 24-hour throttle per channel after success and 1-hour after failure, `If-None-Match`/ETag, 5-second timeout, 64 KiB body cap, no identifying headers. `WEAVE_MODEL_RECOMMENDATIONS_URL` overrides the base URL.
- [x] 4.3 `latest` and `applied` are envelope files written to a unique temporary name and moved into place with Bun Shell `mv` (test pins the rename); writers hold the `lock/` directory (Bun Shell `mkdir`, 60-second stale timeout) and re-check `issued` under the lock. `latest` written only after verification; `auto` promotes to `applied` only when `issued` is later; `notify` holds. Rollback (older `issued`) and replay (same `issued`) leave `applied` unchanged.
- [x] 4.4 Every failure path leaves both files unchanged and records an error code in `state.json`, under the lock. Lock contention returns `Busy` and writes nothing, `state.json` included. No test touches the network. Also in #288: an opted-in channel with no `applied.json` yet is a `ModelRecommendationsPending` diagnostic, not a skipped layer, so OpenCode 2 raises `model_updates_unavailable` only for a present-but-unusable file.

## 5. CLI — PR:

- [x] 5.1 `weave models status`: mode, channel, applied `issued` and `evidence`, waiting update, last check and error, per-agent merged list with each entry's source, skipped agent names.
- [x] 5.2 `weave models update` (forced refresh), `weave models apply` (promote `latest`), `weave models pin` (write explicit `models` into the global config after printing the diff and asking; `--yes` for scripts).
- [x] 5.3 `weave validate` (every form) reports the mode, the applied date, and a skipped layer with its reason.
- [x] 5.4 [CLI](../../cli.md) documents the `models` command group; API report (`packages/cli/etc/weave-cli.api.md`) updated. Also: the commands report for OpenCode 2 unless `--harness` says otherwise, `--project-root` (not `--project`, which is `validate`'s boolean) picks the project, and `pin` edits only `models` fields, located with the lexer, and verifies the edit before writing.

## 6. OpenCode 2 — PR: #292

- [x] 6.1 After the first catalog publish, and on refresh probes when the throttle is due, call `refresh()` without awaiting it in the refresh path. Never in `build`, so a catalog attempt's exact bytes stay deterministic. Done as: after the first publish and on admitted work (prompt hook, plan start), single-flight per host, settings from the published catalog, never with `mode off`.
- [x] 6.2 Test that `applied.json` appears in the catalog's source manifest (recorded as missing when absent) and that a promotion triggers the existing rebuild and reload. The spike showed no adapter change is needed: the loader reads it through the source cache's `FileReader`.
- [x] 6.3 `status` gains the optional bounded `modelUpdates` object and the `model_updates_unavailable` issue code; RPC schema tests updated. The issue code and its RPC schema test landed with group 3 (#287); `modelUpdates` (`mode`, `channel`, `state`: `off` | `pending` | `applied` | `unavailable`, `issued`) landed in #292.
- [x] 6.4 TUI notice when a reload changes an agent's resolved model because of an applied recommendation. Verify the notice mechanism live and record it in [OpenCode 2 core](../../adapters/opencode2-core.md#model-recommendations). Done as a `models.changed` RPC event, tested against the host double, and a plan-panel toast; the toast has not been seen on a live host yet, so that check moved to 8.4.
- [x] 6.5 Adapter scenario in `tests/adapters/`: with `mode auto` and a stub fetch, a newly promoted file changes Loom's registered model after one refresh, with no restart; with `mode off`, no fetch happens.

## 6b. Claude Code and Pi — PR:

- [ ] 6b.1 Claude Code: the session-start bootstrap calls `refresh()` in the background (never blocking composition) and composes with `loadConfigDetailed(..., { harness: "claude-code" })`.
- [ ] 6b.2 Pi: the same at `session_start`, with `harness: "pi"`, in the Pi adapter (its source is outside this repository; open the PR where it lives).
- [ ] 6b.3 Tests with a stub fetch: opted in, a session start triggers one refresh; `mode off`, none.

## 7. Website (`pgermishuys/weave-website`) — PR:

- [ ] 7.1 `public/models/stable.v1.json` and `next.v1.json`, initially repeating today's builtin lists.
- [ ] 7.2 Deploy workflow: `weave models check --expect` each list (schema, freshness, catalog resolution against the `.expect.json`, `evidence` present), wait for approval in the `model-recommendations` environment, sign, and publish the envelopes; fail the deploy on any error.
- [ ] 7.3 nginx: `/models/` served as `application/json`, `Cache-Control: public, max-age=300`, ETag.
- [ ] 7.4 User docs page: how to opt in, the commands, channels, what the request sends.

## 8. Live proof — PR:

- [ ] 8.1 On a real OpenCode 2 host with `mode auto` and `WEAVE_MODEL_RECOMMENDATIONS_URL` pointing at a locally served signed file: publish a new list, observe Loom's model change after the refresh with no restart.
- [ ] 8.2 Serve a tampered file: it is rejected, `status` reports it, and Loom keeps its model.
- [ ] 8.2a Corrupt the local `applied.json` by hand: the layer is skipped, agents fall back to their builtin lists, and `status` carries `model_updates_unavailable` until the next successful promotion replaces the file. Promotions under load never produce that state (atomic envelopes).
- [ ] 8.3 Record both under `docs/artifacts/` and link them from Spec 39.
- [ ] 8.4 On the same host, see the TUI toast that the `models.changed` event produces when Loom moves (6.4).
