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
| 161 | `artifact-bundle.test.ts` | bundle writing; largely observable |
| 153 | `langchain-agent-evals.test.ts` | judge adapter; mixed |
| 140 | `sanitizer.test.ts` | **migrated** — 140 → 91 (task group 14) |
| 114 | `report-markdown.test.ts` | rendering; observable |

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

## Still open elsewhere

- **OpenCode and opencode2 have no scenario coverage.** They register with a
  running harness rather than writing files, so the flush-based harness in
  [`tests/support/adapter.ts`](../../tests/support/adapter.ts) does not fit —
  they need one of their own.
- **Copilot** has scenarios but its unit tests have not been migrated.
- The lifecycle reorganisation (step 2) is open and was recommended **skipped**;
  see the correction in finding 4 of the strategy doc.
