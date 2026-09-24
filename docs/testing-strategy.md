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

**4. `execution-lifecycle.test.ts` is a 9.7k-line file, but it is not a
duplicate — corrected.** The original finding claimed the monolith duplicated
the `execution-lifecycle/` directory, because both name all ten lifecycle entry
points (`observeSession`, `startExecution`, `resumeExecution`, `dispatchStep`,
`completeStep`, `beforeTool`, `reconcileExecution`, `handleUserInterrupt`,
`validateReconciliationSource`, `inspectExecution`) at `describe` level. That
inference was wrong: overlap at `describe` level says nothing about the cases
inside.

Comparing case bodies rather than names:

| | Cases |
| --- | --- |
| Monolith | 309 |
| `execution-lifecycle/` directory | 82 |
| Same name in both | 13 |
| **Same name _and_ same body** | **6** |

Seven of the 13 share a name but differ in setup or assertions, so they are not
interchangeable. **True duplication is 6 cases, not 309.** Those 6 were
removed; the remaining **303** monolith cases have no equivalent in the
directory and are real coverage. The projected "−9.8k lines" was never
available.

What remains true is that the file is the largest in the repository and hard to
navigate. Its 36 top-level `describe` blocks group cleanly by subject and map
onto the existing directory, so the remaining work is a reorganization that
moves those 303 cases rather than deleting them — see step 2 in the plan.

**5. Test names encode the implementation plan, not the behaviour.** 31 names
across 10 files carry `Spec 22 Unit 1`, `Task 3.2`, `ADR 0004`, `Phase 1`. These
date instantly and mean nothing to a newcomer.

**6. Setup is copy-pasted instead of shared.** `makeDescriptor` is redefined in
11 files, `makeEvalRubric` in 8, `makeDryRunSummary` in 7. Only 5 shared helper
modules exist across the whole suite.

**7. Ad-hoc inline DSL instead of named fixtures — withdrawn.**
`compose.test.ts` contains 88 inline `agent … { }` snippets and
`materialization.test.ts` 87, and the original finding proposed hoisting them
into named fixtures. Reading them shows why that would be a mistake: each is
minimal and tailored to its own assertion — `display_name` alone for the
identity test, a bare `prompt` for the prompt test. In a unit test the config
*is* the input, and keeping it beside the assertion is what makes the test
readable. Hoisting would force a reader to jump to a fixture file to learn what
is being fed in. The scenario-naming benefit the finding was reaching for
belongs in `tests/`, which now has it.

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

**11. A test double can reimplement the thing it is meant to test, and hide a
real bug indefinitely.** This is the one finding that is not about
organisation, and it is why the migration is worth more than a tidier tree.

The shape: a test file declares `class InMemoryXRunner extends XRunner` and
`override run()`, because the real `run()` touches the file system. The
override is not a stub — it is a second implementation of the method under
test, 140 lines in the Tapestry case, complete with its own copy of the
runner's helpers. Every `it()` in the file then asserts against that copy. The
tests are green, thorough, and describe a product that does not exist.

Two independently verified consequences:

