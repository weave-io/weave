# Spec 39 — Model Recommendations

**Status:** Proposed — direction agreed with the maintainer on 1 Oct 2026; see [39 tasks](39-tasks-model-recommendations.md) · **Tracking issue:** #275

**Related:** [39 tasks](39-tasks-model-recommendations.md) · [Model Resolution](../../model-resolution.md#builtin-default-models) · [Config Loading](../../config-loading.md) · [Adapter Boundary](../../adapter-boundary.md) · [OpenCode 2 core](../../adapters/opencode2-core.md#refresh-behavior) · [Partial config policy in the OpenCode 2 guide](../../adapters/opencode2-core.md#partial-and-broken-configs) · [Spec 36 — Execution Controls](../36-spec-execution-controls/36-spec-execution-controls.md) (the `settings` block precedent) · [Eval record, 25 Sep 2026](../../artifacts/eval-default-models-2026-09-25.md) · [Eval record, 29 Sep 2026](../../artifacts/eval-copilot-default-models-2026-09-29.md)

## Goal

A user who opts in gets the builtin agents' model lists updated from a list the maintainers publish on tryweave.io, without upgrading Weave. Only model lists change. The rest of the user's config — their own `models`, prompts, tool policies, disables, categories and workflows — is never touched.

## Why

The builtin model lists are chosen with evals and change often: #250, #251 and #270 all changed them within a week. Today a user only gets a new list by upgrading the adapter package, and many OpenCode 2 installs pin a plugin version. Users keep running agents on models the evals have since replaced.

## State on `main` (1 Oct 2026)

- Builtin `models` live in [`builtins.ts`](../../../packages/config/src/builtins.ts) and are documented in [Model Resolution](../../model-resolution.md#builtin-default-models).
- [`loadConfig`](../../../packages/config/src/loader.ts) merges three layers: builtins, global (`~/.weave/config.weave`), project (`.weave/config.weave`). Arrays union-merge override-first, so a user's `models` entries come ahead of the builtin entries, which stay as a fallback tail.
- Nothing in `config`, `engine` or the OpenCode 2 adapter makes a network request at runtime.
- The OpenCode 2 native adapter rebuilds its catalog when a probed source changes, reads each source's exact bytes once per attempt, keeps the last valid catalog on a broken edit, and reloads agents without restarting OpenCode ([Refresh behavior](../../adapters/opencode2-core.md#refresh-behavior)). A reload does not switch a live session's model.
- The tryweave.io site ([`pgermishuys/weave-website`](https://github.com/pgermishuys/weave-website)) is an Astro build served by nginx on Fly. Its `public/` directory is served as static files.

## Decisions (1 Oct 2026)

- **A fourth config layer, not a file rewrite.** Recommendations are a layer between the builtins and the global config. Weave never edits a user's `.weave` file to apply them.
- **Opt-in, off by default.** A config without the setting behaves exactly as today and makes no network request.
- **Model lists for builtin agents only.** The published file can set nothing but `models` on agents that `builtins.ts` defines. Categories are user-defined, and generated category shuttles already inherit Shuttle's models. `review_models` stays out ([why builtins omit it](../../../packages/config/src/builtins.ts)).
- **Signed from v1.** The file is signed with Ed25519; the client accepts only signed bytes. Adding signing later would break clients that do not expect it.
- **`auto` is the recommended mode** once a user opts in; `notify` exists for users who want to approve each change.
- **Channels follow the release trains:** `stable` and `next` ([Stable Release Trains](../../stable-release-trains.md)).
- **OpenCode 2 first.** It is where most users are and the only adapter that can apply a change without a restart. The other adapters get the layer for free through `loadConfig`; what they do with it is in [Harness behaviour](#harness-behaviour).

## DSL

```weave
settings {
  model_updates {
    mode auto        # off | notify | auto
    channel stable   # stable | next
  }
}
```

- `model_updates` is an optional block inside `settings`. It rejects unknown fields.
- `mode` is required inside the block: `off`, `notify` or `auto`. Omitting the block means `off`.
- `channel` is optional and defaults to `stable`.
- Config layers deep-merge the block with the usual project-over-global precedence. A project can turn updates off for itself with `mode off`.

| Mode | Fetches | Applies |
| --- | --- | --- |
| `off` | Never | Never; any cached recommendations are ignored |
| `notify` | Yes | Only when the user runs `weave models apply` |
| `auto` | Yes | As soon as a newer valid file is verified |

## The published file

Served at `https://tryweave.io/models/<channel>.v1.json`, with a detached signature at `https://tryweave.io/models/<channel>.v1.json.sig`. `v1` is the file's schema version; a breaking format change publishes `v2` alongside it, so old clients keep working.

```json
{
  "schema": 1,
  "channel": "stable",
  "issued": "2026-10-01T09:00:00Z",
  "min_config_version": "0.2.0",
  "evidence": "https://tryweave.io/evals",
  "agents": {
    "loom":    { "models": ["claude-opus-5.5", "claude-opus-5-5", "gpt-6-sol"] },
    "shuttle": { "models": ["claude-sonnet-5.5", "claude-sonnet-5-5", "gpt-6-sol"] }
  }
}
```

| Field | Rule |
| --- | --- |
| `schema` | The literal `1`. |
| `channel` | Must equal the channel the client asked for. |
| `issued` | ISO 8601 UTC timestamp. A client never applies a file whose `issued` is not later than the one it already applied (rollback protection). |
| `min_config_version` | Optional semver. A client whose `@weaveio/weave-config` is older ignores the file and reports why. |
| `evidence` | Optional HTTPS URL, at most 256 characters, shown by `weave models status`. |
| `agents` | 1–32 entries. Each key is an agent name; each value is exactly `{ "models": [...] }` with 1–8 entries, each passing the same validation as a DSL `models` entry. |

The whole file is at most 64 KiB. Unknown top-level fields and unknown fields inside an agent entry are rejected, so the file cannot grow new powers by accident. Agent names the running version does not define as builtins are skipped and listed by `weave models status`; they are not an error, so the file can name an agent before every client knows it.

Entries follow the same spelling rules as the builtins ([why bare IDs, and why each Claude model is listed twice](../../model-resolution.md#builtin-default-models)).

### Signing

- The signature is Ed25519 over the exact bytes of the JSON file, base64-encoded in the `.sig` file.
- The public keys live in `@weaveio/weave-config` as a list, so a key can be rotated by shipping the new key in a release before the site starts signing with it.
- The private key is a secret of the website repository's deploy workflow. The workflow validates the file, signs it, and fails the deploy if either step fails.
- The client verifies with WebCrypto (`crypto.subtle`, Ed25519) in Bun. No new dependency.

**Why sign a file we host ourselves.** The file decides which model, and so which provider bill, every opted-in user's agents run on. A compromised site, repository or CDN must not be able to change that. The schema already limits a bad file to model choice; the signature limits who can publish one.

## Client behaviour

### Where the code lives

All of it is in `@weaveio/weave-config`, in a `ModelRecommendations` class with its network and file access injected, the way `FileReader` is injected into the loader today. The engine is unchanged. Fetching a file from tryweave.io is not harness resource discovery, so this stays within the [adapter boundary](../../adapter-boundary.md); adapters only decide when to call the refresh.

### Cache

Under the global config directory (honouring `WEAVE_GLOBAL_CONFIG_DIR`):

```
~/.weave/cache/model-recommendations/<channel>/
├── latest.json, latest.json.sig     # last verified download
├── applied.json, applied.json.sig   # what the loader merges
└── state.json                       # last check time, ETag, last error code
```

### Fetching

- `refresh()` does at most one request per channel per 24 hours, unless forced by `weave models update`. It sends `If-None-Match` with the stored ETag and no identifying headers or query parameters.
- The request has a 5-second timeout and the 64 KiB body limit. Only `https://tryweave.io` is fetched; tests and local proofs point at another URL with `WEAVE_MODEL_RECOMMENDATIONS_URL`.
- A downloaded file is written to `latest` only after it parses, validates and verifies.
- In `auto` mode a newly verified `latest` with a later `issued` is copied to `applied`. In `notify` mode it waits for `weave models apply`.
- Any failure (offline, timeout, bad signature, invalid file, too old a client) leaves `latest` and `applied` as they were and records an error code in `state.json`. Failures are never thrown to the caller; `refresh()` returns a `ResultAsync` whose error is a typed union.

### Loading

- `loadConfig` reads the merged `settings.model_updates.mode` from the global and project layers first. When it is `off` or absent, nothing below happens and the result is identical to today.
- Otherwise it reads `applied.json` for the channel, verifies its signature again, and turns it into a config layer holding only `agents.<name>.models` for builtin agents. Loading never touches the network.
- The merge order becomes:

  ```
  builtins  →  recommendations  →  global  →  project
  ```

  Union-merge then gives every agent `[user entries…, recommended entries…, builtin entries…]` with duplicates removed. A user's own preference still comes first, and the builtin list stays as a fallback when no recommended model is in the user's catalog.
- A missing, unreadable or invalid `applied.json` is not a config error. The layer is skipped, the config loads as if `mode` were `off`, and the reason is reported (see [Visibility](#visibility)). This follows the partial-config policy: a problem with an optional input must not cost the user their agents.
- Verifying on every load means a half-written `applied.json` is rejected rather than merged, so writes do not need to be atomic.

## Harness behaviour

| Harness | When a change applies | What it does with the layer |
| --- | --- | --- |
| **OpenCode 2** (native) | Without restart. The plugin calls `refresh()` in the background after its first catalog publish and again whenever a refresh probe finds 24 hours have passed. `applied.json` is a probed catalog source, so a promotion is picked up by the existing refresh path, which rebuilds and reloads agents. | Same as the builtins: the first entry with exactly one live catalog match. A live session keeps its model; new sessions and later turns that Weave selects a model for use the new one. |
| **OpenCode V1** | Next OpenCode start. | Uses only `provider/model` entries, so bare recommended IDs have no effect, as with the builtin defaults. |
| **Claude Code** | Next session start (the plugin reruns composition then). | Maps the first allowlisted entry to `opus`, `sonnet` or `haiku`. A recommended model outside the allowlist is skipped. |
| **Pi** | Next session start. | The first declared entry that `ctx.modelRegistry.getAvailable()` offers, as for the builtin defaults. |
| **Copilot CLI** | — | Writes no model today, so recommendations have no effect. |

Fetching runs in OpenCode 2 and in the CLI in this spec. The other adapters read whatever `applied.json` the CLI or an OpenCode 2 session last wrote; giving them their own background refresh is a later item.

## Visibility

Every opted-in user can see where each agent's models came from.

- **`weave models status`** prints the mode and channel, the `issued` date and `evidence` of the applied file, whether a newer file is waiting (`notify`), the last check time and last error, and for each builtin agent its merged list with each entry's source: project, global, recommended or builtin. Agent names in the file that this version skips are listed.
- **`weave models update`** forces a fetch now and prints what changed.
- **`weave models apply`** promotes `latest` to `applied` (the `notify` path).
- **`weave models pin`** writes the applied recommendations into the global config as explicit `models` lines and prints the diff first. That freezes them; the user can then set `mode off`.
- **`weave validate`** reports the mode and applied date, and reports a skipped layer with its reason, in every form of the command.
- **OpenCode 2 `status`** gains an optional bounded `modelUpdates` object (`mode`, `channel`, `issued`, `state`) and an issue code `model_updates_unavailable` when an opted-in layer was skipped. The TUI shows a one-line notice when an update is applied, for example "Loom → claude-opus-5.6 (recommendations of 1 Oct 2026)". The notice mechanism is verified live, as for plan display.

## Website

- `public/models/stable.v1.json` and `public/models/next.v1.json` hold the source; the deploy workflow produces the `.sig` files.
- The workflow validates each file with `weave models check <file>` (a CLI subcommand using the same schema as the client) before signing, so the site and the client cannot disagree about what is valid.
- nginx serves `/models/` as `application/json` with `Cache-Control: public, max-age=300` and an ETag.
- A user docs page on tryweave.io explains the setting, the commands, and what data the request sends (none beyond the HTTP request itself).
- The first `stable` file repeats today's builtin lists, so turning the feature on changes nothing until a maintainer publishes a new list.

## Out of scope

- Prompts, tool policies, temperatures, variants or anything other than `models`.
- Recommendations for user-defined agents or categories.
- Per-agent opt-out. A user who wants one agent fixed writes its `models` themselves; their entries come first.
- Switching the model of a live session.
- Telemetry of any kind.

## Work items

One pull request per item, tests first, in this order. Tasks are in the [tasks file](39-tasks-model-recommendations.md).

| # | Item | Outcome that shows it is met |
| --- | --- | --- |
| 1 | **DSL setting** | `settings { model_updates { … } }` parses, validates and merges; invalid modes, channels and unknown fields are rejected with readable messages; tests at the schema, parser, validate and parse_config levels; [DSL reference](../../dsl-reference.md) updated. |
| 2 | **File format and signature** | A `ModelRecommendationsFile` schema and Ed25519 verifier in `@weaveio/weave-config`, with fixtures for every rejection in [the field table](#the-published-file); `weave models check` validates a file. |
| 3 | **Loader layer** | With `mode` off or absent, `loadConfig` output is byte-identical to today's for the existing fixtures. With a valid `applied.json`, builtin agents get `[user…, recommended…, builtin…]`; with an invalid one, the layer is skipped and the reason surfaced. |
| 4 | **Fetch and cache** | `ModelRecommendations.refresh()` with injected fetch and file access: 24-hour throttle, ETag, size and time limits, rollback protection, `auto` promotion and `notify` holding. No test touches the network. |
| 5 | **CLI** | `weave models status`, `update`, `apply`, `pin` and `check`, and the `weave validate` reporting, documented in [CLI](../../cli.md). |
| 6 | **OpenCode 2** | Background refresh after first publish and on due probes; `applied.json` as a probed source; `status` fields and issue code; TUI notice. An adapter scenario in `tests/adapters/` shows a promoted file reaching a reloaded agent without restart. |
| 7 | **Website** | Files, signing in the deploy workflow, nginx headers, user docs page. Opened against `pgermishuys/weave-website`. |
| 8 | **Live proof** | On a real OpenCode 2 host with `mode auto`, pointed at a locally served signed file: an agent's model changes after promotion with no restart, and a tampered file is rejected with the old model kept. Recorded under `docs/artifacts/`. |

## Finish line

- A user who adds `settings { model_updates { mode auto } }` and changes nothing else gets new builtin model lists on OpenCode 2 within a day of publication, without restarting OpenCode.
- A user who does not opt in sees no change in behaviour and no network request.
- An unsigned, tampered, malformed, older or too-new file never changes any agent's model, and the user can see why.
- `docs/model-resolution.md`, `docs/config-loading.md`, `docs/dsl-reference.md`, `docs/cli.md`, `docs/adapters/opencode2-core.md` and the tryweave.io docs describe the shipped behaviour.
