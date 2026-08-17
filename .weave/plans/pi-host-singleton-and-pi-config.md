# Pi Host Runtime Singleton and `/weave:pi-config`

## TL;DR
Stop the Pi adapter from loading a second copy of the Pi host runtime (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`) at extension load time, prove the fix with a real Pi process, and add a `/weave:pi-config` TUI that stores — in the Runtime Store — which Pi extensions a Weave RPC child loads, with the Weave adapter itself always enabled.

## Context

### Observed defect
The live local setup runs Pi `0.84.2` from `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`, but the Weave extension is loaded from the checkout through `~/.pi/agent/extensions/weave-adapter-pi -> /Users/jose/projects/weave/packages/adapters/pi`. Its built `dist/extension.js` keeps bare imports of the three Pi packages (they are `PUBLIC_RUNTIME_EXTERNALS` in `scripts/release/constants.ts`), so Bun resolves them from the checkout: `/Users/jose/projects/weave/node_modules/.bun/@earendil-works+pi-coding-agent@0.81.1/...`. A second full Pi runtime is evaluated inside the host process, including its optional native clipboard module and its Tokio pool. `pi-cursor` (configured as the local package `/Users/jose/projects/pi-cursor` in `~/.pi/agent/settings.json`) adds a third copy from its own `node_modules`.

### Verified mechanism (already probed during planning; re-verify, do not re-derive)
- Pi's extension loader (`dist/core/extensions/loader.js`) maps the three specifiers to the host's own entries through jiti `alias`, but only on the jiti transform path.
- jiti `tryNative` is documented as *"Enabled if Bun is detected"* (`jiti/lib/types.d.ts`). Weave requires Pi under Bun, so jiti imports the extension natively and the jiti aliases never apply to its imports.
- Native import therefore resolves the bare specifiers from the extension's own directory. When a nested copy exists, that copy wins silently. When no nested copy exists (release install with `bun install --production --omit=peer`), native import fails and jiti falls back to its transform path with aliases — this is why packaged installs work today. Probed: an unresolvable specifier plus jiti `alias` loads the aliased target successfully.
- `Bun.plugin({ setup })` `onResolve` does **not** redirect bare specifiers for the running Bun runtime (probed: the local copy still won).
- `Bun.plugin` **`onLoad`** keyed on the resolved local copy's entry file, returning `export * from "<absolute host entry>";`, does yield the true host singleton: probed `TOKEN` identity equality with the host's own import and exactly one module evaluation.

### Consequences beyond memory
`src/host-compatibility.ts` reads `VERSION` from the imported module and documents the assumption that "Pi exposes that exact module through its extension loader". Under the duplicate load, `BunHostPackageReader` reports `0.81.1` while the real host is `0.84.2`, so every host-version gate and capability probe reasons about the wrong module surface.

### Relevant code
- Extension entry and command registration: `packages/adapters/pi/src/extension.ts` (`createPiExtension`, `export default createPiExtension()`, command loop near `WEAVE_COMMAND_NAMES`, `session_start` handler, `deps.childCommand` use at the delegation and direct-dispatch spawn sites).
- Command catalog and provenance: `packages/adapters/pi/src/commands.ts`, `packages/adapters/pi/src/capability-prober.ts`.
- Child spawn command: `packages/adapters/pi/src/child-env.ts` (`buildDefaultPiChildCommand`), `packages/adapters/pi/src/rpc-child.ts` (`buildSpawnCommand`, `SESSION_FLAGS`).
- Child mode returns before command validation and capability probing (`activateChildModeIfApplicable` is called first in `session_start`), so a child that loads Weave by file path is not blocked by command provenance.
- Runtime Store: `packages/engine/src/runtime/store.ts`, `packages/engine/src/runtime/sqlite/{schema,migrations,store}.ts`, `packages/engine/src/runtime/memory-store.ts`, adapter wiring in `packages/adapters/pi/src/runtime-store-port.ts`.
- Read-only store CLI: `packages/cli/src/commands/runtime.ts`, `packages/cli/src/args.ts`.
- Overlay/TUI precedent: `openPlanTaskList` in `extension.ts` plus `packages/adapters/pi/src/plan-task-list.ts` (`ctx.ui.custom`, `matchesKey`, host theme and keybindings).
- Build entries and externals: `scripts/release/constants.ts`; declaration configs `packages/adapters/pi/api-extractor.{index,cli,extension}.json`.
- Required reading before implementing: `docs/architecture/adapter-boundary.md`, `docs/testing/adapter-verification.md`, `docs/contributing/testing.md`, `docs/contributing/typescript.md`.

### Pi host facts this plan depends on
- CLI flags: `-e, --extension <source>` (repeatable) and `--no-extensions` (`docs/usage.md`). `-e npm:<pkg>` installs to a temporary directory per run, so children must receive resolved file paths, never npm specs.
- Extension inventory sources available to a loaded extension: `pi.getCommands()` and `getAllTools()` `sourceInfo` (`path`, `source`, `scope`, `origin`, `baseDir`); the exported `DefaultPackageManager` (`listConfiguredPackages()`, `getInstalledPath()`); `getAgentDir()`.
- `PI_CODING_AGENT_DIR` exists but also relocates credentials, so this plan does not use it.

## Scope

- In scope:
  - Runtime resolution of the three Pi packages to the active host singleton from the Weave extension entry, plus a fail-open diagnostic and a real-process proof.
  - A new `/weave:pi-config` Pi TUI command that configures which Pi extensions the Weave RPC child loads.
  - Runtime Store persistence for that selection through a new engine-owned, harness-neutral preference repository, plus a bounded read-only CLI query.
  - Child spawn argv changes that apply the stored selection.
  - Focused tests, full workspace validation, documentation, changesets, and real-harness proof.
  - One local operational step: removing `pi-cursor` from the user's Pi configuration.
- Out of scope:
  - Changing the declared peer floor (`0.81.1`) or bumping the checkout's `@earendil-works/*` devDependencies.
  - A global (XDG) Weave database. The selection is stored per project in the existing `.weave/runtime/weave.db`.
  - Deduplicating copies loaded by *other* extensions (for example `pi-cursor`'s own tree). Task 16 handles that operationally.
  - `.weave` DSL settings for extension selection; the TUI must not write user config files.
  - Any change to Pi itself.
- Constraints / assumptions:
  - Bun only. `neverthrow` `Result`/`ResultAsync` for anything fallible, no `console.*`, no throwing on expected paths.
  - Adapter tests never spawn a real harness, never write real files (`packages/adapters/AGENTS.md`). Real-process proof lives in `scripts/`, not in `bun test`.
  - The engine stays harness-neutral: it stores an opaque bounded preference value; the Pi adapter owns its meaning and schema.
  - Adding a `/weave:*` command changes the required command inventory that `capability-prober.ts` enforces; registration, catalog, palette, and docs must move together.
  - Reference the tracking issue in every commit and PR (`AGENTS.md`).

## Objectives
- The Weave extension, when loaded into a Bun-hosted Pi, evaluates exactly one copy of `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` — the host's.
- A repeatable script proves single-copy loading against a real Pi process and fails when the redirect is disabled.
- `/weave:pi-config` lets a user choose the child's optional extensions, always keeps Weave enabled, persists to the Runtime Store, and states when the choice takes effect.
- Default behavior is unchanged for users who never open the command.

## Dependencies and Order
1. Tasks 1–2 build the pure planning logic and its impure edge; nothing else depends on their internals, but Task 3 needs their public surface.
2. Task 3 splits the extension entry. It touches build config, declarations, and ten test imports, so it must land before Tasks 4–6 observe or assert on the split artifacts.
3. Task 4 wires diagnostics that Task 5's proof script reads; Task 5 depends on both.
4. Task 6 asserts build-output invariants created by Task 3.
5. Task 7 (engine repository plus migration) precedes Task 8 (CLI query) and Task 9 (adapter codec), because both consume the repository contract.
6. Task 10 (inventory) precedes Task 11 (spawn argv) and Task 12 (TUI), which both need the resolved inventory shape.
7. Task 13 (docs and changesets) follows the behavior tasks; Task 14 (validation) follows everything in the repository; Task 15 (real-harness proof) follows Task 14; Task 16 is independent of the repository and may run any time after Task 15's baseline capture.

## Tasks

- [x] 1. Add the pure host-module redirect planner
  - **What**: A dependency-free module that decides, from already-gathered facts, whether and how to redirect each Pi specifier to the host copy, and renders the re-export stub source.
  - **Files**: `packages/adapters/pi/src/host-module-redirect.ts`, `packages/adapters/pi/src/__tests__/host-module-redirect.test.ts`
  - **Depends on**: None
  - **Implementation outline**:
    1. Define `PiHostModuleSpecifier` as the closed tuple `["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]`, and a closed `PiHostRedirectReason` union (`host-root-unproven`, `host-package-mismatch`, `no-local-copy`, `already-host`, `local-path-unsafe`, `plugin-unavailable`, `redirect-registered`).
    2. Export `planHostModuleRedirect(input)` returning `Result<PiHostRedirectPlan, PiHostRedirectDiagnostic>` where `input` carries the proven host package root, the parsed host `package.json` `{name, version}`, and per-specifier `{ localEntryPath?, hostEntryPath? }` absolute paths.
    3. Validate every path: absolute, no `\0`, no `..`/`.` components, bounded length (reuse the bounds style in `rpc-child.ts`); reject a host package whose `name` is not `HOST_PACKAGE_NAME` (`host-compatibility.ts`).
    4. Emit one plan entry per specifier only when a local copy exists and differs from the host entry; otherwise record the skip reason. Map the bare `@earendil-works/pi-ai` specifier to the host's **compat** entry, matching Pi's own alias table in `dist/core/extensions/loader.js`.
    5. Export `renderHostReexportStub({ hostEntryPath, hasDefaultExport })` producing `export * from "<json-escaped path>";` plus `export { default } from ...` only when a default export was observed.
    6. Export a bounded, path-free `summarizeHostRedirect(plan)` string for health output, and a separate detailed record for the opt-in proof line.
  - **Pitfalls / non-goals**:
    - `export *` does not re-export `default`; deciding that from an observed namespace is the caller's input, not a guess here.
    - No I/O, no `Bun.*`, no dynamic import in this module — it must be trivially unit-testable.
    - Path-free strings for anything that can reach the logger or the health surface; absolute paths belong only in the opt-in proof record.
  - **Acceptance**:
    - Unit tests cover: redirect planned for a differing local copy; skip for identical paths; skip when no local copy exists; rejection for a mismatched host package name; rejection for unsafe paths; `pi-ai` mapped to the compat entry; stub text with and without a default export.
    - `bun test src/__tests__/host-module-redirect.test.ts` passes.

- [x] 2. Add the host-module loader edge
  - **What**: The impure counterpart that discovers host facts, registers the Bun plugin, imports the host namespaces, and returns a typed outcome — behind injectable ports so tests never touch Bun's real plugin registry.
  - **Files**: `packages/adapters/pi/src/host-module-loader.ts`, `packages/adapters/pi/src/__tests__/host-module-loader.test.ts`
  - **Depends on**: Task 1
  - **Implementation outline**:
    1. Define `PiHostModuleEnvironmentPort` with `mainModulePath()`, `readJsonFile(path)`, `resolveFrom(specifier, fromDir)`, `resolveLocal(specifier)`, `registerLoadOverride(exactPath, contents)`, and `importAbsolute(path)`; each fallible member returns `ResultAsync`.
    2. Provide `BunPiHostModuleEnvironment` implementing it with `Bun.main`/`process.argv[1]`, `Bun.file(...).json()`, `Bun.resolveSync`, `import.meta.resolve`, `Bun.plugin({ setup })` with an `onLoad` filter built from the exact local entry path, and `import()`.
    3. Export `resolveHostModules(env, options)` returning `ResultAsync<PiHostModuleOutcome, never>` — it never rejects. The outcome records `{ redirected: readonly specifier[], skipped: readonly { specifier, reason }[], hostVersion?, hostRoot?, localResolutions, proofRecord }`.
    4. Derive the host root as the parent of the directory containing the host CLI entry, then confirm `<root>/package.json` `name` and `version` before planning.
    5. Honor `WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1` by returning an outcome with every specifier skipped for a dedicated reason — this is the negative control for Task 5 and the operator escape hatch.
    6. Escape the regex-special characters when building the exact-path `onLoad` filter, and register at most one override per specifier per process.
  - **Pitfalls / non-goals**:
    - Never fail the extension because the redirect failed; a skipped redirect must preserve today's behavior.
    - `Bun.main` inside a compiled Pi binary points into `$bunfs`; treat it as `host-root-unproven` rather than fabricating a path.
    - Do not import the host namespaces before registering the override for the local copy — order matters.
    - Do not log through `logger` here; the caller decides what surfaces.
  - **Acceptance**:
    - Unit tests with a fake environment cover: successful redirect registration for all three specifiers; `$bunfs`-style main path producing `host-root-unproven`; missing/malformed host `package.json`; local resolution failure producing `no-local-copy`; the disable env var; and idempotent double invocation.
    - No test in this file calls `Bun.plugin` or performs real I/O.

- [x] 3. Split the extension entry into loader and implementation
  - **What**: Move the current extension body to `extension-impl.ts` and make `extension.ts` a thin async factory that resolves host modules first, then delegates. The shipped `dist/extension.js` must contain no bare `@earendil-works/*` import.
  - **Files**: `packages/adapters/pi/src/extension-impl.ts` (moved from `packages/adapters/pi/src/extension.ts`), `packages/adapters/pi/src/extension.ts` (new thin loader), `packages/adapters/pi/src/index.ts`, `scripts/release/constants.ts`, `packages/adapters/pi/api-extractor.extension.json`, and the ten test files importing `../extension.js` (`child-ref-live-session-manager.test.ts`, `extension.test.ts`, `child-inspection-privacy.test.ts`, `child-compaction-settlement.test.ts`, `child-mode.test.ts`, and the remaining five found with `grep -rl "\.\./extension\.js" src/__tests__`)
  - **Depends on**: Task 2
  - **Implementation outline**:
    1. `git mv` the body to `extension-impl.ts` unchanged, keeping `createPiExtension` and `export default createPiExtension()`.
    2. Write the new `extension.ts`: `export default async function weaveAdapterExtension(pi) { const outcome = await resolveHostModules(new BunPiHostModuleEnvironment()); const impl = await import("./extension-impl.js"); recordHostModuleOutcome(outcome); return impl.default(pi); }` — Pi awaits async factories before `session_start`.
    3. Publish the outcome through a module-level accessor in `host-module-loader.ts` (set once) so `extension-impl.ts` can read it without importing the loader entry.
    4. Add `packages/adapters/pi/src/extension-impl.ts` → `packages/adapters/pi/dist/extension-impl.js` to `PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"].entries` in `scripts/release/constants.ts`.
    5. Repoint `packages/adapters/pi/src/index.ts`'s `./extension.js` re-exports to `./extension-impl.js`, and update the ten test imports.
    6. Leave `package.json`'s `pi.extensions` at `["./dist/extension.js"]` and keep `files: ["dist", ...]` so the sibling impl ships.
    7. Re-run `bun scripts/validate-api-extractor-configs.ts` expectations: keep `api-extractor.extension.json` pointing at the loader entry and confirm the trimmed `dist/extension.d.ts` still builds.
  - **Pitfalls / non-goals**:
    - Do not let `extension.ts` statically import anything that transitively imports a Pi package; that would defeat the split. Only `host-module-loader.js` and a dynamic `import()` are allowed.
    - Do not add `extension-impl.js` to `pi.extensions`; Pi would load the adapter twice.
    - `providerFastLatestForTest` and other test hooks live on the impl factory result; keep them reachable from `extension-impl.js` imports.
    - Behavior of `createPiExtension` must not change in this task.
  - **Acceptance**:
    - `bun run --filter '@weaveio/weave-adapter-pi' build` emits both `dist/extension.js` and `dist/extension-impl.js`.
    - `grep -c "@earendil-works/" packages/adapters/pi/dist/extension.js` returns `0`.
    - `bun test src` in the Pi package passes with no behavioral test changes beyond import paths.
    - `bun run typecheck` and `bun run lint` pass.

- [x] 4. Surface the host-module outcome in diagnostics and health
  - **What**: Cross-check the imported host version against the proven host `package.json`, expose one bounded line in `/weave:health`, and emit an opt-in machine-readable proof line.
  - **Files**: `packages/adapters/pi/src/host-compatibility.ts`, `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/host-module-loader.ts`, `packages/adapters/pi/src/__tests__/host-compatibility.test.ts` (extend), `packages/adapters/pi/src/__tests__/host-module-proof.test.ts`
  - **Depends on**: Task 3
  - **Implementation outline**:
    1. Extend `BunHostPackageReader` (or add a sibling reader) so the reported host identity is the imported `VERSION` cross-checked against the outcome's proven `hostVersion`; on disagreement return the proven value and record a `host-runtime-duplicate` diagnostic.
    2. Add one health line to the existing `/weave:health` rendering in `extension-impl.ts`: `host runtime: single-copy` or `host runtime: duplicate-detected (<reason>)`, plus the count of redirected specifiers. Keep it path-free.
    3. When `WEAVE_PI_HOST_MODULE_PROOF=1`, write exactly one JSON line to stderr containing `{ weaveHostModuleProof: { hostRoot, hostVersion, specifiers: [{ specifier, bareResolution, loadedFrom, redirected }] } }`. Do not route it through `logger`, and gate it strictly on the env var since it contains absolute paths.
    4. Decide and document explicitly: a duplicate does **not** enter health-only mode. It is a warning, because the mismatch removes no declared capability and health-only would break users mid-upgrade.
  - **Pitfalls / non-goals**:
    - Keep the existing `HOST_VERSION_FLOOR` gate semantics; only the source of truth for the version becomes stronger.
    - The health string must never include a filesystem path (adapter logging policy in `docs/adapters/pi.md`).
    - The proof line must be a single line, valid JSON, and bounded in size.
  - **Acceptance**:
    - Tests prove: proven version wins over a mismatched imported `VERSION`; health text for both single-copy and duplicate states; proof line emitted only with the env var set; proof line parses as JSON.
    - No new required capability is declared, and `capability-declarations.test.ts` remains green.

- [x] 5. Add the real-process host-singleton proof script
  - **What**: A Bun script that starts a real Pi process with the built extension, asserts a single Pi runtime copy, and fails when the redirect is disabled.
  - **Files**: `scripts/pi/verify-host-singleton.ts`, `scripts/pi/__tests__/verify-host-singleton.test.ts`, `package.json` (add `verify:pi-host-singleton` script)
  - **Depends on**: Tasks 3 and 4
  - **Implementation outline**:
    1. Resolve the host CLI from `PI_HOST_CLI` or `which pi`; read its `package.json` name and version. When no host is available, print a clear skip reason and exit `0` only under `--allow-skip`; otherwise exit non-zero.
    2. Build (or require a freshly built) `packages/adapters/pi/dist/extension.js` and record its SHA-256.
    3. Positive run: spawn `pi --mode rpc --no-session --no-extensions -e <abs dist/extension.js>` with `WEAVE_PI_HOST_MODULE_PROOF=1`, `PI_OFFLINE=1`, an isolated temp `cwd`, and no Weave child variables. Wait for the proof line with a bounded timeout.
    4. Assert from the proof line: `hostVersion` equals the host `package.json` version; every specifier's `loadedFrom` is under the host root; at least one `bareResolution` differs from `loadedFrom` when a checkout copy exists (the redirect actually did work).
    5. Assert externally with the OS: run `lsof -p <pid>` (fall back to `/proc/<pid>/maps` on Linux) and require zero mapped files under the Weave checkout's `node_modules` for `@earendil-works` paths, and at most one distinct package root among mapped `.node` modules.
    6. Negative control: repeat the run with `WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1` and require the assertions in steps 4–5 to fail; the script fails if the detector cannot see the duplicate.
    7. Always terminate the spawned process and remove temp directories, including on failure paths. Print a compact PASS/FAIL summary with the artifact digest, host version, and both run outcomes.
  - **Pitfalls / non-goals**:
    - This script is not part of `bun test`; adapter tests must not spawn harnesses.
    - RPC mode is used only because it is scriptable; it proves module loading, not adapter readiness. Task 15 owns readiness and behavior proof.
    - Guard against a stray long-lived `pi` process: use a bounded timeout plus `SIGKILL` on cleanup, and assert the child exited.
  - **Acceptance**:
    - `bun run verify:pi-host-singleton` prints PASS with the positive run clean and the negative control detected, against the installed Pi host.
    - Unit tests cover the script's pure parts (proof-line parsing, `lsof` output classification, skip logic) with fixtures.

- [x] 6. Lock the artifact invariants with a build-output test
  - **What**: A test that fails if a future change reintroduces a bare Pi import into the loader entry or mis-registers the impl entry.
  - **Files**: `packages/adapters/pi/src/__tests__/extension-entry-artifact.test.ts`, `scripts/release/__tests__/` (extend the existing build-constants test if one covers entries)
  - **Depends on**: Task 3
  - **Implementation outline**:
    1. Assert on `scripts/release/constants.ts` data that the Pi package declares both `dist/extension.js` and `dist/extension-impl.js` entries and keeps the three Pi packages in `PUBLIC_RUNTIME_EXTERNALS`.
    2. Assert on the package manifest that `pi.extensions` lists only `./dist/extension.js`.
    3. Assert on the source of `packages/adapters/pi/src/extension.ts` that it contains no `@earendil-works/` import and no static import of `./extension-impl.js`.
  - **Pitfalls / non-goals**:
    - Read source and manifest text, not built output — the test must pass on a clean checkout without a prior build.
    - Keep the assertions structural, not snapshot-based.
  - **Acceptance**:
    - The test fails when a bare Pi import is added back to `extension.ts` (verify by temporary local edit before committing).
    - `bun test` passes with the test in place.

- [x] 7. Add an engine-owned adapter preference repository and migration v6
  - **What**: A harness-neutral, bounded key/value repository on `RuntimeStore` so adapters can persist small configuration records without owning tables or interpreting them in the engine.
  - **Files**: `packages/engine/src/runtime/types.ts`, `packages/engine/src/runtime/store.ts`, `packages/engine/src/runtime/sqlite/schema.ts`, `packages/engine/src/runtime/sqlite/migrations.ts`, `packages/engine/src/runtime/sqlite/store.ts`, `packages/engine/src/runtime/memory-store.ts`, `packages/engine/src/index.ts`, `packages/engine/src/__tests__/runtime-preferences.test.ts`, `packages/engine/src/__tests__/runtime-permissions.test.ts` (schema-version assertion), `packages/engine/src/__tests__/runtime-sqlite.test.ts`
  - **Depends on**: None
  - **Implementation outline**:
    1. Add table `adapter_preferences(namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (namespace, key))` as migration version 6 and bump `CURRENT_SCHEMA_VERSION` to `6`, following the existing expected-column validation style.
    2. Add `AdapterPreferenceRepository` to `RuntimeStore` (and to `RuntimeStoreTransaction` if the transaction surface needs it) with `get(namespace, key)`, `set(namespace, key, value)`, `list(namespace, limit)`, and `remove(namespace, key)`, all returning `ResultAsync<_, RuntimeStoreError>`.
    3. Enforce bounds in the engine: namespace ≤ 64 chars, key ≤ 128 chars, serialized value ≤ 16 KiB, `list` limit ≤ 100 with a documented default; reject control characters and NUL.
    4. Store the value as an opaque JSON string. The engine must not interpret it and must not accept a value that is not valid JSON.
    5. Mirror the contract in `createInMemoryRuntimeStore()`.
    6. Update `expect(CURRENT_SCHEMA_VERSION).toBe(5)` in `runtime-permissions.test.ts` to `6` and add a migration test proving an existing v5 database upgrades in place with no data loss.
  - **Pitfalls / non-goals**:
    - No Pi-specific field names, enums, or validation in the engine — that would move harness knowledge across the boundary.
    - Preferences must never hold secrets; state that in the doc comment and in `docs/reference/runtime.md` (Task 13).
    - Keep migration SQL idempotent and transactional like the existing ones; no `foreignKeysOff` is needed.
  - **Acceptance**:
    - Tests cover: fresh initialization at v6; upgrade from a v5 fixture; set/get round-trip; overwrite updates `updated_at`; bounds rejections; `list` limit clamping; removal; in-memory parity.
    - `bun run --filter '@weaveio/weave-engine' test` and `bun run typecheck` pass.

- [x] 8. Add the bounded read-only CLI query
  - **What**: `weave runtime preferences` prints stored adapter preferences with bounded output, matching the existing read-only runtime command style.
  - **Files**: `packages/cli/src/args.ts`, `packages/cli/src/commands/runtime.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`
  - **Depends on**: Task 7
  - **Implementation outline**:
    1. Extend `runtimeSubcommand` to `"status" | "journal" | "preferences"` and parse an optional `--namespace <ns>` plus the existing `--limit <n>`.
    2. Implement `runRuntimePreferences` reading through the repository, printing `namespace  key  updated_at  <value preview>` with a truncated, single-line value preview and a clear "no preferences stored" path.
    3. Keep the no-store-found behavior identical to the other subcommands (message plus exit `0`).
  - **Pitfalls / non-goals**:
    - Read-only: the command must never create or migrate a store that does not exist.
    - Truncate the value preview by bytes, not characters, and never print more than the requested limit of rows.
  - **Acceptance**:
    - Tests cover: default listing, namespace filter, limit clamping, empty store, missing database file, and value truncation.
    - `weave runtime preferences --help`-level argument errors return a non-zero exit with a clear message.

- [x] 9. Add the Pi child-extension selection record and its semantics
  - **What**: The adapter-owned schema, defaults, and migration rules for the value stored under the Pi preference namespace.
  - **Files**: `packages/adapters/pi/src/child-extension-selection.ts`, `packages/adapters/pi/src/__tests__/child-extension-selection.test.ts`
  - **Depends on**: Task 7
  - **Implementation outline**:
    1. Define constants `PI_PREFERENCE_NAMESPACE = "adapter-pi"` and `CHILD_EXTENSION_SELECTION_KEY = "child-extensions"`.
    2. Define the record with zod: `{ schemaVersion: 1, mode: "inherit-all" | "explicit", entries: readonly { id: string, source: string, path: string, label: string }[] }`, bounded to at most 64 entries and 512 bytes per field, rejecting NUL and relative paths.
    3. Define the identity rule: `id` is `sourceInfo.source` when `origin === "package"` (for example `npm:pi-vim`), otherwise the absolute resolved extension path.
    4. Define default and migration semantics explicitly, and encode them as pure functions:
       - No stored record → `mode: "inherit-all"`, which reproduces today's behavior exactly (no `--no-extensions`, no `-e`).
       - Malformed or unknown-`schemaVersion` record → treat as absent, keep `inherit-all`, and return a bounded diagnostic; never fail the spawn.
       - `mode: "explicit"` with entries that are no longer present in the live inventory → drop them, keep the rest, and return a `dropped` diagnostic list. Renamed or moved extensions are indistinguishable from removed ones and are dropped the same way.
       - An `explicit` record whose entries all disappeared still means `explicit`: the child loads Weave only. Do not silently promote it back to `inherit-all`.
    5. Export `resolveChildExtensionPlan({ record, inventory, weaveEntry })` returning the ordered, deduplicated argv-ready path list with Weave always first, plus the diagnostics.
  - **Pitfalls / non-goals**:
    - The mandatory Weave entry is never persisted in `entries`; it is derived at resolve time so a stale stored path can never disable or misdirect the adapter.
    - No I/O and no host API calls in this module.
  - **Acceptance**:
    - Tests cover: absent record; malformed record; `inherit-all`; `explicit` with all entries available; `explicit` with some entries missing; `explicit` with zero surviving entries; bounds rejections; Weave always first and never duplicated.

- [x] 10. Enumerate the Pi extension inventory
  - **What**: A best-effort, read-only inventory of the extensions the host can load, marked with mandatory/optional status and availability, with typed degradation when host APIs are missing.
  - **Files**: `packages/adapters/pi/src/pi-extension-inventory.ts`, `packages/adapters/pi/src/__tests__/pi-extension-inventory.test.ts`
  - **Depends on**: Task 9
  - **Implementation outline**:
    1. Define `PiExtensionInventoryPort` with narrow members: `commands()`, `tools()`, `configuredPackages()`, `installedPackagePath(source, scope)`, `agentDirectory()`, `listDirectory(path)`, `readJson(path)`. Every member is optional or fallible so a host gap degrades instead of throwing.
    2. Build entries from three evidence sources and union them by identity: loaded-command/tool `sourceInfo`; configured packages (`listConfiguredPackages()` plus `getInstalledPath()` plus that package's `pi.extensions`); directory scans of `<agentDir>/extensions` and, only when the project is trusted, `<cwd>/.pi/extensions`.
    3. Mark the Weave adapter entry as `mandatory: true` using the existing `isOwnSourceInfo` check, or the loader's own resolved extension path when `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` is set.
    4. Record per-entry `evidence` (`loaded`, `configured-package`, `discovered-file`) and `available` so the TUI can render honestly, and cap the inventory (for example 200 entries) with a truncation flag.
    5. Return `Result<PiExtensionInventory, PiExtensionInventoryDegradation>` where degradation still carries whatever partial inventory was gathered.
  - **Pitfalls / non-goals**:
    - Never load or evaluate another extension to inventory it.
    - Never install, update, or resolve packages over the network; do not call `PackageManager.resolve()` with an installing `onMissing`.
    - Extensions that register nothing and live outside the scanned locations cannot be enumerated. Document that limit in Task 13 and reflect it in the TUI copy.
    - Directory scans must be bounded in depth and entry count.
  - **Acceptance**:
    - Tests with fake ports cover: union across evidence sources; mandatory marking with and without provenance enforcement; missing host APIs producing partial inventory plus degradation; truncation; project scan skipped when untrusted.

- [x] 11. Apply the selection to child spawn argv
  - **What**: Spawned RPC children receive `--no-extensions` plus one `-e <path>` per resolved extension when the user has saved an explicit selection, and today's argv otherwise.
  - **Files**: `packages/adapters/pi/src/rpc-child.ts`, `packages/adapters/pi/src/child-env.ts`, `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/delegation-controller.ts`, `packages/adapters/pi/src/direct-dispatch.ts`, `packages/adapters/pi/src/__tests__/child-env.test.ts`, `packages/adapters/pi/src/__tests__/rpc-child-spawn-extensions.test.ts`
  - **Depends on**: Tasks 9 and 10
  - **Implementation outline**:
    1. Add an optional `resolveExtensionArgs: () => readonly string[]` to `PiRpcChild`'s construction input; `buildSpawnCommand` appends its result to the base command before session flags.
    2. Validate the appended args inside `buildSpawnCommand`: only `--no-extensions` and `-e <absolute safe path>` pairs, bounded count (for example ≤ 32) and length, no session flag, no `\0`. Any violation fails the spawn with the existing `ChildSpawnFailed` path rather than silently dropping args.
    3. In `extension-impl.ts`, resolve the stored record once per generation after the Runtime Store opens, combine it with the inventory and the derived Weave entry through `resolveChildExtensionPlan`, and pass the resulting provider to both spawn sites (`deps.childCommand` consumers for delegation and direct dispatch).
    4. When the plan is `inherit-all`, the provider returns an empty array so argv is byte-identical to today's.
    5. Log a bounded, path-free warning once per generation when entries were dropped.
  - **Pitfalls / non-goals**:
    - `-e npm:<pkg>` must never be emitted; Pi would install to a temp directory per child.
    - The Weave path is mandatory and always first; if it cannot be derived, keep `inherit-all` rather than spawning a child without Weave.
    - Child mode activates before command validation, so a path-loaded Weave extension in the child is fine; do not add provenance handling for the child.
    - Removing provider extensions from children can remove models and credentials that child model resolution needs. Preserve the `inherit-all` default and surface the risk in the TUI copy (Task 12).
  - **Acceptance**:
    - Tests prove: default argv unchanged; explicit selection produces `--no-extensions -e <weave> -e <selected>...` in order; session flags still rejected; oversized or malformed arg lists fail closed; direct-dispatch and delegation paths both apply the provider.
    - Existing spawn tests remain green.

- [x] 12. Add the `/weave:pi-config` command and TUI
  - **What**: A polished native Pi TUI that shows mandatory versus optional extensions, current selection, validation, and save/cancel, and registers as a first-class `/weave:*` command.
  - **Files**: `packages/adapters/pi/src/commands.ts`, `packages/adapters/pi/src/pi-config-ui.ts`, `packages/adapters/pi/src/extension-impl.ts`, `packages/adapters/pi/src/capability-prober.ts` (inventory message), `packages/adapters/pi/src/__tests__/pi-config-ui.test.ts`, `packages/adapters/pi/src/__tests__/commands.test.ts`, `packages/adapters/pi/src/__tests__/capability-prober.test.ts`
  - **Depends on**: Tasks 9, 10, 11
  - **Implementation outline**:
    1. Add `"weave:pi-config"` to `WEAVE_COMMAND_NAMES`, classify it `mutating` (health-only mode blocks it, consistent with delegation being blocked there), register it in the `extension-impl.ts` command loop, and add it to the `/weave` palette list with a short description.
    2. Update the capability-prober details string that currently says "twelve commands" to a count-free wording, and update its tests.
    3. Build `pi-config-ui.ts` as a pure component model plus a render function, following `plan-task-list.ts`: it receives the inventory, the current record, host `theme` and `keybindings`, and returns `render(width)` / `handleInput(data)` / `onChange`.
    4. Rows: a pinned first row `Weave adapter — always enabled` rendered as locked (no checkbox affordance, dim "mandatory" tag), then optional entries sorted by scope then label, each showing selection mark, label, scope (`user`/`project`/`package`), and an `unavailable` tag when the stored entry no longer resolves.
    5. Keys through `matchesKey` with Pi's own keybindings: move up/down, space to toggle, `a` to select all, `n` to select none, Enter to save, Esc to cancel. Show the key hints in a footer row.
    6. Header/footer copy must state: children load only the selected extensions plus Weave; unselected provider extensions will not supply models or credentials to children; changes apply to newly spawned children after this session's next start, and never to running children.
    7. Save writes the `explicit` record (or clears it back to `inherit-all` when the user chooses "inherit all"); include an explicit `Inherit all extensions` toggle row so the default state is reachable from the UI.
    8. Cancel makes no write. Both paths settle the `ctx.ui.custom` promise exactly once, following the `openPlanTaskList` settle pattern, and both notify the outcome.
    9. Gate on `ctx.mode === "tui" && ctx.ui.custom !== undefined`; otherwise notify that the command requires TUI mode. Notify a clear message when the Runtime Store is unavailable, and open read-only when the inventory is degraded.
  - **Pitfalls / non-goals**:
    - Never render the Weave row as toggleable, and reject a save payload that tries to include or exclude it.
    - Do not write to `~/.pi/agent/settings.json` or any `.weave` config file.
    - Reuse the generation-authority guards from `openPlanTaskList`; a stale generation may only settle the overlay.
    - Keep component logic pure and testable; no direct Pi imports in `pi-config-ui.ts` beyond the key-matching port already used by sibling components.
  - **Acceptance**:
    - Component tests cover: rendering with mandatory row pinned; toggling; select-all/none; unavailable entries; save payload shape; cancel producing no write; inherit-all round-trip; width truncation.
    - Command tests cover: registration and classification; blocked in health-only; TUI-mode gating; store-unavailable message.
    - `capability-prober` still reports all commands exclusively owned with the new entry present.

- [x] 13. Update documentation and add changesets
  - **What**: Document the host-singleton contract, the new command, the preference repository, and the CLI query; add changesets for the affected packages.
  - **Files**: `docs/adapters/pi.md`, `docs/testing/adapter-verification.md`, `docs/reference/runtime.md`, `docs/reference/cli.md`, `.changeset/pi-host-singleton.md`, `.changeset/pi-child-extension-config.md`
  - **Depends on**: Tasks 4, 8, 11, 12
  - **Implementation outline**:
    1. `docs/adapters/pi.md`: add `/weave:pi-config` to the user-surface list; add a short "Host runtime resolution" subsection explaining the loader entry, the redirect, the fail-open behavior, and the health line; extend "Private children" with the child extension selection, its `inherit-all` default, the dropped-entry rule, and the provider-extension caveat.
    2. `docs/testing/adapter-verification.md`: reference `bun run verify:pi-host-singleton` as the module-identity proof, and keep the existing nested-copy warning aligned with the new mechanism.
    3. `docs/reference/runtime.md`: add the preference repository row to the repository table, its bounds, the "never store secrets" rule, and the schema version bump.
    4. `docs/reference/cli.md`: document `weave runtime preferences` with its flags and bounded output.
    5. Add changesets: `@weaveio/weave-adapter-pi` (minor), `@weaveio/weave-engine` and `@weaveio/weave-cli` per the policy in `scripts/release/changeset-policy.ts`.
  - **Pitfalls / non-goals**:
    - Keep the documented capability floor at `0.81.1`.
    - Do not document behavior the code does not yet have (for example live re-application to running children).
  - **Acceptance**:
    - `bun run docs:check-links` passes.
    - `bun run changeset:check` passes.

- [x] 14. Run full repository validation
  - **What**: Prove the whole workspace is green after all repository changes.
  - **Depends on**: Tasks 1–13
  - **Implementation outline**:
    1. `bun test`
    2. `bun run typecheck`
    3. `bun run lint`
    4. `bun run build`
    5. `bun run docs:check-links` and `bun run validate-config`
    6. `bun run verify:pi-host-singleton`
  - **Pitfalls / non-goals**:
    - Do not silence a failing test by weakening an assertion; fix the cause.
    - Rebuild before the singleton proof so the script inspects current bytes.
  - **Acceptance**:
    - Every command exits `0`; record the Pi package test count and the built `dist/extension.js` SHA-256 in the work log.

- [ ] 15. Prove the fix in a real Pi host
  - **What**: Follow `docs/testing/adapter-verification.md` end to end and capture memory evidence for the duplicate-runtime claim.
  - **Depends on**: Task 14
  - **Implementation outline**:
    1. Capture a baseline first: with the current setup, record the running Pi process RSS, thread count (`ps -M`), and mapped `@earendil-works` paths (`lsof -p <pid>`).
    2. Build the adapter, record the `dist/extension.js` digest, and load it through the existing local development path (global symlink `~/.pi/agent/extensions/weave-adapter-pi`, `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` in the launcher only).
    3. Restart every Pi process, then start a fresh interactive TUI.
    4. Confirm `/weave:health` reports ready, `health-only: false`, and the new `host runtime: single-copy` line; confirm `/weave:status` reports trusted interactive mode.
    5. Open `/weave:pi-config`, confirm the mandatory Weave row, save an explicit selection, and confirm the notice about newly spawned children.
    6. Restart, run one `shuttle-mini` delegation, and confirm from the child's argv (`ps -o args= -p <child pid>`) that it carries `--no-extensions`, the Weave `-e` path first, and only the selected extensions.
    7. Re-measure RSS, thread count, and mapped `@earendil-works` paths; compare against the baseline.
    8. Confirm no residual child process and no active Runtime Store lease (`weave runtime status`).
  - **Pitfalls / non-goals**:
    - A successful import is not a load proof, a load is not readiness, readiness is not behavior; report the three separately.
    - Do not use the provenance override for any release verification claim.
    - Restore the user's saved selection (or clear it back to `inherit-all`) when the proof ends, unless the user asks to keep it.
  - **Acceptance**:
    - Evidence file recording: baseline versus post-fix mapped copies, RSS, thread counts; `/weave:health` output; child argv; delegation result; clean shutdown state.
    - Exactly one `@earendil-works/pi-coding-agent` copy is mapped by the Pi process after the fix (excluding copies owned by other extensions still installed).

- [ ] 16. Remove `pi-cursor` from the local Pi configuration
  - **What**: A local operational step, separate from repository code: drop the `pi-cursor` package entry so its own `@earendil-works` tree stops loading into the host process.
  - **Depends on**: Task 15 baseline capture
  - **Implementation outline**:
    1. Back up `~/.pi/agent/settings.json` to a timestamped file and record the backup path.
    2. Remove the `"/Users/jose/projects/pi-cursor"` entry from the `packages` array, leaving the other entries untouched.
    3. Stop every running Pi process; existing processes keep the old configuration and the old extension code in memory.
    4. Start a fresh Pi TUI and confirm `pi-cursor` no longer loads and that no load error appears.
    5. Re-measure the host process with `lsof -p <pid>` and confirm no `@earendil-works` paths under `/Users/jose/projects/pi-cursor`.
  - **Pitfalls / non-goals**:
    - Cursor-provided models disappear with the package; confirm the user still has the model access they need before finishing.
    - Do not modify the `/Users/jose/projects/pi-cursor` checkout, and do not commit anything from it.
    - Do not commit the settings change to any repository.
  - **Acceptance**:
    - Settings backup path recorded; `packages` array contains every previous entry except `pi-cursor`.
    - A fresh Pi process maps no `@earendil-works` file under the `pi-cursor` checkout.

## Verification

Repository (Task 14):

```bash
bun test
bun run typecheck
bun run lint
bun run build
bun run docs:check-links
bun run validate-config
bun run changeset:check
bun run verify:pi-host-singleton
```

Passing output means: every workspace test suite reports `0 fail`; `tsc --noEmit` prints nothing; Biome and declaration validation report no errors; the build emits `packages/adapters/pi/dist/extension.js` and `dist/extension-impl.js`; the link checker and config validator exit `0`; and the singleton script prints `PASS` with the positive run clean and the negative control detecting the duplicate.

Real host (Tasks 15–16): a fresh interactive Pi TUI reports `Weave adapter mode: ready`, `health-only: false`, and `host runtime: single-copy`; `/weave:pi-config` saves a selection; a delegated child's argv shows `--no-extensions` with the Weave extension path first; `lsof` on the host process shows exactly one `@earendil-works/pi-coding-agent` copy; and `weave runtime status` shows no active lease with no residual child process.
