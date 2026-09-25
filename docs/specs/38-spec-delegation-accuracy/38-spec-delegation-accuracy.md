# Spec 38 — Delegation Accuracy

**Status:** In progress (item 1 landed) — agreed with the maintainer on 25 Sep 2026; see [38 tasks](38-tasks-delegation-accuracy.md) · **Workstream:** WS1 of the [September 2026 session audit](../../artifacts/session-audit-2026-09.md) · **Tracking issue:** #253

**Related:** [38 tasks](38-tasks-delegation-accuracy.md) · [Spec 37 — Repository Foundation](../37-spec-repository-foundation/37-spec-repository-foundation.md) (WS0) · [Adapter Boundary](../../adapter-boundary.md) · [Prompt Composition](../../prompt-composition.md) · [Evals Overview](../../evals-overview.md) · [Eval baseline, 24 Sep 2026](../../artifacts/eval-baseline-2026-09-24.md) · [Spec 15 — Adapter-Facing Materialization API](../15-spec-adapter-facing-materialization-api/15-spec-adapter-facing-materialization-api.md) · [Spec 18 — Delegation Exclusion](../18-spec-delegation-exclusion/18-spec-delegation-exclusion.md) · [Spec 19 — Plan State Provider](../19-spec-plan-state-provider/19-spec-plan-state-provider.md) · [Copilot Adapter — built-in agents](../../copilot-adapter.md#delegation-targets-and-copilot-built-in-agents)

## Goal

When Loom or Tapestry delegates, it picks an agent that exists, is the right one, and completes. When a delegation fails anyway, the orchestrator recovers without the user noticing.

## Why

The session audit found that failed and misrouted delegations cost users the most turns and waiting. All 11 category-shuttle delegations failed, 14 tasks went to OpenCode's built-in `explore` and `general` agents instead of Thread or Shuttle, four transient failures were left for the user to notice, and Loom took turns in 17 of 20 `/start-work` sessions, carrying on with the plan itself. None of this was caught before release.

Spec 37 built what is needed to measure a change: every test runs in CI, `eval run --models dev --repeat 3` runs predictably, `eval compare` tells a change from noise, and there is a trajectory case for delegation accuracy (#230). WS1 now changes behaviour and proves it at five test layers, L1–L5.

## State on `main` (25 Sep 2026)

The audit's six root causes are lettered (a)–(f) as in the [remediation plan](../../artifacts/session-audit-2026-09-plan.html).

| Root cause | State on `main` | Evidence |
| --- | --- | --- |
| (a) Builtin and category models are bare names, which OpenCode reads as a provider with an empty model | **Fixed** by `b4f8efac`; ships in 0.2.1. L1 locks it in. | [Session audit](../../artifacts/session-audit-2026-09.md#evidence-highlights) |
| (b) Loom's delegation list is built from config, not from what the harness materialized | Open. `delegation.targets` comes from the merged config; an agent that failed to materialize is still offered. | [`compose.ts`](../../../packages/engine/src/compose.ts), [Delegation Filtering Rules](../../prompt-composition.md#delegation-filtering-rules) |
| (c) `loom.md` names `shuttle-backend` and `shuttle-frontend` in a prohibition, which primes the model to try them | Open. The line is "Do not invent legacy category names such as `shuttle-backend` or `shuttle-frontend` unless they are explicitly listed." | [`loom.md`](../../../packages/config/prompts/loom.md) |
| (d) Harness built-in subagents stay visible next to Weave's agents | Open on OpenCode V1 and V2. Copilot already steers Loom and Tapestry away from its built-ins by adapting their prompts at translation time. | [Copilot Adapter](../../copilot-adapter.md#delegation-targets-and-copilot-built-in-agents) |
| (e) Nothing retries a transient failure, and nothing falls back after a configuration failure | Open. Tapestry retries a failed task once with more context; Loom has no rule. Neither separates transient from configuration errors. | [`tapestry.md`](../../../packages/config/prompts/tapestry.md) `<ErrorHandling>` |
| (f) Category-shuttle descriptions do not say what the category covers | Partly open. Generated shuttles carry the category's `description` and `triggers`, and Loom's list renders both. Tapestry's list renders only `description`, and the harness's own agent list (OpenCode's `task` tool) shows only the bare category description. Categories have no file patterns since 0.2.0; routing uses `description` and `triggers`. | [`descriptors.ts`](../../../packages/engine/src/descriptors.ts), [`translate-agent.ts`](../../../packages/adapters/opencode/src/translate-agent.ts), [Adapter Boundary](../../adapter-boundary.md#category-metadata-on-generated-shuttles) |

Also open:

- **Loom executes plan tasks while a plan is active.** The audit decided that Loom never executes plans; nothing implements it yet.
- **No real-session audit script.** Spec 37 group 3 was deferred, so the audit's WS1 metrics can only be reproduced by hand.

What is already good:

- **Routing evals meet the audit's ≥ 90% target.** The full default matrix on 25 Sep 2026 (nine models, Jev judge) passed loom-routing 123/135 and tapestry-category-routing 89/90. What remains is mostly runtime behaviour, which text cases cannot see.
- **The delegation trajectory case exists.** `loom-delegates-backend-fix-to-category-trajectory` (#230) starts on Loom in a real OpenCode session and passes only if Loom delegates to `shuttle-backend` and nothing else.

## Decisions (25 Sep 2026)

- **Harness scope.** Adapter-specific work (hiding built-ins, the audit script, the live proof) covers **OpenCode V1 and OpenCode V2**. Engine and prompt changes apply to every adapter. Claude Code and Pi come later.
- **Loom's size rule (proportional delegation).** Loom does small, self-contained work itself and delegates the rest. The wording for `loom.md` is below; the maintainer may adjust it in review.
- **The session-audit script is built now**, for WS1's delegation metrics only, against the OpenCode V1 and V2 session stores. The [Spec 37 metric definitions](../37-spec-repository-foundation/37-tasks-repository-foundation.md#metric-definitions-for-the-session-audit-script) apply; this spec adds two (see [Metrics](#metrics)).
- **Budget.** Comparisons and CI proofs cost cents. A credit top-up is expected before the final published run.
- **Unchanged from the audit.** `/weave:start` stays. No per-change verification loops. Loom never executes plans. Fixes ship in 0.2.1 when the maintainer decides.

### Prompt rules

Prompt rules state the situation and the behaviour wanted, not the behaviour to avoid, and they name only agents that exist ([why](../../artifacts/session-audit-2026-09-plan.html)). The texts below are the intent; the exact wording lands in item 3 and may change in review.

**Delegation rule** (Loom and Tapestry): "Delegate only to the agents listed above." The example names in `loom.md` go.

**Size rule** (Loom):

> Do small, self-contained work yourself: a change in one place, whose cause is already clear from what you have read, that one command can verify. For example a one-file fix, a config tweak, running a check, or answering a question.
>
> Delegate when the work:
> - spans several files or modules: send it to the matching category shuttle listed above, or to `shuttle` when none matches;
> - needs exploration or research beyond a quick look: send it to Thread or Spindle;
> - is multi-step or needs a plan: send it to Pattern, and Tapestry executes the plan;
> - is a review: send it to Weft or Warp.
>
> When the size is unclear, delegate if the job would take more than a few steps, so you stay responsive to the user.

**Recovery rule** (Loom and Tapestry): after a transient error (for example a connection reset), send the same task once more. After a configuration error (the agent or its model is not found), send the task to `shuttle` and tell the user in one line which agent is broken.

**Active plan** (Loom): while a plan is active, answer the user and point them to `/weave:start` to resume; Tapestry executes plan tasks.

## Work items

One pull request per item, tests first, in this order. Each item's tasks are in the [tasks file](38-tasks-delegation-accuracy.md).

| # | Item | Fixes | Outcome that shows it is met |
| --- | --- | --- | --- |
| 1 | **Contract tests (L1, L2)** | guards a, b, c | **L1:** for OpenCode V1 and V2 and a set of fixture configs, every agent in Loom's and Tapestry's delegation list was materialized, each materialized agent has a provider-qualified model or none, and each category yields exactly one `shuttle-{category}`. **L2:** Loom's and Tapestry's prompts rendered for fixture configs (no categories, several categories, a `disable` block) name only agents that were materialized, and no invented names. Both run in `bun run test`. A test that fails today is committed as a known failure and flipped by the item that fixes it. |
| 2 | **Offer only materialized agents** | b | The adapter reports which agents it materialized and why any failed. The engine builds `delegation.targets` from that set alone and logs each exclusion. An ADR records the decision. L1's delegation-list assertion passes on both OpenCode adapters. |
| 3 | **Loom and Tapestry prompt rules** | c, e | `loom.md` and `tapestry.md` carry the [delegation, size and recovery rules](#prompt-rules), written positively; no prompt names an agent that is not in the rendered list. L2 passes. Guard tests assert the positive sentences. |
| 4 | **Routable category-shuttle descriptions** | f | A generated category shuttle's description, as the harness shows it and as Tapestry's list renders it, says what the category covers, built from the category's `description` and `triggers`. |
| 5 | **Hide harness built-in subagents** | d | On OpenCode V1 and V2, Loom and Tapestry cannot spawn `explore` or `general`, by a mechanism verified live on each harness and recorded in its adapter doc. Sessions without a Weave agent are unaffected. |
| 6 | **Loom never executes plans** | plan follow-ups | The adapter passes plan state (active plan, tasks remaining) as template context; the path is in `ALLOWED_TEMPLATE_PATHS` and documented. While a plan is active, Loom answers and points to `/weave:start`. |
| 7 | **New eval cases (L4)** | wrong-agent choice | Three cases: with an active plan, Loom makes zero plan-task delegations (trajectory); delegation prompts cite only paths that exist; a two-file change inside one category goes to that category's shuttle (the size rule's boundary). |
| 8 | **Live delegation proof in CI (L3)** | a, b, d at runtime | A CI job runs the delegation trajectory case on a cheap model for PRs that touch adapters, config or prompts, and is a required check. |
| 9 | **Real-session audit script (L5)** | anything the other layers miss | `scripts/audit/` reads OpenCode V1 and V2 session stores read-only and prints the WS1 metrics as Markdown and JSON. |

### Item notes

- **Item 2 and the adapter boundary.** Which agents a harness accepted is harness knowledge, so the adapter reports it; the engine only filters the targets it was given and returns a result ([Adapter Boundary](../../adapter-boundary.md#boundary-rule)). Materialization can fail in the adapter (translation, model resolution, a V2 foreign-name collision); each such failure is reported with its reason rather than dropped silently. Today prompts are composed before the adapter materializes agents, so the ADR must settle the order: compose Loom's and Tapestry's prompts after materialization, or re-compose them once the materialized set is known.
- **Item 3 and the existing cases.** The size rule lets Loom make a one-file fix itself. `loom-delegates-backend-fix-to-category-trajectory` (#230) is such a fix (`src/api/orders.ts`), and text cases such as `loom-route-pattern-boundary-small-fix` expect a one-place fix to go to `shuttle`. Item 3 re-runs them. Where a case now conflicts with the size rule, the case changes, not the rule: widen #230's task so it spans the handler and the data layer (two files in the backend category), and let a text case accept Loom doing one-place work itself. Record each change and why in the PR, so `eval compare` differences on those cases are read as intended. Item 8 uses #230 in whatever form item 3 leaves it.
- **Item 3 and Copilot.** Copilot's [`delegation-prompt.ts`](../../../packages/adapters/copilot/src/delegation-prompt.ts) rewrites names in Loom's and Tapestry's prompts, including the `shuttle-{category}` placeholder, and its tests mention the "do not invent `shuttle-backend`" line. Change them in the same PR.
- **Item 5, mechanisms.** Candidates are OpenCode's per-agent `task` permission for Loom and Tapestry, or disabling the built-in agents in the generated config. The chosen mechanism must be verified live (`opencode debug agent <name>` on V1, `opencode2 api agent.list` on V2) and must not change sessions where no Weave agent is active, the scope rule Copilot follows.
- **Item 6, when plan state is read.** Adapters compose prompts once, when the plugin loads (`materializeAgents()`), but a plan becomes active mid-session. Item 6 decides for each adapter how Loom sees current plan state: re-compose Loom's prompt when the plan state changes, or a per-turn mechanism verified on that harness. The adapter reads plan state (`.weave/state.json`, [Spec 19](../19-spec-plan-state-provider/19-spec-plan-state-provider.md)); the engine only renders what it is given. New template paths follow [Prompt Composition](../../prompt-composition.md#template-context): add them to `ALLOWED_TEMPLATE_PATHS`, the context types, `prompt-composition.md` and the table in `AGENTS.md`.
- **Item 8, required-check mechanics.** A required check that does not run blocks merging, so the job always registers and decides inside the job whether the changed paths need the live run; it reports success without running otherwise. Fork PRs have no secrets and skip the same way.

## Metrics

The WS1 metrics are the [Spec 37 definitions](../37-spec-repository-foundation/37-tasks-repository-foundation.md#metric-definitions-for-the-session-audit-script) for Delegations, Configuration delegation failures, Category-shuttle success, Built-in agent delegations, Transient failures and Plan-task delegation by Loom. Two more:

| Metric | Definition |
| --- | --- |
| Category-shuttle share | In projects that define categories: `task` parts whose target starts with `shuttle-` ÷ `task` parts whose target is `shuttle` or starts with `shuttle-`. |
| Recovered failures | Failed `task` parts after which the same assistant turn, or the next, sends a `task` part to the same target (transient errors) or to `shuttle` (configuration errors). Reported ÷ all failed `task` parts. |

The `/start-work` marker in "Plan-task delegation by Loom" predates `/weave:start`; item 9 uses whatever marker the current command writes and says so in the script's header.

## Measurement

- **After items 3, 4 and 6**, run `eval compare` on the dev subset with `--repeat 3` against the [24 Sep 2026 baseline](../../artifacts/eval-baseline-2026-09-24.md), unit by unit as that artifact describes. Record the result in the item's PR. The weft-review and pattern-planning rows moved since the baseline because of scoring fixes (#247, see the baseline's Corrections), so read them against the corrected figures.
- **At the end**, one published full-matrix run (text and trajectory), after the credit top-up.

## Done when

1. L1, L2 and L3 are required CI checks.
2. The new L4 cases (item 7) pass at ≥ 90% on the default matrix, and `eval compare` shows no regression beyond noise.
3. A week of dogfooding `main` (OpenCode V1 and V2, measured with item 9's script) shows zero configuration delegation failures, zero built-in-agent spawns, and category shuttles used for category work.

## Finish line

WS1 ends when the three conditions above hold. It does not loop:

- A routing case that flips on one model, within the noise `eval compare` reports, is not a reason to keep going.
- A problem the week of dogfooding finds is fixed if it is a delegation failure (a configuration error, a built-in spawn, or an unrecovered transient error). Anything else goes to the workstream it belongs to (WS2 parallel execution, WS3 environment awareness, WS4 friction) or to a new issue.
- Claude Code and Pi adapter work is out of scope and gets its own issue.

After that, WS2 starts.

## Non-goals

- Parallel dispatch, waves and concurrency (WS2).
- Environment probing (WS3) and review-gate or question-tool friction (WS4).
- Hiding built-ins or live proofs on Claude Code, Pi or Copilot beyond what Copilot already does.
- An adapter-side retry. A failed delegation returns to the calling agent as the task's error result, and only that agent can act on it, so recovery is a prompt rule.
- Watchdogs and time budgets (deferred by the audit).
- Releasing. Changes land on `main`; 0.2.1 is the maintainer's call.

## Constraints

- Bun only; `neverthrow` for fallible code; no `console.*` ([AGENTS.md](../../../AGENTS.md)).
- Engine changes follow the [Adapter Boundary](../../adapter-boundary.md): the adapter supplies harness context (materialized agents, plan state), the engine returns normalized results. The engine never reads harness state or `.weave/state.json` itself.
- Template context is a closed allowlist; every new path is added to `ALLOWED_TEMPLATE_PATHS` with its docs in the same PR ([Prompt Composition](../../prompt-composition.md)).
- Prompt rules are positive and name only agents that exist ([Prompt rules](#prompt-rules)).
- The audit script reads harness databases, which are harness-owned, so it lives under `scripts/audit/`, opens them read-only and never writes them.
- Eval case schema changes, if any, follow the schema-change rule: schema, validate and end-to-end tests in the same commit.
- User-visible changes (Loom's behaviour with an active plan, hidden built-ins) include a tryweave.io docs update ([website repo](https://github.com/pgermishuys/weave-website)).
