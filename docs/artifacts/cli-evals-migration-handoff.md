# Handoff — migrating `cli/evals` to scenarios

Non-normative working note for the session that picks this up. The durable
contract is [`docs/testing-strategy.md`](../testing-strategy.md) and
[`tests/README.md`](../../tests/README.md); read those first.

## Where things stand

Merged: #185, #186, #187, #189, #190, #191, #192, #193, #194, #195.
Tracking issue: **#183**, task groups 8–15.

The taxonomy exists and one area has been migrated properly. The rest has not.

| | Files | Cases |
| --- | --- | --- |
| Scenario (`tests/`) | 7 | 65 |
| Unit (`packages/**`) | ~178 | ~5,500 |
| Repo guards (`scripts/`) | 6 | 31 |

`cli/evals` is **2,584 cases across 56 files** — roughly 46% of the whole
suite, and the next target.

## The method, as established by the claude-code pilot (#195)

That pilot took 68 unit cases to 16, adding 18 scenarios: **75 → 41 total, a
45% reduction**, with no coverage lost.

1. **Catalogue the promises.** List every `it(...)` in the area and ask of each:
   *can a user observe this from outside?* For evals the outside is the CLI
   (`weave eval run`) and the published report bundle.
2. **Write scenarios for the observable ones**, against *observed* behaviour —
   run it and look, never transcribe what a unit test or a doc claims. Both
   times that rule was applied it turned up a defect (see below).
3. **Delete by subsumption, not similarity.** A unit test goes when a scenario
   asserts the same user-visible promise, *even where the unit test also covers
   internal branches*.
4. **Prove the deletion by mutation.** Break the source, confirm the scenario
   suite alone still fails. `/tmp` scratch script from the pilot is worth
   recreating: four mutations, all caught.
5. **Keep what is genuinely internal**, and say why in the file's docblock.

## What `cli/evals` looks like

Largest files, by case count:

| Cases | File | First read |
| --- | --- | --- |
| 188 | `report-schema.test.ts` | **migrated** — 188 → 112 (task group 14) |
| 169 | `loom-routing-runner.test.ts` | runner behaviour; mixed |
| 161 | `artifact-bundle.test.ts` | **migrated** — 337 cases across four bundle-writing files became 60 (task group 14) |
| 153 | `langchain-agent-evals.test.ts` | judge adapter; mixed |
| 140 | `sanitizer.test.ts` | **migrated** — 140 → 91 (task group 14) |
| 114 | `report-markdown.test.ts` | **migrated** — deleted outright, with `dashboard-indexes.test.ts` (104 → 19) and `github-contents-publisher.test.ts` (75 → 0), into 59 scenarios in [`tests/evals/reporting.scenario.test.ts`](../../tests/evals/reporting.scenario.test.ts) (task group 14) |

The observable promises are far fewer than the case count suggests, and they
are worth stating plainly before writing anything:

- A published report **never leaks a raw prompt, transcript or rationale**.
  That is `sanitizer`'s 140 cases as roughly one scenario plus a table of
  hostile inputs.
- A bundle is **reproducible**: same inputs, byte-identical output.
- A bundle is **immutable**: a second write never overwrites the first.
- A dry run **validates fixtures without an API key** and reaches no network.
- A report **renders without XSS** — see [`docs/eval-xss-policy.md`](../eval-xss-policy.md),
  which is normative and must not be weakened by this work.
- `schemaVersion` **is present and correct**, because the website consumes it.

## Cautions specific to this area

- **The suite is the product here**, more than elsewhere: eval infrastructure
  writes published artifacts that `weave-website` reads. Deleting a test that
  pins a published contract is not the same as deleting one that pins an
  internal helper. When in doubt, keep and note it.
- `docs/eval-xss-policy.md` and `docs/eval-sanitization-and-publish-pipeline.md`
  are normative. Read both before touching `sanitizer` or `report-markdown`.
- Several tests here read real fixtures under `evals/`. That is legitimate —
  those fixtures are repo-owned — but they are **not** hermetic against the
  developer's `~/.weave`; that hazard was fixed in #185/#186 and must not
  regress.
- #194 made `allowed_models` optional in a case fixture. Fixtures now omit it
  and the loader fills it from the matrix; a list restating the defaults is
  rejected. Tests written against the old shape will mislead.

