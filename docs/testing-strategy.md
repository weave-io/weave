# Testing Strategy

Weave is tested **outside-in**. The tests that matter treat Weave as a black
box with three user-facing surfaces — the **DSL**, the **CLI**, and the
**adapters** — and assert only what a user can observe from outside it.

This document records the taxonomy, the inventory that motivated it, and the
cleanup still outstanding. The bucket contract itself lives next to the tests in
[`tests/README.md`](../tests/README.md).

## The three buckets

| Bucket | Directory | The black box | Input | Output asserted |
| --- | --- | --- | --- | --- |
| **DSL** | [`tests/dsl/`](../tests/dsl/) | The `.weave` language | Config source text | Resolved agents, categories, errors |
| **CLI** | [`tests/cli/`](../tests/cli/) | The `weave` command | `argv` + virtual filesystem | Exit code, stdout, stderr |
| **Adapters** | [`tests/adapters/`](../tests/adapters/) | Weave end to end | Config source text | Generated harness files |

Each bucket enters through a seam a real caller has, and nothing narrower:

| Bucket | Entry seam | Source |
| --- | --- | --- |
| DSL | `parseConfig` → `materializeAgents` | [`packages/core/src/index.ts`](../packages/core/src/index.ts), [`packages/engine/src/materialization.ts`](../packages/engine/src/materialization.ts) |
| CLI | `run({ argv, terminal, fs })` | [`packages/cli/src/cli.ts`](../packages/cli/src/cli.ts) |
| Adapters | adapter constructor + `init` / `spawnSubagent` / `flush` | [`packages/engine/src/adapter.ts`](../packages/engine/src/adapter.ts) |

Unit tests are still welcome — they just live next to their module in
`packages/*/src/__tests__/` and carry no scenario framing. The rule is about
*where a promise is made*: if a user can observe it, it belongs in `tests/`.

## Why scenario framing

A newcomer should be able to open one file and learn what Weave promises in one
situation. So a `describe` names the **situation** and each `it` names **one
promise**:

```ts
describe("a user turns off the shuttle agent entirely", () => {
  it("removes every category shuttle with it, so no orphaned routes remain", async () => {
```

Compare with the shape that dominates the current suite:

```ts
describe("toPermissionRules", () => {
  describe("read dimension", () => {
    it("maps allow", () => {
```

The second tells you which function was called. The first tells you what breaks
for a user, and survives that function being renamed, inlined or replaced.

## Inventory — 2026-09-20

Baseline before any cleanup: **187 test files, 119,097 lines, 5,630 cases.**

| Package | Files | Cases |
| --- | --- | --- |
| `packages/cli` | 56 | 2,587 |
| `packages/engine` | 41 | 1,684 |
| `packages/adapters/opencode` | 16 | 415 |
| `packages/core` | 9 | 414 |
| `packages/config` | 12 | 198 |
| `packages/adapters/opencode2` | 32 | 147 |
| `packages/adapters/copilot` | 9 | 102 |
| `packages/adapters/claude-code` | 7 | 68 |
| `scripts` | 5 | 15 |
| `packages/adapters/pi` | 0 | 0 |

### Findings

**1. The suite is overwhelmingly white-box.** 144 of 187 files import a deep
internal module (`from "../some-module.js"`); only 82 enter through a package
barrel. 146 distinct internal modules are imported directly by tests, so most
internal renames are breaking changes by construction.

**2. Ambient state leaks into tests.** 23 cases failed on a developer machine
purely because they read the developer's real `~/.weave/config.weave` —
14 in `evals/__tests__/prompt-snapshots.test.ts`, 8 elsewhere in the CLI, and
`copilot/src/__tests__/marketplace.test.ts`. They passed in CI only because CI
has no global config. Fixed in #185 and #186; the wider rule stands — a test
must not read state the developer happens to have. See the `MemoryFileSystem`
pattern in [`tests/cli/`](../tests/cli/).

**3. Type-echo tests assert the compiler's job.** 48 cases assert nothing but
what `tsc --noEmit` already proves. The dominant shape builds a typed literal
and then asserts the literal:

