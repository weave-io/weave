# Spec 38 Tasks — Delegation Accuracy

Task tracking for [Spec 38](38-spec-delegation-accuracy.md). Non-normative: tick boxes as work lands; don't rewrite history.

## Start here (for a new session)

1. Read [Spec 38](38-spec-delegation-accuracy.md): the goal, the state on `main`, the [prompt rules](38-spec-delegation-accuracy.md#prompt-rules), the item notes and the [finish line](38-spec-delegation-accuracy.md#finish-line). Skim the WS1 section of the [remediation plan](../../artifacts/session-audit-2026-09-plan.html) for the audit's evidence.
2. Read [Adapter Boundary](../../adapter-boundary.md) before touching the engine, and [Prompt Composition](../../prompt-composition.md) before touching a prompt or the template context.
3. Take the first group below whose boxes are not all ticked. Groups are in working order.
4. One pull request per group. Write the tests first. Reference the tracking issue (#253) in the PR, plus a per-group issue if you create one.
5. Tick the boxes in this file in the same PR that does the work, and add the PR number next to the group heading.
6. Keep sessions short: stop after a group lands and start the next group in a fresh session from this file.

**Order and dependencies:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Group 1's tests guard groups 2 and 3, so they come first. Group 3 needs group 2's materialized list to be the only list the prompts see. Group 7's active-plan case needs group 6. Group 8 runs the delegation case in the form group 3 leaves it. Group 9 has no code dependency and may land earlier if a session has room; the dogfooding week in group 10 needs it. After groups 3, 4 and 6, run the [measurement](#measurement-after-groups-3-4-and-6).

**Harness scope:** adapter-specific work covers OpenCode V1 (`packages/adapters/opencode`) and OpenCode V2 (`packages/adapters/opencode2`). Engine and prompt changes apply to every adapter; keep the Copilot, Claude Code and Pi tests passing, and change Copilot's prompt adaptation where a prompt change requires it.

## 1. Contract tests (L1, L2) — PR: #255

Guards root causes (a), (b) and (c).

- [x] 1.1 Fixture configs, shared by L1 and L2: builtins only; two categories; four categories; a `disable agents` block that removes one builtin and one category shuttle; a category that declares no `models`. Also: a category whose model the harness does not offer; a category whose prompt fails to compose; on OpenCode 2, a category shuttle whose name another plugin already holds.
- [x] 1.2 **L1 materialization contract**, as adapter scenarios in `tests/adapters/` (see [`tests/README.md`](../../../tests/README.md)), for OpenCode V1 and V2 over every fixture: every agent in Loom's and Tapestry's delegation list is in the adapter's materialized set; every materialized agent has a provider-qualified model (`provider/model`) or none; each category produces exactly one `shuttle-{category}` and a disabled one produces none.
- [x] 1.3 **L2 prompt contract**: render Loom's and Tapestry's composed prompts for each fixture; collect every agent-like name in the rendered text (bold or backticked names, `shuttle-*` tokens, names after "delegate to"); assert each is a materialized agent. A small allowlist covers non-agent tokens (for example command names), with a comment per entry. Landed next to L1 in [`delegation-contract.scenario.test.ts`](../../../tests/adapters/delegation-contract.scenario.test.ts) rather than beside `prompt-snapshots.test.ts`: the prompt a harness gives Loom is observable at the adapter seam, so L2 reads the prompt each adapter registered, on both adapters, instead of an engine-composed one.
- [x] 1.4 Assertions that fail on today's `main` (expected: L1's delegation list against a failed materialization for (b), L2 against the `shuttle-backend` / `shuttle-frontend` line for (c)) are committed as known failures (`test.failing`) naming the group that fixes them. See the hand-off below.
- [x] 1.5 Confirm both run in `bun run test`, so CI's existing test check covers them. Document L1 and L2 in [`docs/testing-strategy.md`](../../testing-strategy.md#delegation-contract-tests-l1-l2).

**Hand-off to groups 2 and 3.** The `it.failing` assertions in [`delegation-contract.scenario.test.ts`](../../../tests/adapters/delegation-contract.scenario.test.ts), as found on `main`. When a group's fix lands, `bun test` reports the assertion passing as a failure; change it to `it` in that PR.

| Assertion | Where it fails | Found on `main` | Flipped by |
| --- | --- | --- | --- |
| "offers loom / tapestry only agents the harness holds" (L1) | V1 and V2, "a category whose prompt cannot be composed" | `shuttle-broken` is offered; its prompt failed to render, so it was never registered. | Group 2 — flipped |
| same (L1) | V2 only, "after another plugin registered an agent under a category shuttle's name" | `shuttle-web` is offered; the host holds a foreign agent of that name and Weave's was never inserted. | Group 2 — flipped |
| "names only registered shuttles in loom's prompt" (L2) | V1 and V2, every fixture | `shuttle-backend`, `shuttle-frontend` (the prohibition line), `shuttle-core` (the todo-list example) and `shuttle-{category}` (the category paragraph). | Group 3 (3.1); group 2's part landed |
| "names only registered agents in tapestry's prompt, outside shuttle-* names" (L2) | V1 and V2, "a builtin and a category shuttle disabled" | `warp`: `<Routing>` says "Do not route plan execution tasks to Pattern, Thread, Spindle, Weft, or Warp" with `warp` disabled. | Group 3 |
| "names only registered shuttles in tapestry's prompt" (L2) | V1 and V2, every fixture | `shuttle-{category}` in `<Delegation>` and `<Routing>`. | Group 3 (3.4); group 2's part landed |

Everything else passes on `main` for both adapters, including the fixtures the audit suspected: a category whose model the harness does not offer is still registered (V1 passes `provider/model` through, V2 registers it without a model since #215) and is correctly offered, and a disabled agent or category shuttle is neither registered nor offered. Not covered by L2: plain-prose mentions, for example "Warp is mandatory" in Loom's prompt when `warp` is disabled.

## 2. Offer only materialized agents — PR: #258

Fixes (b). Decision: [ADR 0013](../../adr/0013-delegation-targets-from-materialized-agents.md).

- [x] 2.1 ADR (next free number in [`docs/adr/`](../../adr/)): the adapter reports what it materialized and why any agent failed; the engine builds `delegation.targets` from that set alone and logs each exclusion. It settles when Loom's and Tapestry's prompts are composed relative to materialization (see the item notes in the spec) and how an adapter with no report behaves (today's config-based list, logged once).
- [x] 2.2 Engine: accept the materialized set as explicit adapter context and filter delegation targets by it; log each exclusion with the agent and reason (`logger.child({ module: … })`, structured fields). Pure function tests with fixture context.
- [x] 2.3 OpenCode V1 and V2: report the materialized set, including agents dropped by translation, model resolution or a V2 foreign-name collision, each with a typed reason.
- [x] 2.4 Flip group 1's (b) known failure. Update [`prompt-composition.md`](../../prompt-composition.md#delegation-filtering-rules) (a new filtering rule), [`adapter-boundary.md`](../../adapter-boundary.md) and the adapter docs.

**How it landed.** The engine drops an agent whose own prompt failed to compose from every delegation list by itself, re-composing only the prompts that had offered it; no adapter needs to report that. For harness-side refusals, `materializeAgents({ config, harness })` takes a `HarnessMaterializationReport` (`materialized` names plus `failed` entries with a reason: `model_unresolved`, `translation_failed`, `name_taken`; `not_reported` for anything the report omits) and returns every exclusion in `plan.unavailableAgents`, each also logged at `warn`. Order: compose → register → re-compose only when something was refused. OpenCode V1 ([`materialize-agents.ts`](../../../packages/adapters/opencode/src/materialize-agents.ts)) re-composes after resolution or translation refuses an agent (neither can fail on today's config-hook path, so unit tests inject the failure). OpenCode V2 reads the host's agent list before building its catalog and passes the ids of agents that lack Weave's ownership marker as `heldAgents`; a Weave agent with one of those names is reported `name_taken`, and the held set is part of the catalog revision. The exclusion log is not observable at the adapter seam (tests run with `LOG_LEVEL=silent`); `plan.unavailableAgents` carries the same entries and is asserted in [`materialization-availability.test.ts`](../../../packages/engine/src/__tests__/materialization-availability.test.ts). A new OpenCode 2 scenario checks that Loom neither lists nor may spawn an agent whose name another plugin holds.

## 3. Loom and Tapestry prompt rules — PR: _

Fixes (c) and (e). Texts: [Prompt rules](38-spec-delegation-accuracy.md#prompt-rules). Write every rule positively: state the situation and the behaviour wanted, and name only agents that are listed.

- [ ] 3.1 `loom.md`: replace the category-shuttle paragraph with "Delegate only to the agents listed above." and the matching-category guidance; remove the example names.
- [ ] 3.2 `loom.md`: add the size rule and reconcile the sections it replaces ("Small or self-contained work", the "Never delegate work you can complete correctly in one step" and "Delegate aggressively" lines).
- [ ] 3.3 `loom.md` and `tapestry.md`: add the recovery rule (resend once after a transient error; after a configuration error send the task to `shuttle` and tell the user in one line which agent is broken). Fold Tapestry's existing `<ErrorHandling>` retry into it rather than having two rules.
- [ ] 3.4 `tapestry.md`: replace the `shuttle-{category}` placeholder in `<Delegation>` and `<Routing>` with "the matching category shuttle listed above".
- [ ] 3.5 Copilot: update [`delegation-prompt.ts`](../../../packages/adapters/copilot/src/delegation-prompt.ts) and its tests for the removed placeholder and example line.
- [ ] 3.6 Guard tests assert the positive sentences. Flip group 1's (c) known failure; L2 passes on every fixture.
- [ ] 3.7 Re-run the cases the size rule touches, at least `loom-delegates-backend-fix-to-category-trajectory` (#230) and `loom-route-pattern-boundary-small-fix`, on the dev subset. Where a case conflicts with the size rule, change the case, not the rule (spec, item notes): widen #230's task to span `src/api/` and `src/db/`, and let a text case accept Loom doing one-place work itself. Record each change and why in the PR.
- [ ] 3.8 Update the tryweave.io docs if they describe when Loom delegates.

## 4. Routable category-shuttle descriptions — PR: _

Fixes (f).

- [ ] 4.1 Engine: build a generated category shuttle's description from the category's `description` and `triggers` (for example "Category shuttle for backend: Backend HTTP handlers and data access. Use for HTTP handlers, status codes and data access under src/api/ and src/db/."). Keep `CategoryMetadata.description` unchanged. Tests in [`descriptors.ts`](../../../packages/engine/src/descriptors.ts)'s suite.
- [ ] 4.2 `tapestry.md`: render each target's triggers as Loom's list does.
- [ ] 4.3 Check the description OpenCode V1 and V2 show in their own agent list (V2 prepends its ownership marker) and fit the harness's limits, if any.
- [ ] 4.4 Update [`prompt-composition.md`](../../prompt-composition.md) and the DSL reference's category section.

## 5. Hide harness built-in subagents — PR: _

Fixes (d). OpenCode V1 and V2 only; Copilot already steers its orchestrators away from built-ins.

- [ ] 5.1 Find the mechanism for each harness and verify it live: OpenCode's per-agent `task` permission for Loom and Tapestry, or disabling `explore` and `general` in the generated config. V1: `opencode debug agent loom`. V2: `opencode2 api agent.list` (see `scripts/proof/opencode2-live/`). Prefer the mechanism that leaves sessions without a Weave agent unchanged.
- [ ] 5.2 Implement it in both adapters, with adapter tests (mocked config, no live harness).
- [ ] 5.3 Record the mechanism, the evidence and its limits in each adapter's doc, as [Copilot's](../../copilot-adapter.md#delegation-targets-and-copilot-built-in-agents) does.
- [ ] 5.4 Update the tryweave.io adapter docs.

## 6. Loom never executes plans — PR: _

- [ ] 6.1 Template context: add plan-state paths (for example `plan.active`, `plan.name`, `plan.tasksRemaining`) to `ALLOWED_TEMPLATE_PATHS` and the context types in [`template-context.ts`](../../../packages/engine/src/template-context.ts), supplied by the adapter and absent when it supplies none. Document them in [`prompt-composition.md`](../../prompt-composition.md#template-context) and the Template Context table in [`AGENTS.md`](../../../AGENTS.md).
- [ ] 6.2 OpenCode V1 and V2: read plan state through the existing plan-state provider ([Spec 19](../19-spec-plan-state-provider/19-spec-plan-state-provider.md)) and make Loom see the current state mid-session: re-compose Loom's prompt when the state changes, or a per-turn mechanism verified on that harness. Record which, per adapter.
- [ ] 6.3 `loom.md`: "While a plan is active, answer the user and point them to `/weave:start` to resume; Tapestry executes plan tasks." inside a `{{#plan.active}}` section. Guard test for the sentence; L2 still passes.
- [ ] 6.4 Update the tryweave.io docs for Loom's behaviour during a plan.

## Measurement after groups 3, 4 and 6

Record each result in that group's PR.

- [ ] M.1 After group 3: `eval compare` on the dev subset, `--repeat 3`, against the [24 Sep 2026 baseline](../../artifacts/eval-baseline-2026-09-24.md), unit by unit as its "How to compare" section describes. Read weft-review and pattern-planning against its Corrections section.
- [ ] M.2 After group 4: the same.
- [ ] M.3 After group 6: the same.

## 7. New eval cases (L4) — PR: _

- [ ] 7.1 Trajectory case, loom-routing: a fixture with an active plan (`.weave/state.json` and a plan with unchecked tasks); the user asks a follow-up about the plan; Loom makes zero `task` calls for plan tasks and its answer points to `/weave:start`. Tag it with the "Plan-task delegation by Loom" metric.
- [ ] 7.2 Case: every path a delegation prompt cites exists in the fixture. If the trajectory schema cannot express it, extend it following [Spec 35](../35-spec-verification-trajectory-evals/35-spec-verification-trajectory-evals.md)'s "Runtime behaviour checks", with schema, validate and end-to-end tests in the same commit.
- [ ] 7.3 Case at the size rule's boundary: a change to two files inside one category is delegated to that category's shuttle. Unless group 3 already made #230 this case, add it (text or trajectory).
- [ ] 7.4 Run the new cases on the default matrix; each passes at ≥ 90%. Document them in "Runtime behaviour cases" in [`docs/agent-evals.md`](../../agent-evals.md) and the case counts in [`docs/evals-overview.md`](../../evals-overview.md).

## 8. Live delegation proof in CI (L3) — PR: _

- [ ] 8.1 A CI job that runs the delegation trajectory case (#230, as group 3 left it) on a cheap model (for example DeepSeek V4 Flash) in the Podman sandbox, for PRs touching `packages/adapters/**`, `packages/config/**`, `packages/engine/**` or prompts. It fails if any spawned subagent errors or if `explore` or `general` is spawned. [`proof-active-agent.yml`](../../../.github/workflows/proof-active-agent.yml) and the trajectory job in [`agent-evals.yml`](../../../.github/workflows/agent-evals.yml) are the models.
- [ ] 8.2 The job always registers: it decides inside the job whether the changed paths need the live run and succeeds without running otherwise, and fork PRs (no secrets) skip the same way. Update `workflow-sync.test.ts` if it covers the new job.
- [ ] 8.3 Record the per-run cost (cents) and time in the PR. Ask the maintainer to make L1/L2 (the test check) and L3 required checks.

## 9. Real-session audit script (L5) — PR: #256

Spec 37 group 3, narrowed to WS1 and widened to OpenCode V2.

- [x] 9.1 `scripts/audit/` (Bun, `bun:sqlite` with `readonly: true`): flags `--db`, `--harness opencode|opencode2`, `--since`, `--until`, `--project <dir>`, `--format md|json`; excludes directories under `/tmp/`. Default V1 store `~/.local/share/opencode/opencode.db`; find the V2 store and schema and record them in the script's header.
- [x] 9.2 The WS1 metrics from [Spec 38 Metrics](38-spec-delegation-accuracy.md#metrics), each a small named function.
- [x] 9.3 Fixture tests on tiny in-memory databases for each store's schema.
- [x] 9.4 Run it for 4–18 Sep 2026 on the V1 store and check it reproduces the audit's WS1 baseline within rounding; note definitional differences in the header.
- [x] 9.5 Usage in a short [`scripts/audit/README.md`](../../../scripts/audit/README.md), linked from [`docs/testing-strategy.md`](../../testing-strategy.md).

## 10. Close WS1 — PR: _

Not a work item: the close-out against the spec's done-when.

- [ ] 10.1 A week of dogfooding `main` on OpenCode V1 and V2. The group 9 script shows zero configuration delegation failures, zero built-in-agent spawns, and category shuttles used for category work. Record the scorecard in `docs/artifacts/ws1-dogfood-<date>.md`.
- [ ] 10.2 After the credit top-up, one published full-matrix run (text and trajectory). Record the `eval compare` result against the baseline in the same artifact.
- [ ] 10.3 Mark Spec 38 done in its status line and in [`docs/specs/README.md`](../README.md). Anything left goes to its workstream or a new issue (see the [finish line](38-spec-delegation-accuracy.md#finish-line)).

## Relevant files

| File | Why it is relevant |
| --- | --- |
| [`packages/config/prompts/loom.md`](../../../packages/config/prompts/loom.md), [`tapestry.md`](../../../packages/config/prompts/tapestry.md) | The prompts groups 3, 4 and 6 change. |
| [`packages/engine/src/compose.ts`](../../../packages/engine/src/compose.ts) | Builds `delegation.targets` today (group 2). |
| [`packages/engine/src/materialization.ts`](../../../packages/engine/src/materialization.ts) | `materializeAgents()`, which adapters call to compose descriptors (groups 2, 6). |
| [`packages/engine/src/descriptors.ts`](../../../packages/engine/src/descriptors.ts) | Generates category shuttles and their descriptions (group 4). |
| [`packages/engine/src/template-context.ts`](../../../packages/engine/src/template-context.ts) | `ALLOWED_TEMPLATE_PATHS` and the context types (group 6). |
| `packages/adapters/opencode/src/plugin.ts`, `translate-agent.ts`, `model-resolution.ts` | V1 materialization, translation and model resolution (groups 1, 2, 4, 5). |
| `packages/adapters/opencode2/src/plugin.ts`, `translate-agent.ts`, `reconcile-agent.ts` | V2 equivalents, including the foreign-name collision check (groups 1, 2, 4, 5). |
| `packages/adapters/opencode/src/adapter.ts` | Constructs the plan-state provider (group 6). |
| [`packages/adapters/copilot/src/delegation-prompt.ts`](../../../packages/adapters/copilot/src/delegation-prompt.ts) | Rewrites names in Loom's and Tapestry's prompts (group 3). |
| [`packages/cli/src/evals/__tests__/prompt-snapshots.test.ts`](../../../packages/cli/src/evals/__tests__/prompt-snapshots.test.ts) | Where L2 sits (group 1). |
| `tests/adapters/opencode.scenario.test.ts`, `opencode2.scenario.test.ts` | Adapter scenarios, where L1 fits (group 1). |
| `evals/cases/loom-routing/loom-delegates-backend-fix-to-category-trajectory.json`, `evals/fixtures/orders-api/` | The delegation trajectory case and its fixture (groups 3, 8). |
| `evals/cases/loom-routing/`, `evals/cases/tapestry-category-routing/` | Routing cases (groups 3, 7). |
| [`.github/workflows/proof-active-agent.yml`](../../../.github/workflows/proof-active-agent.yml), [`agent-evals.yml`](../../../.github/workflows/agent-evals.yml) | Models for the L3 job (group 8). |
| `scripts/audit/` | New session audit script (group 9). |
| [`docs/prompt-composition.md`](../../prompt-composition.md), [`docs/adapter-boundary.md`](../../adapter-boundary.md), [`AGENTS.md`](../../../AGENTS.md) | Docs that change with groups 2, 4 and 6. |
| [`docs/artifacts/eval-baseline-2026-09-24.md`](../../artifacts/eval-baseline-2026-09-24.md) | The baseline for `eval compare`, and where its bundles are. |
