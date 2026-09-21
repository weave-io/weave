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
| 9 | Populate the buckets | 10 | DSL: `tool_policy`, prompt composition. CLI: every command. Adapters: Copilot alongside Claude Code, on a shared harness. Still open: workflows, config merge, and the OpenCode adapters, which register with a running harness rather than writing files and need a harness of their own | **partly done** |
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
- **The category-routing qualitative gate is all but inert.**
  `mergeWithScorerDimensions()` averages `delegationCorrectness`,
  `executionCompleteness` and `rationaleQuality` and requires 0.7, but on an
  `agent_routing` case the first two are never applicable and the scorer scores
  an inapplicable dimension 1.0. Only a rationale below 0.1 can fail the gate;
  a judge verdict of 0.2 passes. The unit test that claimed the gate worked fed
  a hand-built record the real scorer cannot produce.
- **A documentation placeholder still earns fallback credit.** An answer
  containing `→ \`shuttle-{category}\`` is rejected by the affirmative-route
  reader — the property its unit test pinned — but the generic-fallback
  detector still reads the line, so the case scores 0.4 rather than 0.
- Smaller: `ShuttleExecutionRunner`'s `NoCasesFound` message is the only one
  that does not name its suite.

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