## Findings this work has already produced

All came from writing scenarios against observed behaviour, and they are the
argument for doing the rest:

- **`{{{delegation.section}}}` does not exist** and has not since ADR 0001, yet
  `weave prompt self-modify` was telling users to use it (#192).
- **An unrecognised model is silently replaced.** `models ["typo/model"]` yields
  a working agent on `sonnet`, because the list is filtered against what the
  adapter knows the harness can run (#195). Intended, but undocumented and
  worth a product decision.
- **An empty `caseId` makes a whole run vanish from the dashboard, silently.**
  Public-report assembly fails validation and `writeBundle()` treats that as
  non-fatal, so no `public-report.json`, no Markdown, no indexes — and an `ok`
  result (task group 14).
- **Seven exported sanitizer surfaces have no production caller** and are
  reached only from tests (task group 14). See the strategy doc.

## Notes for whoever takes the next file

- **Score files are local, public artifacts are uploaded.** Only
  `bundle-index.json`, `public-report.json` and `public-report.md` are in
  `RUN_ARTIFACT_ALLOWLIST`. `score-<suite>.json` *does* carry explanation text
  that the public report drops, so "no published file contains X" must say
  which files it means.
- **Absence assertions need a positive twin.** Dropping the whole report also
  satisfies "the payload appears nowhere". Assert the case is still published
  alongside it, or the scenario passes for the wrong reason.
- **Index files are not reproducible.** They stamp `new Date()` into
  `updatedAt`; only the run artifacts are byte-identical across runs.
- [`tests/support/evals.ts`](../../tests/support/evals.ts) is the shared harness;
  [`tests/evals/publish-safety.scenario.test.ts`](../../tests/evals/publish-safety.scenario.test.ts)
  is the worked example for a hostile-input table.

## Findings from the bundle-writing migration (task group 14)

`artifact-bundle`, `raw-artifacts`, `report-bundle` and `provenance` went from
**337 unit cases to 60**, with 68 scenarios in
[`tests/evals/bundle-writing.scenario.test.ts`](../../tests/evals/bundle-writing.scenario.test.ts).
Eighteen mutations were run against those scenarios alone; seventeen were
caught. Writing them against observed behaviour turned up four things:

- **A hostile explanation is dropped from `public-report.json` but kept
  verbatim in `score-<suite>.json`.** `BoundedExplanationSchema` guards the
  public report, and [`docs/eval-xss-policy.md`](../eval-xss-policy.md) is
  scoped to that file — but every path in `filesWritten`, score files included,
  is handed to `ResultsRepoPublisher`, so the string still reaches the results
  repository. `publicFiles` keeps a website loader away from it; nothing keeps
  it out of the repo. Two `it.each` tables in the scenario file record both
  halves, so the behaviour cannot drift unnoticed. Whether the score file
  should carry an unvalidated explanation at all is a product decision.
- **`artifact-bundle.test.ts` contained a test that asserted the opposite of
  its name.** `"adversarial: publicExplanation with forbidden pattern text is
  written to JSON (caught upstream)"` built a *clean* explanation and asserted
  it survived — the adversarial case it claimed to cover was never exercised.
  It is gone; the scenarios cover the real one.
- **`computeBundleDirName()` is dead.** It is marked `@deprecated` and
  "retained for test compatibility", and its only caller was the test that
  tested it. Those seven cases are gone, so the export now has no caller at
  all and can be removed.
- **The `"unknown"` branch in `computeRunIdPrefix()` is a no-op.**
  `"unknown".slice(0, 7) === "unknown"`, so the ternary that special-cases it
  changes nothing. Harmless, but it reads as load-bearing.
- **`writeBundle()` throws instead of returning `err`.** A `CaseResultSummary`
  missing `dimensionScores` produces a raw
  `TypeError: undefined is not an object` out of the sanitizer, escaping the
  `ResultAsync` entirely — against the neverthrow rule in `AGENTS.md`.
  Reproduced directly against `ArtifactBundleWriter`; reported separately by
  the sanitizer migration.
- **A failed public-report assembly is silent.** `writeBundle()` treats an
  `assemblePublicReportBundle` error as non-fatal: `public-report.json`,
  `public-report.md` and everything derived from them are skipped while the
  call still returns `ok`. That is the vacuity trap in file form, so the
  scenarios pin the run directory's exact file list and the exact
  `publicFiles` array rather than asserting "contains". Forcing that branch
  fails 29 of them.
- **`assertBundlePublishEligible()` has no production caller.** It is the
  policy that says a dry-run bundle must never be published externally, and
  nothing on the `weave eval` path invokes it — the dry-run guarantee is
  instead enforced by `effectiveMode` inside `writeBundle()`. Its three unit
  cases were kept because no scenario can reach it.

## Findings from the reporting migration (task group 14)

`report-markdown`, `dashboard-indexes` and `github-contents-publisher` went
from **293 unit cases to 19**, with 59 scenarios (113 at runtime) in
[`tests/evals/reporting.scenario.test.ts`](../../tests/evals/reporting.scenario.test.ts).
Twenty-nine mutations were run against that file alone; twenty-eight were
caught. What it turned up:

- **`public-report.md` renders the run's suite list unescaped.** The
  `**Suites**:` header line interpolates `runSummary.suites` straight into the
  document, while the `### Suite:` heading for the same value goes through
  `sanitizeMdValue()`. A suite named `<script>alert(1)</script>` reaches the
  file verbatim. Every malicious-suite unit case set `suiteSummaries[].suite`
  and left `runSummary.suites` at its clean default, so the line was never
  exercised — the vacuity trap again, this time hiding a real hole in layer 2
  of [`docs/eval-xss-policy.md`](../eval-xss-policy.md). Pinned as observed;
  the policy doc now carries a *Known gap* section. Suite names come from
  `EVAL_SUITE_REGISTRY`, not from a model, so this is not currently reachable
  by an attacker.
- **Issue #201, at the seam.** A `ResultsRepoPublisher` is handed
  `["run-summary.json", "score-loom-routing.json", "prompt-hashes.json",
  "provenance-manifest.json", "public-report.json", "public-report.md",
  "bundle-index.json"]` — every path in `filesWritten` — while the run's own
  `bundle-index.json` declares only the last three public. What keeps the score
  file off the remote is `GitHubContentsPublisher`'s own
  `RUN_ARTIFACT_ALLOWLIST`, applied inside `publishFiles()`, not anything the
  caller does. A different publisher implementation would upload all seven.
  Both halves are pinned: what the publisher receives, and what actually gets a
  PUT.
- **The publisher's `raw/` filter cannot change an outcome.** `publishFiles()`
  strips `raw/`-prefixed names and then applies the allowlist, which rejects
  them regardless. Removing the first filter turns no scenario red.
- **Four index validators have no production caller.**
  `validateDashboardManifestCompatibility`, `validateSuiteHistoryCompatibility`,
  `validateLatestSnapshotCompatibility` and
  `validateScenarioHistoryCompatibility` are the consumer side of a contract
  Weave only ever writes. Kept and flagged; the website is the intended caller.
- **`INDEX_ARTIFACT_ALLOWLIST` is a deprecated alias with no caller.** Its
  three cases were the only thing importing it.
- **A publish that hits an existing run artifact stops dead.** The first
  conflicting file aborts the whole publish with `PublishFailed` — no PUT for
  it, and none for the run artifacts or indexes behind it. Correct for
  immutability, but it means a partial re-publish leaves the indexes stale.

Two traps worth carrying forward for whoever migrates the next file:

- **Injecting `fetch` is not enough.** `GitHubContentsPublisher` reads the
  local file before it PUTs, so a scenario naming a file the run never wrote
  observes a failed read rather than the allowlist. Inject the `fileReader`
  too when the file name is the thing under test.
- **`dryRun` on `WriteBundleOptions` is not `dryRun` on a case summary.** The
  first controls the report banner and forces local-only mode; the score bands
  read `skip` only when the *case* carries it.

## Still open elsewhere

- **OpenCode and opencode2 have no scenario coverage.** They register with a
  running harness rather than writing files, so the flush-based harness in
  [`tests/support/adapter.ts`](../../tests/support/adapter.ts) does not fit —
  they need one of their own.
- **Copilot** has scenarios but its unit tests have not been migrated.
- The lifecycle reorganisation (step 2) is open and was recommended **skipped**;
  see the correction in finding 4 of the strategy doc.
