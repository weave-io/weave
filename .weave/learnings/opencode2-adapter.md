# Learnings — opencode2-adapter

## A1
- Bun 1.4.2 (in `docker.io/oven/bun:1`) emits text-based `bun.lock`, not legacy binary `bun.lockb`. Committed `bun.lock` instead; scripts reference it accordingly.
- `--trust` and `--frozen-lockfile` are mutually exclusive. Use `trustedDependencies: ["@opencode-ai/cli"]` in `package.json` so `--frozen-lockfile` alone works deterministically.
- `opencode2` binary lands in `node_modules/.bin` (needs to be added to `PATH`), not a global bin dir.
- Left `@parcel/watcher`, `tree-sitter-bash`, `tree-sitter-powershell`, `protobufjs` untrusted; their optional native postinstalls need a Python toolchain unavailable in the base image. Revisit for A2+ if any become required.
- `.weave/` is gitignored but sibling directories are force-added; use `git add -f` for new feasibility files if committing later.

## A2
- **Critical**: the real V2 loader (`ConfigPluginSource.scan()`) silently drops any configured `plugins` entry that resolves to a file. Only directories with `server.ts` or `index.ts` inside are accepted. `Host.resolve({ directory })` handles the entry point. This must be reflected in Spec 34 and the V2 adapter's `./server` subpath export.
- Only `opencode2 run "<msg>" --standalone` (and presumably the interactive TUI) triggers project-plugin loading. `serve`, `models`, `debug agents`, `plugin list` do NOT.
- `opencode2 run --standalone` resolves to a free built-in default model `muse-spark-1.3-contributor-free` requiring no credentials — safe for unattended feasibility runs.
- Bun's module resolution requires an ancestor `node_modules`; ephemeral run dirs must be descendants of the workspace where deps are installed (e.g. `/work/.proof-tmp/...`), not `/tmp` directly.