```ts
const dispatchEffect: DispatchAgentEffect = { kind: "dispatch-agent", ... };
expect(dispatchEffect.kind).toBe("dispatch-agent");
```

`tsc --noEmit` already proves this. The rest are `expect(typeof X).toBe("function")`
on an import, and whole `describe`s covering the shape of an `Input`/`Output`
type.

The pattern is consistent enough to state as a rule: within a
constant-surface `describe`, the case asserting the *runtime constant's*
contents (`expect(ALL_CAPABILITY_IDS).toHaveLength(19)`) is real and was kept,
while the neighbouring `"<Type> type accepts …"` case only echoes a literal
and was deleted. Likewise `LifecycleError discriminants` calls the real factory
functions, so it stays.

**4. `execution-lifecycle.test.ts` duplicates its own split.** The 10,301-line,
348-case monolith and the 82-case `execution-lifecycle/` directory both cover
all ten lifecycle entry points — `observeSession`, `startExecution`,
`resumeExecution`, `dispatchStep`, `completeStep`, `beforeTool`,
`reconcileExecution`, `handleUserInterrupt`, `validateReconciliationSource`,
`inspectExecution`. The split was started and the monolith never retired.

**5. Test names encode the implementation plan, not the behaviour.** 31 names
across 10 files carry `Spec 22 Unit 1`, `Task 3.2`, `ADR 0004`, `Phase 1`. These
date instantly and mean nothing to a newcomer.

**6. Setup is copy-pasted instead of shared.** `makeDescriptor` is redefined in
11 files, `makeEvalRubric` in 8, `makeDryRunSummary` in 7. Only 5 shared helper
modules exist across the whole suite.

**7. Ad-hoc inline DSL instead of named fixtures.** `compose.test.ts` contains
88 inline `agent … { }` snippets and `materialization.test.ts` 87. Almost none
of them are named after the situation they represent.

**8. One-assertion-per-case fragmentation.** `claude-code/src/__tests__/integration.test.ts`
splits a single pipeline run across 10 `it` blocks of one assertion each, so the
scenario has to be reassembled by reading all of them.

**9. Gaps.** `packages/adapters/pi` has no tests because it has no source in
this repo — only `README`, `CHANGELOG`, api-extractor configs and the committed
`etc/*.api.md` reports are tracked; the implementation ships from elsewhere. Its
four api-extractor configs were also excluded from `validate:declarations`, so
nothing about the package was checked. Separately, 2 cases are genuinely
`it.skip`ped (both in `copilot/src/__tests__/integration.test.ts`, both
documented as needing source mutation to demonstrate); the other suppressed
cases use `skipIf` and are legitimately gated on platform or env.

**10. The buckets are scaffolded, not populated.** `tests/` holds one scenario
file per bucket, and of the four adapters with source in this repo only
`claude-code` has one.

On the CLI side the original wording — "five commands cannot be driven through
`run()`" — was imprecise. Each command already had *a* seam; they were just
different ones, and `run()` threaded none of them:

| Command | Seam it already had |
| --- | --- |
| `validate`, `init` | `fs` |
| `migrate` | `fs` (required; reached through `init`) |
| `prompt` | `configLoader`, `cwd` |
| `runtime` | `cwd`, `storeFactory`, `dbExists` |
| `eval` | `env`, `runner`, validator overrides |
| `compose` | none — used `Bun.file`, `process.cwd()` and `homedir()` directly |

Threading `cwd` alone also turned out to be insufficient: `loadConfig()` falls
back to its own Bun-backed reader, so a command handed an injected `cwd` still
read the real disk. `toConfigFileReader()` bridges a `FileSystem` into config
discovery, which is what actually closes the gap.

### Landed