- **`loom-routing` and `tapestry-execution` publish an empty green run.** Any
  `--model` typo filters every case out, and those two runners — alone among
  the eight — have no `workItems.length === 0` guard, so the run exits 0 with
  `totalCases: 0` and a published bundle. `loom-routing-runner.test.ts`
  referenced `NoCasesFound` eleven times and its docblock stated the guard
  existed. The guard was in `InMemoryLoomRunner`, at line 229 of the *test*
  file. Filed as [#205](https://github.com/pgermishuys/weave/issues/205).
  _Since fixed (Spec 37 task 16.1): `EvalOrchestrator` now fails any suite
  that ran no cases with `NoCasesFound`, and the bundle writer refuses a run
  with `totalCases: 0`. See
  [agent-evals.md](agent-evals.md#when-the-filters-leave-a-suite-nothing-to-run)._
- **Tapestry's alternate-delegate normalization was never exercised.**
  `normalizeDelegationChain()` rewrites a chain ending at an
  `accepted_alternates` entry back to the canonical expected delegate. The
  test file carried a verbatim copy named `normalizeDelegationChainForTest`.
  Replacing the product's condition with `if (false)` — disabling
  normalization outright — left all 32 unit tests green, including the one
  named *"normalizes accepted alternate shuttle variants back to the canonical
  expected delegate"*.

**How far it spread.** Eight eval runner test files on `main` used the pattern;
[#203](https://github.com/pgermishuys/weave/pull/203) and
[#204](https://github.com/pgermishuys/weave/pull/204) removed seven as a
side-effect of migrating those areas, and this change removes the last one.
Outside the eval runners it does not occur. The other test subclasses in the
repo — `SymlinkFileSystem extends MemoryFileSystem`, `FailingProbes extends
MemoryDetectionProbes`, `Mock/FailingOpenCodeAdapter extends OpenCodeAdapter` —
all override a *collaborator* to inject a condition, which is the legitimate
use and stays.

**The rule this gives us.** A test double may stand in for a dependency; it may
never stand in for the unit under test. Concretely: if a test file `extends` a
production class and `override`s a method, that method must be a collaborator
the test is injecting, never the behaviour the `it()` names. Where the real
method is untestable because of I/O, the fix is a seam — `withEvalFixtures()`
gives the runners a temporary `evals/` root and the real `run()` executes.

**What justified keeping them.** Each file argued that the signals involved —
a delegation chain, a completion cue — reach only the LLM judge and so have no
observable form. The premise was false. The judge is stubbed at the scenario
seam, so `judgeCalls` shows precisely what the runner asked it to score, and
the runner builds that input itself, normalization included. A claim that
something is unobservable deserves the same suspicion as an absence assertion:
check it against the harness before it is allowed to protect a double.

**Still open.** The four extractor suites in
`tapestry-execution-runner.test.ts` (~30 cases) are pure-function tests of
exported helpers. They are honest tests, but the same `judgeCalls` seam makes
their output observable end-to-end, so they are candidates for migration.

## Cleanup plan

Every finding maps to a step; steps are ordered by value per unit of risk.

| # | Action | Finding | Effect | Status |
| --- | --- | --- | --- | --- |
| 1 | Delete the type-echo cases | 3 | −48 cases, −604 lines, no coverage lost | **done** |
| 5 | Rename spec-numbered tests to behaviour | 5 | Readable by newcomers | **done** |
| 7 | Cover `packages/adapters/pi` | 9 | Its four api-extractor configs now run under `validate:declarations` | **done, reduced** |
| 2 | Split `execution-lifecycle.test.ts` by subject into `execution-lifecycle/`, moving its remaining 303 cases rather than deleting them | 4 | Navigable files; no line saving — the 6 duplicates finding 4 identified are already gone | open |
| 3 | Make the 23 ambient-state tests hermetic | 2 | Suite becomes trustworthy locally | **done** — #185, #186 |
| 8 | Thread an injected filesystem and environment through `run()` to every command | 10 | Prerequisite for the CLI bucket; `compose` gained a seam, `prompt` and `runtime` gained fs-backed config discovery | **done** |
| 4 | Promote existing end-to-end coverage into `tests/`, starting with `claude-code/integration.test.ts` and the opencode/opencode2 translation tests | 1, 8 | Real scenarios, refactor-proof | open |
| 9 | Populate the buckets | 10 | DSL: the engine's composition cluster is migrated — prompt sources, the template language, delegation, categories, `tool_policy` and the materialization plan. CLI: every command. Adapters: Copilot alongside Claude Code, on a shared harness; both OpenCode adapters, which register with a running harness rather than writing files, now have one each. Still open: workflows and config merge | **partly done** |
| 6 | Consolidate duplicated factories | 6 | −164 lines. Only genuine duplicates: `makeDryRunSummary` (5 identical copies in one directory) and three same-package `makeDescriptor` pairs. `makeEvalRubric`'s 8 copies are 8 *different* rubrics, and the adapters' `makeDescriptor` variants differ per harness — neither is duplication | **done** |
| 10 | Replace ad-hoc inline DSL with named scenario fixtures | 7 | — | **dropped** — see the withdrawal in finding 7 |
| 11 | Resolve or delete the 2 genuine `it.skip` cases | 9 | Both deleted: neither asserted anything (`expect(true).toBe(true)` and an empty body), and both had their reasoning recorded where it belongs — beside the allowlist assertions that do the guarding, and in the `adapter.ts` MCP TODO | **done** |

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

## Migrating an area

The buckets are worth little while the unit tests they replace remain. Migration
is the work, and the `claude-code` adapter is the worked example:

| | Before | After |
| --- | --- | --- |
| Unit cases | 68 in 7 files | 16 in 3 files |
| Scenario cases | 7 | 25 |
| Total | 75 | 41 |

**The rule is subsumption, not similarity.** A unit test goes when a scenario
asserts the same user-visible promise — even where the unit test also covers
internal branches. What stays is what a user cannot observe from outside:

| Kept | Why |
| --- | --- |
| `skill-discovery.test.ts` | A filesystem scanner. Harness resource discovery is adapter-owned per [Adapter Boundary](adapter-boundary.md), and its behaviour is not reachable from `.weave` source |
| `model-resolution.test.ts` | Pins the adapter↔engine `ModelResolutionInput` contract, which no generated file reveals. Its three cases pinning the adapter's model *constant* were deleted — those are observable |
| `bootstrap.test.ts` | Integrity of a shipped asset. Closer to a repo guard than a unit test |

The same rule applied to the evals sanitizer and report schemas:

Counts need one measure to be comparable. A table-driven `it.each` is one
case in the source and many at runtime, and the scenarios lean on tables far
harder than the unit tests did, so the two are quoted separately rather than
summed:

| | Before | After |
| --- | --- | --- |
| `sanitizer.test.ts` (source cases) | 140 | 91 |
| `report-schema.test.ts` (source cases) | 188 | 112 |
| **Unit total (source cases)** | **328** | **203** |
| Scenarios added (source cases) | — | 26 |
| Scenarios added (cases at runtime) | — | 113 |

125 unit cases went and 26 scenario cases arrived, running as 113. The
reduction is real, but it is not the point: the deleted ones were an enumeration
(`"contains composedPrompt"`, `"includes a pattern for html_script_tag"`) whose
user-visible form is an equally long table of hostile inputs fed through the
real bundle writer. The gain is not fewer tests but tests that fail when a
reader is put at risk, rather than when a constant is renamed. What stayed:

| Kept | Why |
| --- | --- |
| `assertPublishSafe()` / `assertJsonPublishSafe()` | The publish-mode guards. While the allowlist projection works they never fire, so no written file reveals their behaviour |
| The manifest schemas' rejection branches | The writer always passes the version constant, so a wrong `schemaVersion` is unreachable from outside; the branches guard a future producer |
| `sanitizeScoreRecord`, `dropUnknownFields`, `truncateExplanation`, `buildExplanation`, `assertExplanationSafe`, `REDACTED`, `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS` | Exported API with **no production caller** — see the finding below |

The reporting and publishing surface went the same way. Its black boxes are the
rendered `public-report.md`, the dashboard index files, and — through
`GitHubContentsPublisher`'s injected `fetch` — the HTTP requests a publish
makes:

| | Before | After |
| --- | --- | --- |
| `report-markdown.test.ts` (source cases) | 114 | 0 — deleted |
| `dashboard-indexes.test.ts` (source cases) | 104 | 19 |
| `github-contents-publisher.test.ts` (source cases) | 75 | 0 — deleted |
| **Unit total (source cases)** | **293** | **19** |
| Scenarios added (source cases) | — | 59 |
| Scenarios added (cases at runtime) | — | 113 |

What stayed, in
[`dashboard-indexes.test.ts`](../packages/cli/src/evals/__tests__/dashboard-indexes.test.ts):

| Kept | Why |
| --- | --- |
| `validateDashboardManifestCompatibility`, `validateSuiteHistoryCompatibility`, `validateLatestSnapshotCompatibility`, `validateScenarioHistoryCompatibility` | Consumer-side guards with **no production caller**. Weave writes these index files and never reads one back, so no written artifact reveals their behaviour |
| `generateDashboardIndexes([])` | `rebuildFromRuns()` returns early on an empty run set, so this error branch is unreachable from outside |

`validatePublicReportBundleCompatibility` went with the rest: it is the one
validator with a production caller, and its whole visible effect is that an
unreadable or wrong-version run is left out of the indexes — which the
scenarios assert against the manifest itself.

The publisher's constants went too. `TARGET_REPO`, `TARGET_RUNS_PREFIX`,
`RUN_ARTIFACT_ALLOWLIST` and the three index-name patterns were each asserted
as a set or a regex; every one of them is visible in the request URLs a publish
issues, so the scenarios read them there instead. The deprecated
`INDEX_ARTIFACT_ALLOWLIST` alias had three cases and no caller outside them.

**Prove the deletion rather than asserting it.** Before deleting, break the
source and confirm the scenarios fail. For this pilot:

| Mutation | Result |
| --- | --- |
| `Bash` reclassified from `execute` to `read` | caught |
| Starting-agent detection broken | caught |
| Stale-file cleanup disabled | caught |
| Description dropped from frontmatter | caught |

All four were caught by `tests/adapters` alone, with every deleted unit test
already gone.

The evals sanitizer migration repeated the exercise against `tests/evals`
alone:

| Mutation | Result |
| --- | --- |
| `sanitizeCaseResultSummary()` returns its input | 38 of 113 scenarios red |
| Explanation validation removed from `assembleCaseEntry()` | 42 red |
| `sanitizeMdValue()` returns its input verbatim | 2 red |
| `sanitizeProvenanceRecord()` spreads its input | 1 red |

The second mutation is the one worth reading twice. On the first pass it
turned **one** scenario red, because dropping validation makes
`PublicReportBundleSchema` reject the whole report, so `public-report.json` is
never written and *"the payload appears in no public artifact"* stays true. An
absence assertion was passing for the wrong reason again. Each payload case now
also asserts the case is still published — the graceful degradation the
pipeline actually promises — and the same mutation turns 42 red.

The reporting migration ran 29 mutations against
[`tests/evals/reporting.scenario.test.ts`](../tests/evals/reporting.scenario.test.ts)
alone, with all 293 deleted unit cases already gone. Twenty-eight were caught;
the twenty-ninth is a finding rather than a gap:

| Mutation | Result |
| --- | --- |
| `sanitizeMdValue()` returns its input verbatim | 21 red |
| `isMarkdownSafe()` always says yes | 19 red |
| The `script_tag` pattern is dropped from the renderer's list | 3 red |
| Pipe escaping dropped, injection checking kept | 2 red |
| Every score band renders as `pass` | 2 red |
| The passed column always reads `yes` | 1 red |
| The dry-run banner is dropped | 1 red |
| The empty-suite placeholder is dropped | 1 red |
| The full git SHA is printed instead of the short one | 1 red |
| The manifest lists runs oldest-first | 2 red |
| Suite history is written newest-first | 4 red |
| The recent-runs index stops capping at ten | 1 red |
| Scenario history keeps the oldest ten instead of the newest | 1 red |
| A scenario the models disagree on is reported as passing | 1 red |
| An unreadable run report is indexed anyway | 1 red |
| `latest.json` points at the oldest run | 1 red |
| Model comparison stops sorting by model id | 2 red |
| The manifest points at `runs/<runId>/` rather than `runs/v1/` | 1 red |
| The run-artifact allowlist is dropped from the publisher | 11 red |
| An existing run artifact is overwritten instead of refused | 2 red |
| Index updates stop carrying the remote blob SHA | 1 red |
| The index allowlist accepts every name | 7 red |
| The token is appended to the request URL as well | 31 red |
| Remote run IDs are returned whatever their prefix | 1 red |
| A missing token no longer blocks a publish | 4 red |
| Index files are uploaded before run artifacts | 5 red |
| A failed index upload fails the whole publish | 1 red |
| A dry-run bundle is allowed through to the remote | 1 red |
| **The `raw/` filter is dropped from the publisher** | **0 red — see below** |

The eight per-suite runners went the same way, measured in source cases
because both sides lean on tables:

| | Before | After |
| --- | --- | --- |
| Unit files | 8 | 5 |
| Unit cases (source) | 464 | 47 |
| Unit cases (at runtime) | 533 | 60 |
| Scenarios added (source) | — | 56 |
| Scenarios added (at runtime) | — | 323 |

The whole of `weft-review-runner.test.ts`, `warp-security-runner.test.ts` and
`spindle-tools-runner.test.ts` is gone: every promise they made is one a run of
`weave eval run` shows. What stayed:

| Kept | Why |
| --- | --- |
| Loom's boundary-matrix block, Shuttle's structural cases, the tcr-04/tcr-10 block | They read the **repository's own fixture corpus** from disk with the production `EVALS_ROOT`. A scenario supplies its own corpus, so it cannot notice a real fixture drifting away from its `target_agent` |
| `extractDelegationChain`, `detectCompletionSignal`, `extractProducedArtifacts` | They feed the judge's prompt and nothing else. In production the judge is an LLM, so no published file reveals what was extracted |
| `scoreExecutionCompleteness`, the no-scorer routing gate | The local heuristics used when no scorer is injected. The orchestrator always injects one |
| `extractAcceptanceCriteria` | The criteria list is never published; only the derived signal is, and a miscollected criterion can still produce the right signal |
| tcr's qualitative-gate and routing-override cases | Both need a score record the real scorer cannot produce for an `agent_routing` case. They pin a contract for a future scorer |

Eighteen mutations were run against `tests/evals` alone, with every deleted
unit test already gone:

| Mutation | Result |
| --- | --- |
| Loom scores every mentioned agent, not the primary route | 10 red |
| A generic-shuttle fallback scores 1.0 instead of 0.4 | 13 red |
| `buildEvalRunner` always exits 0 | 22 red |
| Weft's prompt-provider failure falls back to a prompt | 3 red |
| Shuttle never flags an unobserved pass claim | 3 red |
| A model failure scores the case full marks | 2 red |
| The local diagnostic is no longer redacted | 2 red |
| The public explanation quotes the composed prompt | 2 red |
| The public explanation quotes the model's answer | 1 red |
| Weft calls an approval disciplined unconditionally | 1 red |
| Weft's dry run takes the live path | 1 red |
| Pattern never flags an undeclared command | 1 red |
| Warp ignores the blocker cap | 1 red |
| Spindle always reports a confidence | 1 red |
| Tapestry always marks the task complete | 1 red |
| Raw artifacts are built and written without `--raw-artifacts` | 2 red |
| *(either raw-artifact gate alone)* | **0 red** — the other gate still holds |
| *(the summary carries `rawContent`)* | **0 red** — the writer's allowlist strips it |

The last two survivors are worth stating plainly: they are not gaps in the
scenarios but **defence in depth**. Raw text reaches disk only if the runner
builds the artifact *and* the orchestrator writes it, and an unknown field on a
case summary is dropped by the bundle writer's allowlist projection. Breaking
both raw-artifact gates together does turn two scenarios red, which is what
proves the absence assertion is live rather than vacuous.

The **scorer** went last, and it is the largest single file the migration has
taken: `langchain-agent-evals.test.ts` held 153 source cases and no `it.each`,
so source and runtime counts coincide for once.

| | Before | After |
| --- | --- | --- |
| `langchain-agent-evals.test.ts` (source cases) | 153 | 53 |
| Scenarios added to `scoring.scenario.test.ts` (source) | — | 52 |
| Scenarios added to `scoring.scenario.test.ts` (at runtime) | — | 67 |
| Scenarios added to `reporting.scenario.test.ts` (source) | — | 8 |

`runEvalSuite()` already built the **real** `EvalOrchestrator` with
`scorer: new LangChainAgentEvalsScorer(judge)`, so almost the whole scorer was
observable without changing a seam. The harness gained four knobs to reach the
rest: `outcomeWeight` / `perExpectationWeight` on a fixture's rubric,
`withoutRubric` and `rubricCaseId` for the missing-rubric path, and
`judgeOutputs` / `judgeErrors` keyed by dimension so a scenario can score the
structural verdict and the prose differently, or fail one of the two questions
a case puts to the judge.

The claim worth recording is the one about the **rationale projection**.
`buildRationaleProjection()` never appears in a published file — it builds the
`response` the judge is shown for `rationaleQuality` — and the fourteen unit
cases around it read as the canonical "no user can see this". They were wrong in
exactly the way finding 11 warns about: the judge is stubbed at the scenario
seam, so `judgeCalls` carries that projection verbatim. Thirteen of the fourteen
migrated. The same applies to the rubric text and reference the scorer builds
for each dimension, which no unit test had covered at all.

(Since Spec 37 task 16.4 the projection is gone: the judge is shown the
answer itself, and `tests/evals/scoring.scenario.test.ts` and
`tests/evals/judge.scenario.test.ts` assert what it is shown, including every
request `JevJudge` makes to a stubbed decisions endpoint.)

What stayed, in
[`langchain-agent-evals.test.ts`](../packages/cli/src/evals/__tests__/langchain-agent-evals.test.ts):

| Kept | Why |
| --- | --- |
| `StubLangChainJudge`, `StubAgentEvalsScorer` | Test infrastructure that ships in `src`. FIFO order, default fallback, the `NotConfigured` call index and `.calls` are a contract for test authors, not users. `StubLangChainJudge` backs `tests/support/evals.ts`, so a regression in it would misreport every eval scenario |
| `RealLangChainJudge` | The production judge until task 16.4 (now only the acceptance harness's reference judge), which every scenario replaces by definition. Its dynamic-import failure path, per-rubric evaluator cache and the exact `{reference_outputs}` placeholder names need an injected module loader |
| `buildJudgmentExecutionDimension()` outside `task_completion` | The scorer calls it only once `scoreExecution()` has established the kind, so the guard is unreachable from a run |
| `RubricCaseMismatch` | A runner builds its `ModelRunOutput` with `evalCase.id` as the `caseId`; the scorer looks the rubric up by `run.caseId` and compares it to `evalCase.id`. Same string by construction — the branch cannot fire. The reachable half, *no rubric at all*, is a scenario |
| A non-applicable dimension's `rationale` | `buildDimensionRationales()` copies a reason only for the dimensions that counted, so "Not applicable: …" reaches no file, not even a `--raw-artifacts` one |
| An injected `scoredAt` | On the `AgentEvalsScorer` interface and passed by no runner. The `new Date()` default is a scenario |
| `RATIONALE_PROJECTION_MAX_CHARS` truncation | The projection is agent and artifact identifiers, and `allowed_agents` is checked against `KNOWN_AGENTS` at load, so no fixture reaches 2000 characters |
| The dry-run / `skip` explanation branches | Every production caller of `buildPublicExplanation()` passes `dryRun: false`; a dry run takes `buildDryRunResult()`, which builds no explanation |
| `source: "score_bucket_label"` on a case | `rationaleQuality` is applicable on every record the scorer produces, so `applicableDimensions` is never empty |
| The three-dimension cap and the `EXPLANATION_MAX_CHARS` truncations | At most two dimensions are ever applicable, and the text is a fixed template over integers and enum labels. Defence in depth |
| `tool_call` and cast-in `OutcomeKind` values | `tool_call` is rejected by the text-only fixture contract as `UnsupportedTextEvalAssertion`, so no fixture can carry it |
| `buildModelExplanation()` with zero cases | The comparison index iterates models that have results, so a row always has at least one case |

Thirty-seven mutations were run: twenty-nine against
[`tests/evals/scoring.scenario.test.ts`](../tests/evals/scoring.scenario.test.ts),
six against the aggregate-explanation scenarios in
`reporting.scenario.test.ts`, and two against the two unit cases the audit
below rewrote. Each ran with the 100 deleted unit cases already gone:

| Mutation | Result |
| --- | --- |
| Every case kind grades every dimension | 20 red |
| The explanation drops its dimension list | 6 red |
| The explanation reflects the raw outcome kind | 5 red |
| The near-perfect primary rule is removed | 5 red |
| The weighted total counts inapplicable dimensions | 4 red |
| A non-applicable dimension scores 0 instead of 1.0 | 3 red |
| The required flag stops gating a pass | 3 red |
| Routing is scored by the judge rather than read from the answer | 3 red |
| Judge scores are no longer clamped | 2 red |
| The rubric's weights are ignored | 2 red |
| A judgment case is sent to the judge after all | 2 red |
| The projection appends the raw answer | 2 red |
| The projection drops the completion flag | 2 red |
| Every case's explanation says it passed | 2 red |
| `PASS_THRESHOLD` drops to zero | 1 red |
| A judgment case always scores full marks | 1 red |
| Rubric lookup falls back to the first rubric | 1 red |
| `accepted_alternates` is ignored | 1 red |
| Any routed agent counts as accepted | 1 red |
| A declared `via` stop no longer counts | 1 red |
| The projection drops the transcript count | 1 red |
| The judge is shown the reference as the answer, and vice versa | 1 red |
| The explanation always says "required" | 1 red |
| The explanation declares the wrong source | 1 red |
| `scoredAt` is fixed at the epoch | 1 red |
| A failed rationale call no longer fails the case | 1 red |
| The raw artifact carries reasons for dimensions that did not count | 1 red |
| The routing rationale stops naming the matched agent | 1 red |
| The projection drops its `(none)` placeholders | **1 red — after a fix; see below** |
| The suite line drops its counts | 3 red |
| A model is always reported as passing | 2 red |
| The model line drops its counts | 2 red |
| Every suite is reported green | 1 red |
| A dry-run suite is reported as a real one | 1 red |
| A dry-run model is reported as a real one | 1 red |
| The `openevals` import stops being lazy | 3 red |
| A dimension's reason stops naming the kind it did not apply to | 1 red |

The `(none)` row is the vacuity lesson again, in miniature. On the first pass it
turned **0 red**: the scenario asserted `delegation_chain: (none)` and
`produced_artifacts: (none)` on a routing case, and never once asked what a
case with *no route* projects. The mutation deleted the `routed_agents` branch,
which nothing looked at. The scenario now reads both a routing answer and a task
answer, so every signal is seen present on one and absent on the other, and the
same mutation is caught.

### Seven cases that could not fail

Seven of the hundred deletions were not replaced by anything, because nothing
could have broken them. They are the shape that let `/weave:health` ship broken
(see "What the OpenCode runtime migration turned up" below): an assertion true
of the code and of its negation. They are worth naming, because they read as
coverage of the one class in this file that talks to a third party.

The `RealLangChainJudge — production adapter boundary` block had six cases:

| Case | What it asserted |
| --- | --- |
| "can be constructed with a mock BaseChatModel without any LangChain calls" | `expect(judge).toBeDefined()` on a `new` |
| "can be passed to LangChainAgentEvalsScorer as a LangChainJudge" | `expect(scorer).toBeDefined()` on another `new` |
| "satisfies the LangChainJudge interface (structural typing)" | `typeof judge.evaluate === "function"`, already proved by the `: LangChainJudge` annotation on the line above |
| "evaluate() returns a ResultAsync (thenable)" | `typeof resultAsync.then === "function"` |
| "evaluate() returns a typed ScorerAdapterError when openevals dynamic import fails" | Sets a default error on a **`StubLangChainJudge`** and asserts the stub returned it |
| "scorer with RealLangChainJudge fails with ScorerAdapterError when judge fails (no throw)" | Also a `StubLangChainJudge`; the promise is the scorer's, and it is a scenario |

The fifth is finding 11 without the subclassing: a double standing in for the
unit the test names. Its own comment justified this — *"We cannot easily
intercept the dynamic import() in Bun's test runner without module mocking
infrastructure"* — and the claim is false two hundred lines further down the
same file, where `RealLangChainJudge — per-rubric evaluator isolation` injects
a `moduleLoader` and has a case named *"moduleLoader failure returns typed
ScorerAdapterError (not a throw)"*. The real failure path was covered all
along; the stub case was covering the stub.

The seventh was `satisfies <interface> — returns ResultAsync` on each stub,
whose only non-type-echo assertion duplicated the default-fallback case beside
it.

One replacement was added, in the isolation block where the loader fixture
already lives: *"loads openevals on the first evaluate() and not before"*,
asserting the load count is 0 after construction and 1 after the first call.
An eager `import()` in the constructor turns it red. Separately, *"each
dimension has score, rationale, and applicable fields"* — three `typeof`
assertions and one length check — became *"says which kind of case a dimension
did not apply to"*, which pins the text and fails when the reason is blanked.

The lesson generalises past this file: **a kept test earns its place by being
falsifiable, not by being about something unobservable.** When a migration
decides a case cannot move to a scenario, that decision should be followed by
the question of whether the case asserts anything at all.

Three things the 153 unit cases did not say:

- **`NormalizedScoreRecord.suite` has no reader.** The scorer fills it from
  `evalCase.suite`, and every runner builds its `CaseResultSummary.suite` from
  `evalCase.suite` directly. A unit case asserted the field; nothing in the
  product consumes it.
- **The `scoredAt` parameter has no production caller.** Same shape as the
  seven uncalled sanitizer surfaces above: it is on the interface, tested, and
  never passed.
- **`RubricCaseMismatch` is unreachable by construction.** Its two-line error
  message tells a maintainer to "pass matching case and rubric fixtures to the
  scorer", which no `weave eval run` can ever print, because the two ids it
  compares are the same string.

### What the runner migration turned up

Writing against observed behaviour found four things the 464 unit cases did
not, three of them because those tests were testing themselves:

- **Seven of the eight runner test files drove a reimplementation of the
  runner.** `InMemoryLoomRunner`, `InMemoryWeftRunner` and their siblings
  extended the real class and then `override run()` with a copy that read
  in-memory fixtures. The copies diverged, and nothing noticed.
- **`--model` with no matching fixture publishes an empty green run.**
  `LoomRoutingRunner.run()` and `TapestryExecutionRunner.run()` guard an empty
  *case* list but not an empty *work item* list, so the run writes a full
  bundle with `totalCases: 0`, `suiteGreen: true`, updates the dashboard
  indexes and exits 0. A typo'd `--model` reads as success in CI. The other six
  suites return `NoCasesFound` and exit 1. Both runners' unit tests asserted
  `NoCasesFound` — against the in-memory copy, which does carry the guard.
  _Fixed for all eight suites by Spec 37 task 16.1 (#205)._
- **The category-routing qualitative gate is all but inert.**
  `mergeWithScorerDimensions()` averages `delegationCorrectness`,
  `executionCompleteness` and `rationaleQuality` and requires 0.7, but on an
  `agent_routing` case the first two are never applicable and the scorer scores
  an inapplicable dimension 1.0. Only a rationale below 0.1 can fail the gate;
  a judge verdict of 0.2 passes. The unit test that claimed the gate worked fed
  a hand-built record the real scorer cannot produce. *Fixed by Spec 37 task
  16.2: the gate and `weightedTotal` count only applicable dimensions, and the
  scenarios now assert that a 0.2 verdict fails.*
- **A documentation placeholder still earns fallback credit.** An answer
  containing `→ \`shuttle-{category}\`` is rejected by the affirmative-route
  reader — the property its unit test pinned — but the generic-fallback
  detector still reads the line, so the case scores 0.4 rather than 0.
  *Fixed by Spec 37 task 16.2: the placeholder scores 0.*
- Smaller: `ShuttleExecutionRunner`'s `NoCasesFound` message is the only one
  that does not name its suite. _Gone with 16.1: the per-runner work-item
  guards were removed, and the orchestrator's message names the suite._

### The OpenCode 2 adapter

The V2 adapter registers with a running host rather than writing files, so its
black box is **the host the plugin leaves behind**: which agents
`opencode2 debug agents` would list, what each may do, which slash command
appears, and what that command does to a session. The seam is
`setupOpenCode2(context)` — the exact callback
`@weaveio/weave-adapter-opencode2/server` publishes — driven against the host
double in [`tests/support/opencode2.ts`](../tests/support/opencode2.ts). It
shares nothing with the V1 harness beside it, because
[the two adapters are independent packages](opencode2-adapter.md).

| | Before | After |
| --- | --- | --- |
| Unit files | 32 | 20 |
| Unit cases (source) | 148 | 112 |
| Scenarios added (source) | — | 73 |
| Scenarios added (at runtime) | — | 79 |

Twelve files went whole: `v2-agent-registration`, `v2-catalog`,
`v2-commands`, `v2-delegation`, `v2-health`, `v2-model-resolution`,
`v2-options`, `v2-plugin`, `v2-rpc`, `v2-session-hooks`,
`v2-tool-policy-mapping` and `v2-translate-agent`. Every promise they made is
one a user sees in the host: a permission rule on a registered agent, an agent
that did or did not appear, the `/weave:start` command's effect on a session,
or the `status` payload the plan panel renders. What stayed:

| Kept | Why |
| --- | --- |
| `v2-config-refresh.test.ts` | Single-flight, last-valid and restore-on-reload-failure. A scenario sees a refreshed catalog and a failed one, but cannot race the controller or make the host's registry reload fail |
| `v2-config-source.test.ts` | The exact-byte source cache and its per-attempt budgets. Reaching them would mean writing megabytes of fixture |
| `v2-plan-session-state.test.ts` | A corrupt stored selection. Weave writes that record itself, so only another writer of the host's storage can produce one |
| `v2-plan-ui-state.test.ts`, `v2-plan-ui.test.ts` | The plan panel ships as a separate `./tui` plugin the server plugin never loads |
| `v2-plugin-loader-shape.test.ts` | A packaging guard on the published `./server` entry point |
| `v2-session-scope.test.ts` | The workspace half of the scope check. The plugin takes its own workspace id and the session's from the same host, so a mismatch is unreachable from outside |
| The thirteen top-level files | See the finding below |

Thirty-seven mutations were run against
[`tests/adapters/opencode2.scenario.test.ts`](../tests/adapters/opencode2.scenario.test.ts)
alone, with all 36 deleted unit cases already gone. Thirty-six were caught:

| Mutation | Result |
| --- | --- |
| An agent whose model the host cannot run is registered anyway | 30 red |
| A session from another project is treated as in scope | 5 red |
| An agent another plugin registered is overwritten | 4 red |
| A subagent may interrupt the user with a question | 2 red |
| The read policy is applied to writing and vice versa | 2 red |
| Search tools stop following the read policy | 2 red |
| Delegation is no longer denied by default | 2 red |
| The Weave ownership marker is dropped from descriptions | 2 red |
| An ambiguous bare model resolves to the first provider found | 2 red |
| A requested variant is never applied | 2 red |
| The plan command appears even when Weave does not own Tapestry | 2 red |
| A failed catalog build still reports as fresh | 2 red |
| An inventory change never rebuilds the catalog | 2 red |
| The host's unmanaged safeguards are replaced too | 1 red |
| The default agent is set even when Weave does not own it | 1 red |
| The display name is ignored | 1 red |
| An unknown variant falls back to the base model | 1 red |
| An ordered model list stops at the first entry it cannot resolve | 1 red |
| An unreadable prompt file is treated as an empty prompt | 1 red |
| A skill the host does not have is reported as available | 1 red |
| The delegation guidance is dropped from the orchestrator's prompt | 1 red |
| A refused prompt leaves the session on Tapestry | 1 red |
| The command's own message id is reused for the prompt | 1 red |
| A plan name may point outside the plans directory | 1 red |
| Skills are attached to another plugin's agent too | 1 red |
| The caller's own skill choices are replaced | 1 red |
| Temperature is applied to another plugin's agent | 1 red |
| Unknown plugin options are ignored rather than refused | 1 red |
| The project's own config is read even when it was turned off | 1 red |
| A name collision is never reported | 1 red |
| The plan command is not re-registered after the host reloads | 1 red |
| Nothing is given back when the plugin is deactivated | 1 red |
| The host is never told the plan changed | 1 red |
| A finished plan still reads as ready | 1 red |
| The project's path is echoed back to the panel | 1 red |
| Readiness claims per-request setup works with no hooks installed | 1 red |
| **Delegation targets are advertised even when delegation is denied** | **0 red — see below** |

Four of those rows only turned red after the scenario was rewritten, and they
are the vacuity lesson again. Three absence assertions — "skills are not
attached to another plugin's agent", "temperature is not applied to another
plugin's agent", "the project config is not read when it was turned off" —
passed against deliberately broken code, because the value never reached the
output at all. The first two named an agent that was in the *host* but not in
Weave's *catalog*, so the guard under test was never consulted; putting the
name in both, as a real collision does, made them live. The third declared an
agent on a model the host could not run, so it would have been dropped whether
the file was read or not.

The one survivor is not a gap. `mapOpenCode2ToolPolicy` returns early when
`delegate` is `deny`, but `buildDelegationTargets` in
[`packages/engine/src/compose.ts`](../packages/engine/src/compose.ts) already
returns `[]` for exactly that policy, so the adapter's guard cannot change an
outcome end to end. Defence in depth, and the third finding of that shape after
the publisher's `raw/` filter and `computeRunIdPrefix()`'s `"unknown"` branch.

#### What the OpenCode 2 migration turned up

- **Half the adapter is not on the path a user loads.** `package.json` exports
  `.` (the barrel), `./server`, `./rpc` and `./tui`. `./server` re-exports
  `src/v2/plugin.ts`, and the barrel exports `OpenCode2Adapter` plus its error
  union. The thirteen top-level test files cover `OpenCode2Adapter` and the
  modules it composes — a compatibility surface with no production caller in
  this repository — and four of those modules are stronger than that:
  `src/plugin.ts` (with its `Plugin.define` default), `src/run-workflow.ts` and
  `src/start-plan-execution.ts` are imported by nothing and exported from no
  entry point. **18 source cases cover code that nothing calls and nothing
  publishes.** They were kept and flagged rather than deleted, like the
  sanitizer surfaces above, because removing a published compatibility surface
  is a product decision.
- **One unreadable prompt file costs a user every agent, not one.** A
  `prompt_file` that cannot be read makes the whole catalog build fail with
  `config_unavailable`, so the host ends up with no Weave agents at all — not
  seven of eight. The `status` payload reports `refresh: "failed"` with an
  empty issue list, so nothing names the file. The per-agent
  `materialization_failed` issue exists but this path never reaches it.
- **A user whose host lacks the builtins' model gets a silently empty
  install.** Every builtin declares `claude-sonnet-4-5`; on a host with no such
  model each one is dropped with a `model_unavailable` issue, the
  `/weave:start` command disappears with them, and nothing else marks the
  install as failed. The issues are only visible through the plan panel's
  `status` RPC.
- **No test drove a subclass or a reimplementing mock.** `grep -rn "override |extends "`
  over the package's tests finds only `extends` inside conditional types. The
  eval-runner failure mode is absent here; `MockPluginContext` and the V2
  fixtures are data doubles, not second implementations.

### Migrating the OpenCode runtime surface

The OpenCode V1 **runtime** surface went the same way. Its black boxes are the
two things a user of that adapter can see: the slash commands OpenCode ends up
offering, read off `cfg.command` through the same config hook the agent
scenarios use, and the agents a running OpenCode is left holding, read off
`FakeOpenCodeInstance` — a real in-memory agent store rather than a call
recorder, so a second startup genuinely sees what the first one wrote.

| | Before | After |
| --- | --- | --- |
| `runtime-command-projection.test.ts` (source cases) | 58 | 28 |
| `reconcile-agent.test.ts` (source cases) | 42 | 2 |
| `adapter.test.ts` (source cases) | 42 | 11 |
| `plugin.test.ts` (source cases) | 36 | 6 |
| `run-workflow.test.ts` (source cases) | 27 | 11 |
| `start-plan-execution.test.ts` (source cases) | 27 | 7 |
| **Unit total (source cases)** | **232** | **65** |
| Scenarios added (source cases) | — | 51 |
| Scenarios added (cases at runtime) | — | 55 |

What stayed, and why, is recorded in each file's docblock. The pattern across
all six is the same: **argument-validation branches, absence guarantees and
adapter-supplied context stay; rendered messages and registered configuration
go.** A scenario builds its arguments from a `.weave` file, so it can never
produce an empty `workflowInstanceId`; it drives the real
`BunFilesystemPlanStateProvider` over a real plan file, so it cannot make the
provider fail on demand; and `OpenCodeModelContext` — the set of models a live
OpenCode can run — is supplied by the host, which the plugin never populates.

Twenty-eight mutations were run against
[`tests/adapters/opencode-runtime.scenario.test.ts`](../tests/adapters/opencode-runtime.scenario.test.ts)
alone, with every deleted unit case already gone. Twenty-six were caught:

| Mutation | Result |
| --- | --- |
| A reconciliation failure is swallowed by the adapter | 17 red |
| Ownership tagging is dropped from the description | 13 red |
| A dispatched step never reaches the adapter | 11 red |
| The preferred `/weave:start` command is not registered | 7 red |
| An existing Weave agent is created again rather than updated | 5 red |
| Rendered command messages stop carrying the command label | 4 red |
| A foreign same-named agent is treated as Weave's own | 4 red |
| The ownership tag is written twice into the description | 3 red |
| Plan commands are sent to Loom instead of Tapestry | 2 red |
| The command envelope stops naming the command | 2 red |
| The collision message stops naming the agent and the remedy | 2 red |
| Plan execution stops defaulting to `tapestry-execution` | 2 red |
| New sessions no longer start in Loom | 1 red |
| An unknown workflow name is reported as a lifecycle failure | 1 red |
| The step cap is ignored | 1 red |
| A missing plan is reported as a generic workflow error | 1 red |
| An unsafe plan name is reported as a missing provider | 1 red |
| The status message stops reporting the step and lease | 1 red |
| The config hook replaces the agent map rather than adding to it | 1 red |
| The config hook replaces the command map rather than adding to it | 1 red |
| A declared model variant is dropped on the way to OpenCode | 1 red |
| Agent names are matched without regard to case | 1 red |
| A health check always reports the adapter as fully ready | 1 red |
| *(a fix)* A lifecycle failure's cause is kept on the plan-execution path | 1 red |
| *(a fix)* The config hook leaves a same-named agent the user already had | 1 red |
| *(a fix)* A step dispatch carries the user's real agent, not a placeholder | 1 red |
| Both provider-qualification gates are removed at once | 1 red |
| *(either provider-qualification gate alone)* | **0 red** — the other gate still holds |
| The ownership tag is appended every pass, not once | **0 red** — see below |

Three of those are mutations that *fix* a defect the scenarios pin as observed
behaviour, which is the only way to prove such a scenario is live.

The two survivors are not gaps:

- **The provider-qualification gate is defence in depth.**
  `resolveModelForAgent()` filters unqualified model names out of its input and
  then filters the result again on the way out. Removing either alone changes
  nothing; removing both turns a scenario red. Same shape as the publisher's
  dead `raw/` filter.
- **`tagWithOwnership`'s idempotency guard is unreachable.** Both callers — the
  config hook and `reconcileAgent` — pass a freshly translated config whose
  description has never been tagged, so the guard cannot fire. Its unit test is
  kept and flagged. A mutation that writes the tag twice turns three scenarios
  red, which is what proves the assertion watching it is not vacuous.

### What the OpenCode runtime migration turned up

Six things the 232 unit cases did not say, four of them because the tests were
describing an architecture the adapter no longer has:

- **Running a workflow destroys the agents it dispatches.** The engine's
  `buildConfiguredRunAgentEffect()` emits a placeholder descriptor —
  `composedPrompt: ""`, `models: []`, an ask-everything tool policy — and the
  adapter's `projectEffect` feeds it straight into `spawnSubagent()`, which
  reconciles it over the agent OpenCode already holds. A user who runs a
  two-step workflow gets their Shuttle back with an empty prompt, no model and
  every permission downgraded to `ask`, for the rest of the session. The unit
  tests could not see it: they drove `MockOpenCodeAdapter`, which overrides
  `spawnSubagent` to record the descriptor and write nothing.
- **The collision protection is not on the live path.** `reconcile-agent.ts`
  exists to refuse overwriting a same-named agent a user created themselves.
  SDK reconciliation was deliberately disabled — a `config.update()` per agent
  made OpenCode reload every plugin — so the config hook is the only
  materialization mechanism, and it assigns `cfg.agent[name]` unconditionally.
  A user with their own `shuttle` in `opencode.json` has it silently replaced.
  The 42 `reconcile-agent` cases all passed against a module nothing reaches.
- **Four exported surfaces have no production caller.** `runWorkflow()`,
  `startPlanExecution()`, `RuntimeCommandProjection` and
  `OpenCodeAdapter.spawnSubagent()` are reached only from tests. The plugin
  registers two prompt-template commands, `start-work` and `weave:start`, both
  dispatching to Tapestry; the six `/weave:*` commands the projection layer
  labels and documents are registered with nothing. `WEAVE_START_COMMAND`,
  `WEAVE_START_LEGACY_COMMAND` and `WeavePluginOptions.clientFacade` are unread
  too. Kept and flagged rather than deleted, like the sanitizer surfaces above.
- **`startPlanExecution()` discards every lifecycle error's cause.** Its
  `mapCommandError()` reads `error.message` and `error.reason`, but a
  `command_lifecycle` error carries its text on `error.cause.message`, so every
  one collapses to `"Unknown command operation error"`. A user whose plan still
  has an unticked task is told nothing. The same failure through
  `RuntimeCommandProjection.handleStartPlan()` reads
  *`Plan ".weave/plans/auth-work.md" has incomplete checkbox(es)`* —
  `run-workflow.ts`'s mapper has the `command_lifecycle` branch that this one
  lacks.
- **`/weave:health` can never report a healthy adapter.**
  `buildOpenCodeHealthReport()` declares none of the seven optional
  capabilities, and each undeclared optional capability counts as a degraded
  operation, so `handleRuntimeHealth()` always takes the degraded branch. Two of
  its unit cases asserted `outcome === "success" || outcome === "degraded"` —
  the whole union, and therefore always true.
- **Turning off Tapestry leaves both commands pointing at an agent OpenCode does
  not have.** `disable agents ["tapestry"]` removes the agent and registers
  `start-work` and `weave:start` with `agent: "tapestry"` regardless.

### The engine's composition cluster

The DSL bucket's black box is `.weave` source in, resolved agent descriptors
or a typed error out, through `parseConfig` → `materializeAgents`. Nine engine
test files sat in front of that seam. Counted in **source cases**, because both
sides use tables:

| File | Before | After |
| --- | --- | --- |
| `compose.test.ts` | 107 | 43 |
| `template-renderer.test.ts` | 65 | 13 |
| `template-context.test.ts` | 53 | 1 |
| `skill-resolution.test.ts` | 53 | 47 |
| `tool-policy.test.ts` | 48 | 7 |
| `materialization-orchestration.test.ts` | 48 | 0 — deleted |
| `materialization.test.ts` | 45 | 0 — deleted |
| `category-shuttle-routing.test.ts` | 44 | 0 — deleted |
| `descriptors.test.ts` | 29 | 0 — deleted |
| **Unit total (source cases)** | **492** | **111** |
| Scenarios in `tests/dsl/` (source cases) | 21 | 114 |
| Scenarios in `tests/dsl/` (cases at runtime) | 21 | 151 |

The bucket gained a seam it did not have: `materializeAgents` takes the
`promptFileReader` an adapter supplies, so `promptLibrary()` in
[`tests/support/scenario.ts`](../tests/support/scenario.ts) describes the
user's `prompts/` directory in memory and `prompt_file` / `prompt_append_file`
become black-box testable. `whenMaterializedTwice()` resolves one parsed config
twice, which is what an adapter does and what makes descriptor aliasing
observable.

What stayed, and why:

| Kept | Why |
| --- | --- |
| `composeWorkflowStepPrompt` and `detectAppendCollisions` in `compose.test.ts` | Exported with **no production caller** — see below |
| The renderer's function-value ban | The context builder projects strings, arrays and booleans; no config can put a function there |
| The renderer's `allowedPaths` parameterisation and `extractTemplatePaths` | Composition always passes the one constant; `extractTemplatePaths` has no caller |
| The context builder's defensive array copy | The builder is handed arrays its caller still owns |
| The **unmapped** half of `resolveToolDecisions` | `CLAUDE_CODE_TOOL_IDS` and `COPILOT_TOOL_IDS` are derived from their own classification lists, so no tool either adapter resolves can come back unmapped |
| `skill-resolution.test.ts`, near enough whole | Almost all of it has no live caller — see below |

Around eighty mutations were run against `tests/dsl` alone, with every deleted
unit case already gone. All but five are caught; the five that survive after
the scenarios were sharpened are recorded below the table, because each says
something.

| Mutation | Result |
| --- | --- |
| Unknown template paths are accepted | 16 red |
| A template error renders the source verbatim | 3 red |
| The append is joined before the prompt | 3 red |
| `prompt_append` is dropped entirely | 4 red |
| An unreadable prompt file composes as empty text | 2 red |
| Prompt files are re-read per agent | 1 red |
| Every template error is blamed on the primary prompt | 2 red |
| Partials / delimiter changes accepted | 2 / 1 red |
| Escaped literals are not restored | 2 red |
| Sections and their children are not validated | 1 / 1 red |
| The context exposes `agent.models` | 2 red |
| Skills, `isCategory`, the category block, a policy value, a target description, the target list | 1–4 red each |
| Primary agents offered as delegation targets | 7 red |
| An agent offered itself | 3 red |
| `delegate: ask` clears the table like `deny` | 1 red |
| `delegation_exclude` ignored | 1 red |
| The shared-shuttle exclusion dropped | 2 red |
| No target marked as a category | 1 red |
| A target's triggers dropped | 3 red |
| No category shuttle generated | 26 red |
| Category models / temperature / variant ignored | 2 / 1 / 1 red |
| The base shuttle's `fast` or skills not inherited | 1 / 2 red |
| A category shuttle materialized in primary mode | 1 red |
| The category append replaces the base's | 1 red |
| A category's `prompt_append_file` ignored | 1 red |
| Category triggers dropped | 2 red |
| The category name on the descriptor is the agent name | 3 red |
| A collision with an explicit agent not reported | 2 red |
| Disabling the base shuttle stops suppressing its categories | 1 red |
| An undeclared capability defaults to `allow` | 18 red |
| A declared `read` ignored; `network` dropped | 6 / 19 red |
| The raw policy dropped from the descriptor | 3 red |
| A category's policy replaces rather than merges | 1 red |
| Generated agents listed before declared ones | 8 red |
| Every agent reported as `explicit` | 1 red |
| A review variant carries no `reviewMeta` | 1 red |
| Composition failures dropped; one failure aborts the plan | 43 / 44 red |
| A category-shuttle or review-variant conflict swallowed | 2 / 1 red |
| No review variants generated | 11 red |
| A variant keeps the full model list / is not read-only | 1 / 1 red |
| A model id keeps its slashes in the variant name | 10 red |
| `display_name`, `variant`, temperature default, skills dropped | 1 / 3 / 1 / 4 red |
| *(the disabled-agent filter in `buildDelegationTargets`)* | **0 red** — `materializeAgents` filters first |
| *(the `categoryMeta?.description ??` preference)* | **0 red** — the generated config already carries the category description |
| *(the disabled gate in `generateReviewVariants`)* | **0 red** — `materializeAgents` filters too |
| *(both gates of any of those three pairs, together)* | 1–2 red each |
| *(descriptor array copies, on a single materialization)* | **0 red** — until a scenario resolves the same config twice |
| *(the prototype-traversal guard, asserting only that composition failed)* | **0 red** — until the scenario names the refusal |

The first three are defence in depth: breaking either gate of a pair alone
cannot change an outcome, and breaking both together does turn a scenario red.
The last two were **false claims of unobservability**, and both are now
scenarios:

- **Descriptor arrays shared with the user's config are observable.** An
  adapter resolves the same config object more than once. `whenMaterializedTwice`
  does the same, and an adapter pushing to `descriptor.models` then changes
  what the second pass returns.
- **A prototype-traversal path deserves its own refusal.** Asserting only "it
  failed" stayed green with the guard removed, because the path is not in the
  allowlist either. The scenarios now assert `UnsafePath` versus `UnknownPath`
  versus `UnsupportedTag` — which refusal the user is shown.

### What the composition migration turned up

- **Descriptions and triggers reach the model HTML-escaped.** `{{...}}` is
  Mustache's escaping form, and the shipped `loom.md` uses it for
  `{{description}}` and for `{{.}}` inside `{{#triggers}}`. Weave's own builtin
  trigger *"Use when answering 'where is X' or 'how does Y work' questions"*
  renders in Loom's composed prompt today as `&#39;where is X&#39;`. The same
  applies to `&`, `<` and `>` in any description. `loom.md` already writes
  `{{{model}}}` for review-routing model ids, which is the same bite found
  once before. Pinned as observed in
  [`tests/dsl/prompt-templates.scenario.test.ts`](../tests/dsl/prompt-templates.scenario.test.ts);
  not fixed here.
- **A category's `prompt_append_file` is silently dropped when the base shuttle
  declares an inline `prompt_append`.** The two fields are mutually exclusive
  in one block, but inheritance produces a config holding both, and
  `loadAppendSourceFromInput()` prefers the inline one. The user's file is
  never read and `plan.errors` stays empty. Pinned in
  [`tests/dsl/category-routing.scenario.test.ts`](../tests/dsl/category-routing.scenario.test.ts).
- **`\{{` needs a different number of backslashes per string form.** The lexer
  unescapes a double-quoted string and leaves a triple-quoted one alone, so a
  literal tag needs `\\{{` in the first and `\{{` in the second. Writing the
  wrong one interpolates the value with no error. Both forms are pinned, and
  `routing { delegation_exclude [...] }` is missing from the agent-field table
  in [`docs/dsl-reference.md`](dsl-reference.md) although Spec 18 documents it.
- **`skills [...]` reaches only one adapter.** The sole production consumer of
  engine skill resolution is `resolveAvailableSkillsForAgent()`, called from
  `packages/adapters/opencode2/src/v2/catalog.ts`.
  `resolveSkillsForAgent()`, `resolveSkillsForConfig()` and
  `resolveAvailableSkillsForConfig()` have no caller at all, and
  `HarnessAdapter.loadAvailableSkills()` is implemented by four adapters and
  invoked by none — nothing in the Claude Code or Copilot bundles carries a
  skill. `disable skills [...]` therefore has no effect outside OpenCode 2.
  Kept and flagged rather than deleted, like the sanitizer surfaces above.
- **`composeWorkflowStepPrompt()` and `detectAppendCollisions()` have no
  production caller.** Workflow execution renders its step prompt through
  `renderTemplate()` in `execution-lifecycle/prompt-context.ts`, so the Spec 22
  append-precedence rules — step-local wins, workflow-scope fallback, the
  reported `appendScope` — are not exercised by any run. Together they are all
  43 remaining cases in `compose.test.ts`.
- **A test file can describe a lifecycle no product code performs.**
  `materialization-orchestration.test.ts` defined `orchestrate()` — `init()` →
  `loadAvailableSkills()` → `materializeAgents()` → `spawnSubagent()` — and
  then asserted that order. The real sequence lives in
  `packages/cli/src/commands/compose.ts`, which never calls
  `loadAvailableSkills()`. Measured: with `materializeAgents()` mutated to
  resolve nothing at all, **22 of its 48 cases stayed green**, including "calls
  init exactly once before spawning any agent". The same mutation turns 262
  cases red in `tests/`. This is finding 11 without the subclassing: the file
  drove a second implementation of the thing it named.
- **Four of its cases were vacuous in the documented way.** The "sanitized
  descriptor coverage" block puts API keys and adapter file paths in skill
  *metadata* and asserts no spawned descriptor contains them — but
  `AgentDescriptor.skills` is a list of names, so the metadata had no path to
  the output and nothing needed stripping.

**What is left in this cluster.** The migration itself is finished: every
remaining unit case is one of the kept categories above. What is outstanding is
product work, not test work — the two defects pinned as observed (HTML escaping
of descriptions and triggers, the dropped category `prompt_append_file`), and
the decision of what to do about `composeWorkflowStepPrompt()`,
`detectAppendCollisions()`, the config-wide skill resolvers and
`loadAvailableSkills()`, which together account for 90 of the 111 remaining
cases and have no caller between them.

### A scenario can pass without testing anything

The evals bucket produced the sharpest lesson so far, and every migration
should apply it.

The first leak scenarios placed sensitive markers in a case result's
`rawArtifact` field and asserted no published file contained them. Twelve
passed. They were **vacuous**: bundle assembly only ever reads
`caseResult.summary`, so `rawArtifact` had no path to the output — nothing
needed stripping, and a deliberately broken sanitizer still passed all twelve.

Moving the markers onto the summary — the object assembly actually reads — made
the same scenarios fail six ways against that broken sanitizer.

**A green scenario proves nothing until you have watched it go red.** Mutate the
code under test before trusting a new scenario, especially one asserting that
something is *absent*: an absence assertion passes both when the guard works and
when the value never arrived.

### What migration turns up

Writing against observed behaviour keeps surfacing things the white-box tests
obscured. In this pilot, `agent-translation.test.ts` asserted *"passes through
unknown model strings verbatim"* — true of the translator in isolation, and
misleading about the product. End to end, an agent's `models` list is filtered
against what the adapter knows the harness can run, so an unrecognised model is
dropped silently and resolution falls through to `DEFAULT_FALLBACK_MODEL`. A
typo in `models` yields a working agent on the wrong model rather than an error.
The scenario now records that.

The evals migration turned up three more:

- **A case with an empty `caseId` costs the run its dashboard presence,
  silently.** `PublicReportBundle` assembly fails validation, and
  `writeBundle()` treats that failure as non-fatal: `public-report.json`,
  `public-report.md` and every dashboard index are skipped, and the result is
  still `ok`. Nothing in the write result says the run will never appear.
- **Seven exported sanitizer surfaces have no production caller.**
  `sanitizeScoreRecord()`, `dropUnknownFields()`, `truncateExplanation()`,
  `buildExplanation()`, `assertExplanationSafe()`, `REDACTED` and
  `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS` are reached only from tests — the
  runners build explanations through `buildPublicExplanation()` in
  `langchain-agent-evals.ts` and redact with their own patterns. Roughly 60
  unit cases cover code nothing calls. They were kept and flagged rather than
  deleted, because the decision is a product one.
- **A malformed summary throws instead of returning `err`.** A `CaseResult`
  whose `summary` omits `dimensionScores` makes `writeBundle()` raise a
  `TypeError` rather than a typed `BundleError`, against the `neverthrow` rule
  in `AGENTS.md`. Reachable only by defeating the type system, so no scenario
  asserts it.

The reporting migration turned up three more:

- **`public-report.md` renders the run's suite list unescaped.**
  `renderPublicReportBundle()` interpolates `bundle.runSummary.suites` without
  `sanitizeMdValue()`, so a suite name containing `<script>` reaches the
  document verbatim while the `### Suite:` heading for the same value is
  blanked. [`docs/eval-xss-policy.md`](eval-xss-policy.md) allows no such
  channel. The unit tests missed it in exactly the way the vacuity lesson above
  describes: all eight malicious-suite cases set `suiteSummaries[].suite` and
  left `runSummary.suites` clean, so the unescaped line was never once
  exercised. Suite names come from the repo-owned `EVAL_SUITE_REGISTRY` rather
  than model output, which bounds the exposure; the behaviour is pinned as
  observed and the policy doc now carries the gap.
- **The publisher's `raw/` filter is dead weight.** `publishFiles()` strips
  `raw/`-prefixed names and *then* applies `RUN_ARTIFACT_ALLOWLIST`, which
  rejects every one of them anyway. Deleting the first filter turns no
  scenario red because it cannot change an outcome. Harmless, but it reads as
  load-bearing — the second finding of that shape, after
  `computeRunIdPrefix()`'s `"unknown"` branch.
- **Nothing on the publish path reads a dashboard index back.** Four exported
  `validate*Compatibility` functions exist for a consumer that does not exist
  here; the website is the intended caller. Kept and flagged, like the
  sanitizer surfaces above.

## What the buckets found

Writing scenarios against real behaviour surfaced documentation that described
Weave as it no longer works. Each was corrected in the same pass, with a
scenario pinning the actual behaviour so it cannot drift again:

- **`{{{delegation.section}}}` does not exist.** `AGENTS.md`, `CONTEXT.md`,
  `docs/dsl-reference.md`, `docs/cli.md` and `docs/prompt-composition.md` all
  documented a pre-rendered delegation block and an automatic fallback append.
  [ADR 0001](adr/0001-prompt-composition-templates.md) removed both
  deliberately, and `template-context.test.ts` asserts they are absent from
  `ALLOWED_TEMPLATE_PATHS` — a prompt using the placeholder fails composition.
  Worst of it was `packages/cli/src/prompts/self-modify.md`, shipped guidance
  that `weave prompt self-modify` prints, telling users to do exactly that.
- **Object triggers are invalid.** `AGENTS.md` still showed
  `triggers [{ domain "…" trigger "…" }]`; the schema takes quoted strings,
  and `docs/dsl-reference.md` says object triggers are invalid outright.
- **`{{domains}}` is not in the template context.**

The pattern is the same one that produced the `patterns` → `triggers` drift
fixed earlier: `docs/dsl-reference.md` and the specs were amended when the
engine changed, and the onboarding documents were not. A scenario that exercises
the documented behaviour is the cheapest guard against it.

## See also

- [`tests/README.md`](../tests/README.md) — the bucket contract and how to write a scenario
- [Adapter Boundary](adapter-boundary.md) — what engine tests may and may not assume
- [DSL Reference](dsl-reference.md) — normative `.weave` syntax used by DSL scenarios
- [CLI](cli.md) — the commands the CLI bucket drives