## A3
- **Critical**: `OpenCode.create({ plugins })` does NOT run `setup()` immediately — plugins are stored in an SDK registry and activated lazily by the `PluginSupervisor` per-location. Use `host.plugin.awaitActivation()` (SDK client method / `POST /api/plugin/await-activation`) to force activation without opening a session or making an LLM call.
- `host.close()` triggers cleanup (Promise-plugin's returned dispose function).
- Adapter's embedded-mode init must call `awaitActivation()` if it needs setup effects (e.g. agent transforms) to be visible before returning from `init()`. Spec 34 must document this.

## A4
- All 8 targeted `ctx` sub-APIs exist and are usable.
- **Deviation**: RPC list APIs (`agent.list`, `catalog.model.list`, `catalog.model.default`, `skill.list`) return `{ location, data }` envelope, not a bare array/value. Adapter must unwrap `.data`.
- **Deviation**: `event.subscribe(options: { signal? })` returns `AsyncIterable<V2Event>` — NO callback signature, NO `Registration`. Cancellation is purely via `AbortSignal`; aborting ends the `for await` loop cleanly (no throw).
- **Timing inconsistency** across `.transform()` domains:
  - `agent.transform(editor => ...)` and `catalog.transform(editor => ...)`: editor callback does NOT run synchronously within the `await`. Effects are applied lazily.
  - `command.transform(editor => ...)`: effect IS visible immediately via `ctx.command.list()` after `await`.
  - Reconciliation code must not assume the agent editor callback ran by the time the transform's promise resolves. May need to `agent.list()` afterward to confirm.
- `command` editor exposes only `add()` (no `update`/`remove` probed).
- `Registration.dispose()` correctly removes only the owned effect (verified by re-list showing baseline restored).
- All probes ran via embedded `OpenCode.create` + `awaitActivation()` — no directory wrapper needed, no LLM call.

## C2 (sdk-types)
- V2 flat exports mapped to Weave-local `V2*` aliases (e.g. `PermissionRule` → `V2Rule`, `SessionInfo` → `V2SessionInfo`). Namespaced access (`Agent.Info`, `Plugin.Context`, `Plugin.Cleanup`) is via `@opencode-ai/plugin` subpath exports.
- `V2ClientOptions` derived via `Parameters<typeof OpenCode.make>[0]` — client package's exports map doesn't expose it directly.
- `@opencode-ai/schema` is transitive; do NOT import directly — go through `@opencode-ai/plugin/promise/*` subpaths.
- `@opencode-ai/sdk` is permitted but currently unused; keep in header allow-list.


## A5
- **Hard blocker resolved (PASS)**: `AgentEditor` has no `add()`/`create()`/`insert()`/`set()` method in the pinned `.d.ts` (confirmed empirically via runtime `typeof`/`Object.keys` dump: only `list, get, default, update, remove`). Creation is achieved via `editor.update(id, updateFn)` **upsert** semantics — when `id` does not already exist, `update()` seeds a fresh draft (matching the `@opencode-ai/schema` `Agent.Info.default(id)` helper shape) and commits it as a new agent. V2 docs should be corrected: `update()` both updates and creates.
- **Critical discrepancy**: agents declared only in static `config.content`/`opencode.jsonc` are **not** merged into the synchronous `AgentEditor` draft seen inside `ctx.agent.transform(editor => ...)` — only builtins and agents registered via some plugin's own `agent.transform()` appear in `editor.list()`/`editor.get()`. Config-only agents only ever surface via the async RPC `ctx.agent.list()`. Reconciliation code (`reconcile-agent.ts`) that wants to detect a foreign same-named agent must account for this — `editor.list()` alone is not sufficient if the foreign definition is config-only.
- To simulate a real foreign registrant for testing, seed it via an **independent plugin's own** `agent.transform()` (activated earlier in the `plugins` array, with an intervening `await ctx.agent.list()` flush to force ordering) — this correctly appears in a later plugin's `editor.list()`.
- Full writeup: `.weave/feasibility/opencode2/notes/agent-editor-findings.md`.

## Release wiring (publish pipeline + Podman CI)
- **Critical bug fixed**: `sanitizeDeclaration()` in `scripts/build-public-packages.ts` used `String.replaceAll` with plain substrings, not word-boundary-safe regex. `"@weaveio/weave-adapter-opencode"` is a strict prefix of `"@weaveio/weave-adapter-opencode2"`, so replacing the V1 name first left a stray literal `"2"` after the substituted V1 phrase (e.g. `"the OpenCode adapter2"`). Fix: replace the longer/more-specific V2 string **before** the V1 string. Order matters for any future prefix-colliding package names — always order `replaceAll` calls longest-name-first when names share a prefix, or switch to a regex with an explicit non-continuation boundary.
- API Extractor rejects a TSDoc code span (`` `...` ``) that is split across a line break inside a multi-line `/** ... */` block comment — `tsdoc-code-span-missing-delimiter`. This surfaced only when the declaration-only build ran API Extractor over `errors.ts`; `tsc --noEmit` alone does not catch it. Keep backtick-delimited spans on a single source line.
- `api-extractor`'s `apiReport.reportFolder` (`etc/`) must exist on disk before the first run — unlike `dist/`/`dist-types/`, which the builder's own `ensureDirectory()` calls create, `etc/` is not auto-created and errors with "Unable to create the API report file. Please make sure the target folder exists". V1's `etc/*.api.md` files are committed (not gitignored), so the directory always pre-exists in CI. When adding a new public package, create `etc/` and let the first successful `bun run build` populate the `.api.md` report files, then commit them alongside the package.
- Registering a new public package in `PUBLIC_PACKAGE_BUILDS`/`PUBLIC_PACKAGES` is not enough on its own — `PublicPackageBuilder.emitPublicDeclarations()` has its own hardcoded list of `tsconfig.build.json` projects to run `tsc` against before API Extractor sees `dist-types/*.d.ts`. Forgetting to add the new package's `tsconfig.build.json` there produces a confusing "cannot find module" or stale-declaration failure from API Extractor rather than a clear "missing tsconfig" error.
- `bun run verify:action-pins` and `bun run verify:codeowners` both maintain their own path/version lists (`scripts/ci/verify-action-pins.ts` scans `.github/workflows/*.yml` directly so no manual registration was needed there; `scripts/ci/verify-codeowners.ts`'s `REQUIRED_RELEASE_OWNER_PATHS` does need explicit new entries) — the CODEOWNERS directory rule `/packages/adapters/*/` style patterns already cover new adapter subdirectories via glob, but exact manifest/config file paths (`package.json`, `api-extractor*.json`, `tsconfig.build.json`, `src/index.ts`) must be added individually since the verifier checks specific representative paths, not globs.
- The Podman-based `verify:opencode2` script was intentionally not run in this shell (per task instructions) — only `podman --version` and the `bun run --filter` wiring were validated structurally; CI is authoritative for the container layers.

## 0.1.1 — Materialization
- V2's `Plugin.Context` exposes the project directory via `ctx.location.directory` — a `Schema.brand<Schema.String, "AbsolutePath">` from `@opencode-ai/schema/location`. Runtime shape is a plain string; the brand is compile-time-only. There is no `ctx.directory`, `ctx.worktree`, or `ctx.cwd` on the pinned V2 `Context` interface — only `location.directory` (and `location.workspaceID`/`location.project` alongside it).
- V2 `agent.transform` editor callbacks are lazy (A4), yet `host.agent.list()` **does** see the transformed agents after `host.plugin.awaitActivation()` resolves — the RPC path reads a materialized state that is consistent with the effects the `transform` callback enqueued. This means the layer-5 smoke does not need any extra sync/flush step beyond `awaitActivation()`.
- Loom is `mode primary`; `resolveModelContext`'s fail-fast rule only applies to `mode subagent`. Primary agents whose declared `models` list does not intersect the harness catalog fall back to the harness `systemDefault`, so an empty `.weave/config.weave` is sufficient to make Loom materialize inside the embedded feasibility container (whose only model is the free `muse-spark-1.3-contributor-free`).
- Individual `spawnSubagent` failures must be logged-and-continued (not aborted). Reconcile's `ForeignAgentCollision` and model-resolution's `MissingCatalogEntry` are both per-agent errors and, if one agent hits them, the remaining plan agents still need materialization attempts.
- The V2-package-local `WEAVE_OWNERSHIP_MARKER` had to be re-exported from the `./server` subpath so `verify/container-smoke.ts` can import the exact constant the plugin writes (rather than duplicating the literal string, which would silently drift). The `.` barrel intentionally does not export it — only the `./server` entry, which is the same entry `opencode.jsonc`'s `plugins: ["@weaveio/weave-adapter-opencode2"]` resolves to.