- **#185 — tests read the developer's global config.** Finding 2. Added
  `WEAVE_GLOBAL_CONFIG_DIR`, which redirects the global config scope away from
  the home directory; [`scripts/test-setup.ts`](../scripts/test-setup.ts) points
  it at an empty fixture. See
  [Config Loading](config-loading.md#redirecting-the-global-scope--weave_global_config_dir).
- **#186 — 308 tests never ran in CI.** Larger than finding 2 first recorded:
  `adapter-opencode2` (149) and `adapter-claude-code` (76) had no `test` script
  at all, `scripts/**` (62) sits outside every workspace, and the CLI enumerated
  its test directories by hand, missing `src/prompts/__tests__` (20).

  That work exposed a second defect: **bun reads only the `bunfig.toml` in the
  current working directory**, so a package tested from its own directory —
  exactly what `bun run --filter '*' test` does — never loaded the root preload.
  Neither `LOG_LEVEL=silent` nor `WEAVE_GLOBAL_CONFIG_DIR` applied on the CI
  path, so #185's fix covered only runs started from the repository root. Each
  package now carries its own `bunfig.toml`, and
  [`scripts/ci/verify-test-coverage.ts`](../scripts/ci/verify-test-coverage.ts)
  enforces both properties.
- **`AGENTS.md` documented a removed DSL key.** Its category examples still
  showed `patterns [...]`, dropped from `CategoryConfigSchema` in favour of
  `triggers`. That stale key is what invalidated the global config which made
  finding 2 visible.

## Cleanup plan

Every finding maps to a step; steps are ordered by value per unit of risk.

| # | Action | Finding | Effect | Status |
| --- | --- | --- | --- | --- |
| 1 | Delete the type-echo cases | 3 | −48 cases, −604 lines, no coverage lost | **done** |
| 5 | Rename spec-numbered tests to behaviour | 5 | Readable by newcomers | **done** |
| 7 | Cover `packages/adapters/pi` | 9 | Its four api-extractor configs now run under `validate:declarations` | **done, reduced** |
| 2 | Retire `execution-lifecycle.test.ts` into the existing split, keeping only cases the split lacks | 4 | −9.8k lines | open |
| 3 | Make the 23 ambient-state tests hermetic | 2 | Suite becomes trustworthy locally | **done** — #185, #186 |
| 8 | Thread an injected filesystem and environment through `run()` to every command | 10 | Prerequisite for the CLI bucket; `compose` gained a seam, `prompt` and `runtime` gained fs-backed config discovery | **done** |
| 4 | Promote existing end-to-end coverage into `tests/`, starting with `claude-code/integration.test.ts` and the opencode/opencode2 translation tests | 1, 8 | Real scenarios, refactor-proof | open |
| 9 | Populate the buckets: DSL (workflows, `tool_policy`, prompt templates, config merge), CLI (the six uncovered commands), Adapters (opencode, opencode2, copilot) | 10 | The taxonomy stops being a scaffold | open |
| 6 | Consolidate duplicated factories into `tests/support/` and per-package `__tests__/support/` | 6 | Fixtures named after situations | open |
| 10 | Replace ad-hoc inline DSL with named scenario fixtures | 7 | 88 anonymous snippets in `compose.test.ts` alone become readable situations | open |
| 11 | Resolve or delete the 2 genuine `it.skip` cases | 9 | No silently-dead tests | open |

Step 7 was scoped as "give Pi a scenario file" and reduced once finding 9 was
understood: there is no Pi source in this repo to drive a scenario against, so
the declaration contract is the only thing testable here. A real Pi scenario
belongs wherever its implementation lives.

Steps 2 and 3 are subtraction and can land independently. Step 8 is a small
prerequisite that unblocks step 9. Steps 4 and 9 are where new value is added:
each promoted or new scenario should **replace** the white-box test that covered
the same promise rather than sit alongside it, otherwise the suite grows instead
of shrinking.

Finding 1 (white-box coupling) has no step of its own by design — unit tests
beside their module are legitimate. It resolves as a side effect of steps 4
and 9: every promise that moves to `tests/` is one fewer reason for a unit test
to reach into an internal module.

## See also

- [`tests/README.md`](../tests/README.md) — the bucket contract and how to write a scenario
- [Adapter Boundary](adapter-boundary.md) — what engine tests may and may not assume
- [DSL Reference](dsl-reference.md) — normative `.weave` syntax used by DSL scenarios
- [CLI](cli.md) — the commands the CLI bucket drives
