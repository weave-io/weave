# Spec 39 Tasks — Model Recommendations

Task tracking for [Spec 39](39-spec-model-recommendations.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 39](39-spec-model-recommendations.md), then [Config Loading](../../config-loading.md), [Model Resolution](../../model-resolution.md#builtin-default-models) and the [Adapter Boundary](../../adapter-boundary.md).
2. Take the first group below whose boxes are not all ticked. Groups are in working order.
3. One pull request per group. Write the tests first. Reference the tracking issue (#275) in the PR.
4. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.

**Order and dependencies:** 1 → 2 → 3 → 4 → 5 → 6 → 8. Group 7 (website) needs group 2's `weave models check` released on `next`, and may land any time after that. Group 8 needs groups 6 and 7, or a locally served signed file.

## 1. DSL setting — PR:

- [ ] 1.1 `SettingsConfigSchema` gains an optional strict `model_updates` object: `mode` (`off` | `notify` | `auto`, required in the block), `channel` (`stable` | `next`, default `stable`).
- [ ] 1.2 Tests at all four levels named in [AGENTS.md](../../../AGENTS.md#schema-evolution-and-test-maintenance): schema, parser, validate, parse_config. Each valid mode and channel accepted; unknown mode, unknown channel, missing `mode` and unknown fields rejected with readable paths.
- [ ] 1.3 Merge tests: project `mode off` overrides global `mode auto`; an omitted project block keeps the global one.
- [ ] 1.4 [DSL reference](../../dsl-reference.md) documents the block; marked as having no effect until group 3 lands.

## 2. File format and signature — PR:

- [ ] 2.1 `ModelRecommendationsFile` Zod schema in `@weaveio/weave-config`, matching [the field table](39-spec-model-recommendations.md#the-published-file), with the 64 KiB and count limits.
- [ ] 2.2 Ed25519 verification with `crypto.subtle` over the exact file bytes, against a list of embedded public keys. Confirm Bun's WebCrypto supports Ed25519 verify; record the Bun version in the PR.
- [ ] 2.3 Typed error union (for example `SignatureInvalid`, `SchemaInvalid`, `ChannelMismatch`, `ClientTooOld`, `TooLarge`). Fixtures for each, plus a valid fixture signed with a test-only key.
- [ ] 2.4 Key-generation and signing script for maintainers under `scripts/`, documented; the private key never enters the repository.
- [ ] 2.5 `weave models check <file> [--sig <file>]` validates (and verifies when a signature is given). Exit codes documented in [CLI](../../cli.md).

## 3. Loader layer — PR:

- [ ] 3.1 `loadConfig` reads the merged `model_updates.mode` before deciding to read the cache. With `off` or no block, output is identical to today's for every existing loader fixture (assert it).
- [ ] 3.2 A verified `applied.json` becomes a layer of builtin-agent `models` only, merged between builtins and global. Tests: user entries first, then recommended, then builtin, duplicates removed; a recommended name that is not a builtin is skipped; `disable agents` still wins.
- [ ] 3.3 A missing, unreadable, unsigned or invalid `applied.json` skips the layer, loads the rest, and returns the reason alongside the config for `validate` and adapters to report.
- [ ] 3.4 Cache paths honour `WEAVE_GLOBAL_CONFIG_DIR`. File access goes through the injected reader, so tests use string fixtures.
- [ ] 3.5 [Config Loading](../../config-loading.md) describes the fourth layer; [Model Resolution](../../model-resolution.md#builtin-default-models) says how recommendations combine with the builtin defaults.

## 4. Fetch and cache — PR:

- [ ] 4.1 `ModelRecommendations` class with injected `fetch`, clock and file access; `refresh({ force })` returns `ResultAsync` with a typed error.
- [ ] 4.2 24-hour throttle per channel, `If-None-Match`/ETag, 5-second timeout, 64 KiB body cap, no identifying headers. `WEAVE_MODEL_RECOMMENDATIONS_URL` overrides the base URL.
- [ ] 4.3 `latest` written only after verification; `auto` promotes to `applied` only when `issued` is later; `notify` holds. Rollback (older `issued`) and replay (same `issued`) leave `applied` unchanged.
- [ ] 4.4 Every failure path leaves both files unchanged and records an error code in `state.json`. No test touches the network.

## 5. CLI — PR:

- [ ] 5.1 `weave models status`: mode, channel, applied `issued` and `evidence`, waiting update, last check and error, per-agent merged list with each entry's source, skipped agent names.
- [ ] 5.2 `weave models update` (forced refresh), `weave models apply` (promote `latest`), `weave models pin` (write explicit `models` into the global config after printing the diff and asking; `--yes` for scripts).
- [ ] 5.3 `weave validate` (every form) reports the mode, the applied date, and a skipped layer with its reason.
- [ ] 5.4 [CLI](../../cli.md) documents the `models` command group; API report (`packages/cli/etc/weave-cli.api.md`) updated.

## 6. OpenCode 2 — PR:

- [ ] 6.1 After the first catalog publish, and on refresh probes when the throttle is due, call `refresh()` without awaiting it in the refresh path. Never in `build`, so a catalog attempt's exact bytes stay deterministic.
- [ ] 6.2 Add `applied.json` (and its `.sig`) to the catalog's probed sources, recorded as missing when absent, so a promotion triggers the existing rebuild and reload.
- [ ] 6.3 `status` gains the optional bounded `modelUpdates` object and the `model_updates_unavailable` issue code; RPC schema tests updated.
- [ ] 6.4 TUI notice when a reload changes an agent's resolved model because of an applied recommendation. Verify the notice mechanism live and record it in [OpenCode 2 core](../../adapters/opencode2-core.md).
- [ ] 6.5 Adapter scenario in `tests/adapters/`: with `mode auto` and a stub fetch, a newly promoted file changes Loom's registered model after one refresh, with no restart; with `mode off`, no fetch happens.

## 7. Website (`pgermishuys/weave-website`) — PR:

- [ ] 7.1 `public/models/stable.v1.json` and `next.v1.json`, initially repeating today's builtin lists.
- [ ] 7.2 Deploy workflow: `weave models check` each file, sign with the secret key, publish the `.sig` files; fail the deploy on either error.
- [ ] 7.3 nginx: `/models/` served as `application/json`, `Cache-Control: public, max-age=300`, ETag.
- [ ] 7.4 User docs page: how to opt in, the commands, channels, what the request sends.

## 8. Live proof — PR:

- [ ] 8.1 On a real OpenCode 2 host with `mode auto` and `WEAVE_MODEL_RECOMMENDATIONS_URL` pointing at a locally served signed file: publish a new list, observe Loom's model change after the refresh with no restart.
- [ ] 8.2 Serve a tampered file: it is rejected, `status` reports it, and Loom keeps its model.
- [ ] 8.3 Record both under `docs/artifacts/` and link them from Spec 39.
