# Spec 39 — Model Recommendations

**Status:** Proposed — direction agreed with the maintainer on 1 Oct 2026, de-risked by a [live spike](../../artifacts/model-recommendations-spike.md) the same day, with the evals measured against the [publication bar](#publication-bar) in the [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md); see [39 tasks](39-tasks-model-recommendations.md) · **Tracking issue:** #275

**Related:** [39 tasks](39-tasks-model-recommendations.md) · [Model Resolution](../../model-resolution.md#builtin-default-models) · [Config Loading](../../config-loading.md) · [Adapter Boundary](../../adapter-boundary.md) · [OpenCode 2 core](../../adapters/opencode2-core.md#refresh-behavior) · [Partial config policy in the OpenCode 2 guide](../../adapters/opencode2-core.md#partial-and-broken-configs) · [Spec 36 — Execution Controls](../36-spec-execution-controls/36-spec-execution-controls.md) (the `settings` block precedent) · [Eval readiness for model recommendations](../../artifacts/eval-readiness-model-recommendations.md) · [Eval record, 25 Sep 2026](../../artifacts/eval-default-models-2026-09-25.md) · [Eval record, 29 Sep 2026](../../artifacts/eval-copilot-default-models-2026-09-29.md)

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
- **`notify` is the recommended mode.** A user sees what would change and applies it with `weave models apply`. `auto` is offered on the `next` channel first. The docs recommend it on `stable` only after three consecutive `stable` lists have shipped without a rollback.
- **One section per harness.** The same entry means different things to different harnesses: a catalog ID on OpenCode 2, a tier on Claude Code. The file carries a `default` section and optional per-harness sections; see [The published file](#the-published-file).
- **Only what the evals can vouch for.** A list may change an agent's models only when that agent clears the [publication bar](#publication-bar). Agents that do not keep their builtin lists and change only through releases. On 1 Oct 2026 no agent clears it; the [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md) lists what is missing.
- **Channels follow the release trains:** `stable` and `next` ([Stable Release Trains](../../stable-release-trains.md)).
- **OpenCode 2 first.** It is where most users are and the only adapter that can apply a change without a restart. The other adapters get the layer for free through `loadConfig`; what they do with it is in [Harness behaviour](#harness-behaviour).

## DSL

```weave
settings {
  model_updates {
    mode notify      # off | notify | auto
    channel stable   # stable | next
  }
}
```

- `model_updates` is an optional block inside `settings`. It rejects unknown fields.
- `mode` is required inside the block: `off`, `notify` or `auto`. Omitting the block means `off`.
- `channel` is optional. An omitted `channel` stays unset in each layer, so a project block that sets only `mode` does not reset a global `channel next`; whatever reads the merged setting treats an unset channel as `stable`. (#278)
- Config layers deep-merge the block with the usual project-over-global precedence. A project can turn updates off for itself with `mode off`.

| Mode | Fetches | Applies |
| --- | --- | --- |
| `off` | Never | Never; any cached recommendations are ignored |
| `notify` | Yes | Only when the user runs `weave models apply` |
| `auto` | Yes | As soon as a newer valid file is verified |

## The published file

Served at `https://tryweave.io/models/<channel>.v1.json` as one signed envelope, so a refresh is a single request with a single ETag:

```json
{ "payload": "<the exact JSON text of the list>", "sig": "<base64 Ed25519 signature over the payload's UTF-8 bytes>" }
```

The website repository keeps the list itself as plain JSON; its deploy workflow builds the envelope. `v1` is the schema version of the list; a breaking format change publishes `v2` alongside it, so old clients keep working. The list inside the envelope looks like this:

```json
{
  "schema": 1,
  "channel": "stable",
  "issued": "2026-10-01T09:00:00Z",
  "expires": "2026-12-30T09:00:00Z",
  "min_config_version": "1.0.0",
  "evidence": "https://tryweave.io/evals/runs/<run-id>",
  "default": {
    "agents": {
      "shuttle": { "models": ["claude-sonnet-5.5", "claude-sonnet-5-5", "gpt-6-sol"] }
    }
  },
  "harnesses": {
    "opencode2": {
      "agents": {
        "shuttle": { "models": ["claude-sonnet-5.5", "claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "gpt-6-sol"] }
      }
    },
    "claude-code": {
      "agents": { "shuttle": { "models": ["sonnet"] } }
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `schema` | The literal `1`. |
| `channel` | Must equal the channel the client asked for. |
| `issued` | ISO 8601 UTC timestamp. A client rejects a list whose `issued` is: not later than the list it already applied (rollback); more than 24 hours ahead of its clock (a mis-dated list would otherwise block every correctly dated one); or earlier than its own `BUILTIN_MODELS_ISSUED`, the date the builtin lists in that release were set (so an old list can never override newer builtins, even on a first opt-in or an empty cache). |
| `expires` | ISO 8601 UTC timestamp, at most 90 days after `issued`. A client rejects an expired list, and stops using an applied one once it expires (agents fall back to their builtin lists and `status` says why). This bounds replay of an old signed list by a compromised host, and means maintainers re-publish at least every 90 days. |
| `min_config_version` | Optional semver, compared with `MODEL_RECOMMENDATIONS_CLIENT_VERSION` in `@weaveio/weave-config` (not the package version). That constant starts at `1.0.0` and is bumped when the client learns a list feature an older client would misread. A client whose constant is older ignores the file and reports why. |
| `evidence` | Required HTTPS URL, at most 256 characters: the published eval run behind the list ([publication bar](#publication-bar)). Shown by `weave models status`. |
| `default` | Required. `{ "agents": {...} }`, used by a supported harness that has no section of its own. Entries are bare IDs that follow the builtin spelling rules. |
| `harnesses` | Optional. Keys are `opencode2`, `claude-code` and `pi`; each value has the same shape as `default`. Other keys are rejected. `claude-code` entries must be `opus`, `sonnet` or `haiku`. `opencode2` entries may be provider-qualified (`openrouter/…`, `github-copilot/…`), because OpenCode 2 checks every entry against the live catalog. |
| `agents` | In each section, 1–32 entries. Each key is an agent name; each value is exactly `{ "models": [...] }` with 1–8 entries, each passing the same validation as a DSL `models` entry. |

The whole file is at most 64 KiB. Unknown top-level fields and unknown fields inside an agent entry are rejected, so the file cannot grow new powers by accident. Agent names the running version does not define as builtins are skipped and listed by `weave models status`; they are not an error, so the file can name an agent before every client knows it.

Entries in `default` follow the same spelling rules as the builtins ([why bare IDs, and why each Claude model is listed twice](../../model-resolution.md#builtin-default-models)). A section lists each agent's full fallback order before the builtin list: for example, the previous model before a cross-vendor fallback, because the recommended entries are tried before the builtin ones.

### Signing

- The signature is Ed25519 over the exact UTF-8 bytes of the envelope's `payload`, base64-encoded in its `sig` field.
- The public keys live in `@weaveio/weave-config` as a list, so a key can be rotated by shipping the new key in a release before the site starts signing with it.
- Signing happens offline. The private key stays on a maintainer's machine and never reaches GitHub, CI or the website. The maintainer checks the list with `weave models check --expect --issued-after <issued of the list currently served>`, signs it with `scripts/models/sign.ts`, and commits the signed envelope to the website repository. The deploy workflow only verifies: it re-runs the check on the envelope (signature, freshness, expectations, and `--issued-after` the live list whenever the envelope differs from it) and fails the deploy on any error. Each publish is therefore a deliberate act by whoever holds the key, which is what makes `auto` acceptable. (An earlier draft kept the key in a GitHub Environment with required reviewers; GitHub does not offer that rule for this private repository on its current plan, and offline signing is the stronger boundary anyway.)
- The client verifies with WebCrypto (`crypto.subtle`, Ed25519) in Bun. No new dependency.

**Why sign a file we host ourselves.** The file decides which model, and so which provider bill, every opted-in user's agents run on. The signature protects against a compromised host, CDN or nginx config, and against a compromised website repository or CI: none of them hold the key, so the most they can do is serve an older signed list, which rollback protection and `expires` bound. It does not protect against a stolen maintainer key; rotating the key in a release is the recovery. The schema limits a bad list to model choice, and `expires` limits how long an old one can be replayed.

## Client behaviour

### Where the code lives

All of it is in `@weaveio/weave-config`, in a `ModelRecommendations` class with its network and file access injected, the way `FileReader` is injected into the loader today. The engine is unchanged. Fetching a file from tryweave.io is not harness resource discovery, so this stays within the [adapter boundary](../../adapter-boundary.md); adapters only decide when to call the refresh.

### Cache

Under the global config directory (honouring `WEAVE_GLOBAL_CONFIG_DIR`):

```
~/.weave/cache/model-recommendations/<channel>/
├── latest.json    # last verified download, as the served envelope
├── applied.json   # what the loader merges, same envelope
├── state.json     # last check time, ETag, last error code
└── lock/          # present while one process refreshes or applies
```

Each envelope holds the exact signed bytes and their signature in one file, so a reader can never pair a new list with an old signature.

- **Atomic replacement.** Every write goes to a uniquely named temporary file in the same directory and is moved into place with Bun Shell's builtin `mv`, which is a `rename(2)` within one directory. A reader sees the old file or the new one, never a partial write. This uses Bun APIs only, as [AGENTS.md](../../../AGENTS.md#runtime--bun-only) requires; a test pins the rename behaviour.
- **One writer at a time.** The CLI and several OpenCode 2 hosts share the cache. A refresh or `weave models apply` first creates `lock/` with Bun Shell's `mkdir`, which fails if it exists. A process that cannot take the lock skips the refresh, since another process is doing it. A lock older than 60 seconds is treated as abandoned and removed. Under the lock, the writer re-reads `applied.json` and re-checks `issued` before it commits, so a slower writer cannot replace a newer list with an older one.

### Fetching

- `refresh()` makes at most one attempt per channel per 24 hours after a successful check, and one per hour after a failed one, unless forced by `weave models update`. An attempt is one GET of the envelope with `If-None-Match` set to the stored ETag, and no identifying headers or query parameters.
- The request has a 5-second timeout and the 64 KiB body limit. Only `https://tryweave.io` is fetched; tests and local proofs point at another URL with `WEAVE_MODEL_RECOMMENDATIONS_URL`.
- A downloaded file is written to `latest` only after it parses, validates and verifies.
- In `auto` mode a newly verified `latest` with a later `issued` is copied to `applied`. In `notify` mode it waits for `weave models apply`.
- Any failure (offline, timeout, bad signature, invalid, expired, mis-dated or stale list, too old a client) leaves `latest` and `applied` as they were and records an error code in `state.json`. Failures are never thrown to the caller; `refresh()` returns a `ResultAsync` whose error is a typed union.
- Every write to the cache, `state.json` included, happens while holding `lock/`. A process that cannot take the lock returns a typed `Busy` result and writes nothing at all, so it cannot overwrite the lock holder's ETag, check time or error.

### Loading

- `loadConfig` reads the merged `settings.model_updates.mode` from the global and project layers first. When it is `off` or absent, nothing below happens and the result is identical to today.
- Otherwise it reads `applied.json` for the channel, verifies its signature again, and turns it into a config layer holding only `agents.<name>.models` for builtin agents. Loading never touches the network.
- **API.** A new `loadConfigDetailed(projectRoot, reader, { harness, now?, clientVersion? })` returns `{ config, diagnostics }`, where `diagnostics` is a typed list that includes a skipped recommendations layer and its reason. `loadConfig` keeps its signature and behaviour and returns only `config`, so no existing caller changes. Callers that report status (the CLI, `weave validate`, OpenCode 2) move to `loadConfigDetailed`.
- The adapter passes its harness ID (`opencode2`, `claude-code` or `pi`), as explicit adapter context in line with the [adapter boundary](../../adapter-boundary.md). The loader uses that harness's section, or `default` when the file has none for it. A caller that passes no harness ID, which includes OpenCode V1 and Copilot CLI, gets no recommendations layer.
- The merge order becomes:

  ```
  builtins  →  recommendations  →  global  →  project
  ```

  Union-merge then gives every agent `[user entries…, recommended entries…, builtin entries…]` with duplicates removed. A user's own preference still comes first, and the builtin list stays as a fallback when no recommended model is in the user's catalog.
- A missing, unreadable, invalid or expired `applied.json` is not a config error. The layer is skipped, the config loads as if `mode` were `off`, and the reason is returned in `diagnostics` (see [Visibility](#visibility)). A missing file is the normal state before the first promotion, so it is reported as pending (`ModelRecommendationsPending`), not as a skipped layer, and raises no `model_updates_unavailable` issue. (#275, item 4) This follows the partial-config policy: a problem with an optional input must not cost the user their agents.
- Atomic writes are required, not optional. On OpenCode 2 a skipped layer is still a valid catalog, so a torn or corrupt `applied.json` would publish every agent back on its builtin models until the file is fixed. The [spike](../../artifacts/model-recommendations-spike.md) saw exactly that with a hand-corrupted file. Atomic writes keep Weave's own promotions out of that state; a file corrupted by something else is skipped and reported, and the next promotion replaces it.

## Harness behaviour

| Harness | When a change applies | What it does with the layer |
| --- | --- | --- |
| **OpenCode 2** (native) | Without restart. The plugin calls `refresh()` in the background after its first catalog publish and on each admitted prompt or plan start, where the throttle makes most calls no-ops. Because the loader reads `applied.json` through the injected `FileReader`, the catalog's source cache records it and the existing probe sees a promotion. The refresh runs on admitted work, not on a timer, so a change lands on the prompt after the one that fetched it. | Same as the builtins: the first entry with exactly one live catalog match. A live session keeps its model; new sessions and later turns that Weave selects a model for use the new one. |
| **OpenCode V1** | — | Not supported. V1 writes the first provider-qualified entry without checking that the provider is connected, so it passes no harness ID and gets no layer. `weave models status` says so. |
| **Claude Code** | At session start the bootstrap hook's `weave compose` composes from the applied list, then calls `refresh()` once, bounded (a 1.5 s request, at most 2 s of waiting) because the hook is a short-lived process, so it never delays composition and a list fetched in one session applies at the next ([Claude Code](../../adapters/claude-code.md#model-recommendations)). | Reads its `claude-code` section, whose entries are `opus`, `sonnet` or `haiku`. The adapter's allowlist accepts the three tier names, and Claude Code maps each one to its current model, so new Anthropic models arrive through Claude Code without a new list. |
| **Pi** | As for Claude Code: a background `refresh()` at `session_start`, applied at the next session. | The first declared entry that `ctx.modelRegistry.getAvailable()` offers, as for the builtin defaults. |
| **Copilot CLI** | — | Not supported: it writes no agent model today. |

Every supported adapter fetches on its own, so `auto` works for a user who runs only Claude Code or only Pi. The cache is shared, so whichever harness or CLI command fetches first updates it for all of them.

## Visibility

Every opted-in user can see where each agent's models came from.

- **`weave models status`** prints the mode and channel, the `issued` date and `evidence` of the applied file, whether a newer file is waiting (`notify`), the last check time and last error, and for each builtin agent its merged list with each entry's source: project, global, recommended or builtin. Agent names in the file that this version skips are listed.
- **`weave models update`** forces a fetch now and prints what changed.
- **`weave models apply`** promotes `latest` to `applied` (the `notify` path).
- **`weave models pin`** writes the applied recommendations into the global config as explicit `models` lines and prints the diff first. That freezes them; the user can then set `mode off`. Because every harness reads the global config, and OpenCode V1 writes the first provider-qualified entry without checking the provider is connected, `pin` leaves out provider-qualified entries (any entry containing `/`) and says which and why; `--include-qualified` keeps them with the same explanation as a warning. An agent left with no recommended entry keeps its existing lines. See [CLI](../../cli.md#weave-models-status-update-apply-and-pin).
- **`weave validate`** reports the mode and applied date, and reports a skipped layer with its reason, in every form of the command.
- **OpenCode 2 `status`** gains an optional bounded `modelUpdates` object (`mode`, `channel`, `issued`, `state`) and an issue code `model_updates_unavailable` when an opted-in layer was skipped because `applied.json` is there but unusable (not when nothing has been applied yet). When a reload moves agents to a newly applied list, the server emits a bounded `models.changed` RPC event and the TUI shows it as a one-line notice, for example "Loom now runs on claude-opus-5.6 (model recommendations of 1 Oct 2026)" ([OpenCode 2 core](../../adapters/opencode2-core.md#model-recommendations)). The event is covered by the adapter scenario (item 6); the toast is verified on a live host in the live proof (item 8), as plan display was.

## Publication bar

A published list may change an agent's models only when, for that agent, all of the following hold. The [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md) says which tooling each step needs and which agents meet it.

1. **Shipped prompts.** The agent's suite ran with the builtin config only: no project or global `.weave`.
2. **Enough cases.** The suite has at least 12 text cases, so at 5 repeats it can detect a drop of about 13 points.
3. **No regression.** Candidate and current first model ran on the same commit and judge, with the same number of repeats, at least 5. Two checks must pass:
   - the suite-level difference is not a significant drop (Fisher's exact test with Holm adjustment, p < 0.05);
   - no case that the current model passes on at least 80% of attempts falls below 60% on the candidate.
4. **A reason to change.** Either the candidate is significantly better, or the change has a stated reason that is not a score (availability, cost) and does not raise cost.
5. **Real sessions.** The agent's trajectory cases pass on the candidate.
6. **Resolves as intended.** Next to each list, the website repository keeps an expectations file, `models/<channel>.expect.json`. For each harness section and each catalog in a fixed set (`github-copilot`, `anthropic`, `openai`, `openrouter`, and `github-copilot+openai`, a host with both connected, where bare OpenAI IDs are ambiguous), it names the model each agent must resolve to, or `none`; Claude Code, which maps tiers itself, is checked once under `anthropic` ([format](../../cli.md#the-expectations-file)). `weave models check --expect` resolves every section against catalog fixtures for those catalogs and fails on any mismatch. The fixtures ship with `@weaveio/weave-cli` and are updated when a provider's catalog changes.
7. **Cost stated.** The evidence states the cost per attempt of the candidate against the current model.
8. **Published evidence.** The run is published on tryweave.io/evals, and the file's `evidence` field links to it. Claude Code sections state which model each tier was measured as.

An agent that cannot clear the bar keeps its builtin list. Its models change only through a Weave release, where a maintainer reviews the change.

## Website

- `models/stable.json` and `models/next.json` hold the lists, with their `.expect.json` files beside them. The maintainer commits the signed envelopes as `public/models/stable.v1.json` and `public/models/next.v1.json`; the deploy workflow verifies that each envelope's payload is byte-for-byte the list beside it and passes `weave models check --envelope --expect`, with `--issued-after` the live list's `issued` whenever the committed envelope differs from the live one.
- The workflow validates each list with `weave models check <file> --expect <expect-file>` (a CLI subcommand using the same schema as the client) before signing, so the site and the client cannot disagree about what is valid. The check also resolves every section against the provider catalog fixtures ([publication bar](#publication-bar), step 6), rejects a list whose `issued` is not later than the one currently served, and fails on a missing `evidence` link.
- nginx serves `/models/` as `application/json` with `Cache-Control: public, max-age=300` and an ETag.
- A user docs page on tryweave.io explains the setting, the commands, and what data the request sends (none beyond the HTTP request itself).
- The first `stable` file repeats today's builtin lists, so turning the feature on changes nothing until a maintainer publishes a new list. A list that changes a model waits for the [publication bar](#publication-bar).

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
| 0 | **Eval readiness** | The blocking gaps G1–G8 in the [eval readiness record](../../artifacts/eval-readiness-model-recommendations.md) are closed: builtins-only eval runs, a model comparison with the per-case guard, trajectory cases on current models, catalog resolution checks, cost per attempt, published runs and the Claude Code tier table. Suites grow one at a time (G3); each grown suite makes its agent eligible. Items 1–8 do not wait for item 0, but no list that changes a model is published before it. |
| 1 | **DSL setting** | `settings { model_updates { … } }` parses, validates and merges; invalid modes, channels and unknown fields are rejected with readable messages; tests at the schema, parser, validate and parse_config levels; [DSL reference](../../dsl-reference.md) updated. |
| 2 | **File format and signature** | A `ModelRecommendationsFile` schema (with `default` and `harnesses`) and Ed25519 verifier in `@weaveio/weave-config`, with fixtures for every rejection in [the field table](#the-published-file); `weave models check` validates a file and resolves each section against provider catalog fixtures. |
| 3 | **Loader layer** | With `mode` off or absent, `loadConfig` output is byte-identical to today's for the existing fixtures. With a valid `applied.json`, builtin agents get `[user…, recommended…, builtin…]` from the section for the harness ID the adapter passes, or `default`; no harness ID means no layer; an invalid file skips the layer and surfaces the reason. The Claude Code adapter accepts `opus`, `sonnet` and `haiku` as entries. |
| 4 | **Fetch and cache** | `ModelRecommendations.refresh()` with injected fetch and file access: 24-hour throttle, ETag, size and time limits, rollback protection, `auto` promotion and `notify` holding. No test touches the network. |
| 5 | **CLI** | `weave models status`, `update`, `apply`, `pin` and `check`, and the `weave validate` reporting, documented in [CLI](../../cli.md). |
| 6 | **OpenCode 2** | Background refresh after first publish and on admitted work; a test that `applied.json` is a probed source (no new plumbing: the [spike](../../artifacts/model-recommendations-spike.md) showed the loader's `FileReader` is enough); `status` fields and issue code; TUI notice. An adapter scenario in `tests/adapters/` shows a promoted file reaching a reloaded agent without restart. |
| 6b | **Claude Code and Pi** | A background `refresh()` at session start, composition with the harness's section, and tests with a stub fetch showing one refresh per session start when opted in and none when off. |
| 7 | **Website** | Lists, expectations and offline-signed envelopes; verification in the deploy workflow; nginx headers; user docs page. Opened against `pgermishuys/weave-website`. |
| 8 | **Live proof** | On a real OpenCode 2 host with `mode auto`, pointed at a locally served signed file: an agent's model changes after promotion with no restart, a tampered remote file is rejected with the old model kept, and a corrupt local file is reported with `model_updates_unavailable` while agents run on their builtin lists. Recorded under `docs/artifacts/`, as the [spike](../../artifacts/model-recommendations-spike.md) did for the first two. |

## Finish line

- A user who adds `settings { model_updates { mode auto } }` and changes nothing else gets a newly published list without upgrading Weave. On OpenCode 2 it applies without a restart, on the second prompt after the first check that finds it: checks happen on admitted work at most once a day, not on a timer. On Claude Code and Pi it applies at the session after the one that fetched it. With `mode notify`, they see the change in `weave models status` and apply it with `weave models apply`.
- Every published list that changes a model clears the [publication bar](#publication-bar) for each agent it changes, and its `evidence` link opens the run.
- A user who does not opt in sees no change in behaviour and no network request.
- An unsigned, tampered, malformed, older or too-new file never changes any agent's model, and the user can see why.
- `docs/model-resolution.md`, `docs/config-loading.md`, `docs/dsl-reference.md`, `docs/cli.md`, `docs/adapters/opencode2-core.md` and the tryweave.io docs describe the shipped behaviour.
