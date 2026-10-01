# Eval readiness for model recommendations (1 Oct 2026)

> Non-normative artifact. It measures the agent evals on `main` against the
> [publication bar](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md#publication-bar)
> in Spec 39 and lists the gaps to close before a recommended list can ship
> with confidence. Its blocking gaps are work item 0 of Spec 39; the
> [tasks file](../specs/39-spec-model-recommendations/39-tasks-model-recommendations.md#0-eval-readiness--pr)
> tracks them.

**In one paragraph.** The eval runs themselves are reliable and cheap, and the judge has been validated. But no builtin agent clears the publication bar today. Three things block every agent at once. Weft and Shuttle are scored on this repository's own prompt overrides, not the prompts users get. `eval compare` refuses to compare two models by design. The trajectory cases cannot run on today's default models. On top of that, six of the eight suites have 2–4 cases, so they cannot detect a regression smaller than 30–50 points even at five repeats. Thread has no suite at all. Closing the eight blocking gaps below would let Spec 39 publish lists for the agents with grown suites. Widening to orchestrator upgrades and Thread needs the later gaps.

## What already works

- **Reliable runs.** The [24 Sep baseline](eval-baseline-2026-09-24.md) ran about 660 attempts with no errored attempt and no infrastructure failure.
- **Cheap runs.** The full default matrix costs about $7 for the text track. The head-to-heads behind the current defaults cost $0.43–$6.80 ([25 Sep](eval-default-models-2026-09-25.md), [29 Sep](eval-copilot-default-models-2026-09-29.md)).
- **A validated, pinned judge.** Jev agreed with hand labels on 28 of 30 attempts and caught 10 of 12 failures ([judge bake-off](judge-bakeoff-2026-09-23.md)). It is pinned to `typesafe/jev-1.13-20260917`.
- **Statistics are in place.** `eval compare` already does Wilson intervals, Fisher's exact test and Holm adjustment (`packages/cli/src/evals/binomial-stats.ts`).
- **Known defects are fixed.** Suspected defects 1–3 from the baseline were scoring or case defects and were fixed in #247. Only defect 4 (`loom-route-weft-boundary-downstream-review` on GPT 6 Luna) is still open, and it affects a dev model, not a default.
- **The evals have already stopped a bad change.** GPT 6 Sol for Spindle scored 11/16 against Luna's 15/16 ([29 Sep](eval-copilot-default-models-2026-09-29.md)), and Luna stayed.

## Agent by agent

"Smallest detectable drop" is how far a candidate's pass rate must fall below a current model passing 95% of attempts before Fisher's exact test gives p < 0.05. It is computed with `fisherExactTwoSided` from `binomial-stats.ts` at the suite's text-case count. It treats repeats as independent. They are not: a model tends to pass or fail the same case again. So the real figure is worse, which is why cases matter more than repeats.

| Agent | Suite | Text cases | Smallest detectable drop, 3 / 5 repeats | Prompt scored is the shipped one | Can show a gain | Trajectory cases on current defaults | Meets the bar |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| Loom | loom-routing | 15 | 16 / 12 pts | Yes | No: 98% on both models | No (3 cases, old models only) | No |
| Tapestry | tapestry-category-routing, tapestry-execution | 10 + 4 | 23 / 16 pts; 50 / 30 pts | Yes | No: 90–100% | No (2 cases, old models only) | No |
| Pattern | pattern-planning | 4 | 50 / 30 pts | Yes | Not shown: 83% on both | None | No |
| Shuttle (and category shuttles) | shuttle-execution | 3 | 56 / 40 pts | **No**: repo override | Yes (33% → 89% on 25 Sep) | No (1 case, old models only) | No |
| Weft | weft-review | 4 | 50 / 30 pts | **No**: repo override | Yes | None | No |
| Warp | warp-security | 4 | 50 / 30 pts | Yes | No at the top: 20/20 on both | None | No |
| Spindle | spindle-tools | 2 | 83 / 50 pts | Yes | — | None | No |
| Thread | none | 0 | — | — | — | None | No |

Growing a suite to 12 cases at 5 repeats brings the smallest detectable drop to 13 points. At 15 cases it is 12 points, and at 20 cases 10 points.

## Gaps that block the first published list

Together they block any list that changes a model. G1 matters for Shuttle and Weft, the only agents whose scored prompt differs from the shipped one. G3 matters for each agent whose suite is below 12 cases: every agent except Loom and Tapestry's category routing. The others (G2, G4–G8) apply to every agent.

### G1. Score the prompts users get

Every text runner except Tapestry category routing composes prompts with `loadConfig(cwd)` (`packages/cli/src/evals/prompt-snapshots.ts`). That reads this repository's `.weave/` and the maintainer's global config. The repo overrides Shuttle and Weft with `.weave/prompts/shuttle.md` (102 lines against 79 shipped) and `weft.md` (93 against 72). Their prompt hashes confirm the difference:

| Agent | Hash with the repo's `.weave/` | Hash with builtins only |
| --- | --- | --- |
| Shuttle | `71eb4551938e` | `2c0cb8fad592` |
| Weft | `af792bff0aea` | `173c032be0cb` |
| Loom, Tapestry, Pattern, Warp, Spindle | same | same |

The maintainer's global config did not change any hash, but a run still depends on whose machine it is on.

**Fix:** a builtins-only config mode for `eval run`, the default for any run cited as evidence. Read no project or global `.weave`, like [`tapestry-category-config.ts`](../../packages/cli/src/evals/tapestry-category-config.ts) already does. Record the mode in the bundle. **Size:** small. Re-score the Shuttle and Weft picks afterwards, because the 25 and 29 Sep records measured the override prompts.

### G2. Compare two models, not just two prompts

`eval compare` refuses runs with different model sets (`ModelSetMismatch` in [`compare.ts`](../../packages/cli/src/evals/compare.ts)): it was built to compare prompt changes. The model comparisons on 25 and 29 Sep were read by eye from side-by-side units.

**Fix:** a model comparison over one bundle (same commit, prompts and judge), candidate against current, per suite. It reports:
- Fisher's exact test with Holm adjustment;
- a **per-case guard**: no case that the current model passes on at least 4 of 5 attempts may drop below 3 of 5 on the candidate;
- the cost difference (see G6).

The per-case guard catches what the suite-level test misses. Spindle's Sol-against-Luna gap (11/16 against 15/16) gives p ≈ 0.17 at suite level, but one case went from 8/8 to 4/8. **Size:** medium.

### G3. Grow the thin suites to at least 12 text cases

This is Spec 37 task 19.2, deferred on 23 Sep. Targets for the agents a first list could change:

| Suite | Now | Target | New cases |
| --- | ---: | ---: | ---: |
| shuttle-execution | 3 | 12 | 9 |
| spindle-tools | 2 | 12 | 10 |
| weft-review | 4 | 12 | 8 |
| warp-security | 4 | 12 | 8 |
| pattern-planning | 4 | 12 | 8 |
| tapestry-execution | 4 | 12 | 8 |

That is 51 cases with rubrics. New cases should cover the failure modes the [session audit](session-audit-2026-09.md) found, not just add volume. A suite can be grown on its own, which unblocks that agent. **Size:** large, most of the work.

### G4. Let the trajectory cases run on today's models

Five trajectory cases allow only `anthropic/claude-sonnet-4.5`, `anthropic/claude-opus-5` and `openai/gpt-5.5`; the sixth allows only `openai/gpt-4o-mini`. None of the current defaults is allowed: Opus 5.5, Sonnet 5.5, Haiku 4.5, GPT 6 Sol and Luna. A candidate cannot be checked on real sessions.

**Fix:** add the current defaults and the candidates under test to each case's `allowed_models`, in `evals/cases/*/*-trajectory.json`. **Size:** small, but each trajectory attempt costs more (15 attempts cost $3.41 on 24 Sep).

### G5. Check that each harness section resolves as intended

A recommended list is only right if it lands on the intended model for each provider. This is deterministic, so it needs no model calls.

**Fix:** a `weave models check` mode that resolves every agent list in every harness section against catalog fixtures:
- GitHub Copilot (dotted Claude IDs);
- Anthropic (dashed);
- OpenAI;
- OpenRouter;
- a catalog where both Copilot and OpenAI are connected, for ambiguity.

It prints the chosen model per agent and provider, and fails on a list that resolves to nothing for a provider it is meant to cover. Run it in the website's deploy workflow. The [spike](model-recommendations-spike.md) and the OpenCode 2 resolution rules ([Model Resolution](../model-resolution.md#opencode-2-live-catalog-rules)) define the expected behaviour. **Size:** small to medium.

### G6. Record cost per attempt

The OpenRouter client receives token usage (`ModelUsage` in [`openrouter-client.ts`](../../packages/cli/src/evals/openrouter-client.ts)), but nothing stores it. Costs today come from reading the credit balance before and after a whole unit, judge included.

**Fix:** store prompt and completion tokens per attempt in the score file. Report cost per attempt per model, at the matrix's listed prices, in the model comparison (G2). A recommendation changes users' bills, and on GitHub Copilot their premium-request quota, so the evidence must state it. **Size:** small.

### G7. Publish the runs

Every run behind the current defaults is local only. The bar requires the file's `evidence` link to point at a published run.

**Fix:** dispatch the CI eval workflow for the candidate run so it lands on tryweave.io/evals. This needs a credit top-up, which Spec 38 group 10.2 already plans. **Size:** small.

### G8. A Claude Code tier table

Claude Code sections name `opus`, `sonnet` or `haiku`, and Claude Code maps each to its current model. The evals score model IDs.

**Fix:** the evidence for a Claude Code section states which model each tier was measured as (for example `opus` = `anthropic/claude-opus-5.5` on 1 Oct 2026), and the deploy check fails when a tier's measured model is not in the eval matrix. **Size:** small.

## Gaps that widen what can be published

These come after the first list. Until they close, the agents they cover keep their builtin lists and change only through releases.

| Gap | What it unlocks | Fix | Size |
| --- | --- | --- | --- |
| **G9. Saturated suites** | Upgrades for Loom, Tapestry and Pattern, and for Warp at the top | Harder cases that strong models do not all pass: longer multi-step routing, ambiguous scopes, plans with conflicting constraints. Today these suites can only show a regression, so Opus 5.5 for the orchestrators was "a judgment call, not a measured win" ([25 Sep](eval-default-models-2026-09-25.md)). | Medium–large |
| **G10. A Thread suite** | Any change to Thread, whose Haiku 4.5 default is unmeasured | A `thread-exploration` suite scoring Thread's own exploration reports: files found, facts against fixture, no invented paths. `loom-routing` only checks that Loom sends work to Thread. | Medium |
| **G11. OpenCode 2 trajectory runner** | Evidence on the harness most users run | The trajectory track runs OpenCode V1 in the Podman sandbox. The [OpenCode 2 live check](../../scripts/proof/opencode2-live/main.ts) already drives a real 2.0.16 host and could take real models. | Large |
| **G12. Provider path smoke run** | Confidence that a provider serves the measured model the same way | Evals call OpenRouter. Copilot and Anthropic serve the same models with their own limits and spellings. One short run of the candidate through each provider we can sign in to, starting with Copilot, as the 29 Sep live check did by hand. | Medium |
| **G13. Open defect 4** | Clean Loom numbers on the dev subset | Diagnose `loom-route-weft-boundary-downstream-review` on GPT 6 Luna, as the baseline asked. | Small |

## Order

1. **G1, G2, G4, G6.** These are tooling changes and are cheap. After them every comparison scores the shipped prompts, names its cost, and can run trajectory cases.
2. **G5, G7, G8.** The publishing side, done alongside Spec 39 work items 2 and 7.
3. **G3, one suite at a time.** Start with Shuttle and Weft: their picks were measured on override prompts, and the 25 Sep record found the clearest model differences on review and execution. Each grown suite makes its agent eligible.
4. **G9–G12** as the next round, to add the orchestrators, Thread and OpenCode 2 evidence.

The first published `stable` list repeats today's builtin lists ([Spec 39](../specs/39-spec-model-recommendations/39-spec-model-recommendations.md#website)), so none of this blocks building the feature. It only blocks publishing a list that changes a model.
