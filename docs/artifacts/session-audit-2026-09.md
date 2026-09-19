# Session Audit — September 2026

> **Non-normative.** A historical snapshot of how Weave behaved in real OpenCode
> sessions, and the remediation roadmap agreed from it. Do not update this file
> as the system changes; record new measurements as new artifacts.

**Related:** [Spec 37 — Repository Foundation](../specs/37-spec-repository-foundation/37-spec-repository-foundation.md) · [Spec 37 tasks](../specs/37-spec-repository-foundation/37-tasks-repository-foundation.md) · [Documentation Policy](../documentation-policy.md)

## Source

- Read-only analysis of `~/.local/share/opencode/opencode.db` on the maintainer's
  workstation, 4–18 Sep 2026: 790 sessions (about 230 top-level), 17,661 messages, 67,616 parts.
- Projects: harmony, madsmenu, aside/model-router, weave, weave-fleet.
- Weave version in use: stable `0.1.2`. The 18 automated Fleet test sessions under `/tmp` were excluded.
- The plan was also written as a standalone page, saved as
  [`session-audit-2026-09-plan.html`](session-audit-2026-09-plan.html) (open it in a browser),
  and published as a private claude.ai artifact, "Weave Remediation Plan". This Markdown file is the canonical copy;
  the page has the fuller per-workstream detail (evidence, root causes, test layers).

## Baseline scorecard

| Metric | Baseline | Target | Workstream |
| --- | --- | --- | --- |
| Category-shuttle delegations that succeed | 0 / 11 | 100% | WS1 |
| Delegations failing for configuration reasons (`Model not found: claude-sonnet-4-5/.`, unknown agent) | 11 of 597 | 0 | WS1 |
| Delegations to harness built-in agents (`explore`, `general`) | 14 | 0 | WS1 |
| Transient subagent failures (`Connection reset by server`) not retried | 4 of 4 | 0 | WS1 |
| Plan tasks delegated by Loom while a plan was active | Loom took turns in 17 of 20 `/start-work` sessions | 0 | WS1 |
| Tapestry steps dispatching more than one task | 20 / 190 | every wave with ≥ 2 tasks | WS2 |
| Loom delegation steps dispatching more than one task | 30 / 352 | — | WS2 |
| Plan wall-clock ÷ critical path | ≈ 1.0 (19-task plan ran serially for 2.8 h) | ≤ 1.3 | WS2 |
| User turns saying "you got stuck" / "are you there?" | 8 turns · 6 sessions | down from baseline | WS2 |
| User turns explaining available tools (`gh`, `fly`, `podman`, `~/.bashrc` tokens) | 16 turns · 12 sessions | 0 | WS3 |
| `webfetch` 404s (mostly GitHub URLs) | 47 | ≤ 5 | WS3 |
| Guardrail: Shuttle task duration p50 / p90 | 2.6 / 11.4 min | ≤ +20% | WS3 |
| Loom turns ending with an offer or question | 165 / 576 (29%) | ≤ 15% | WS4 |
| Loom `question` tool calls that failed | 40 / 93 | ≤ 5% | WS4 |
| User turns asking what a plan does | 12 turns · 9 sessions | ≤ 2 | WS4 |
| User overrides of review/safety blocks | 8 turns · 7 sessions | trending down | WS4 |

Metric definitions are in the [Spec 37 tasks file](../specs/37-spec-repository-foundation/37-tasks-repository-foundation.md#metric-definitions-for-the-session-audit-script).

## Decisions

- **`/weave:start` stays.** Harnesses do not switch the primary agent without the user; the explicit command is correct.
- **No per-change verification loops.** #182 reverted #170 because Shuttle and Tapestry spent hours re-verifying. Verification ideas must be event-triggered, run once, and respect the Shuttle duration guardrail.
- **0.2.0 does not ship.** Fixes land on `main` and ship in **0.2.1** when the maintainer decides. `latest` (0.1.2) keeps the category-shuttle model bug until then; dogfooding uses local builds of `main`. If `0.2.0-next.0` is withdrawn: `npm deprecate` plus `npm dist-tag rm … next`, not unpublish.
- **Loom never executes plans.** With an active plan, Loom answers and points to `/weave:start`; only Tapestry executes plan tasks.
- **Watchdog and time budgets are deferred.** A watchdog is only possible on OpenCode (confirmed: `session.abort`, `session.children`, `tui.showToast`, plugin `event` hook), likely on OpenCode 2 and Pi, and not on Claude Code or Copilot. Revisit only if "stuck" turns don't fall after WS2.
- **Foundation first.** Spec 37 (WS0) comes before any behaviour change, so every later workstream can be measured.

## Roadmap

| Workstream | Summary | Status |
| --- | --- | --- |
| **WS0 — Foundation** | Tests all run and are quiet; one-edit model addition; website contract; eval map; session audit script; fresh eval baseline. | [Spec 37](../specs/37-spec-repository-foundation/37-spec-repository-foundation.md) |
| **WS1 — Delegation accuracy** | Offer Loom only agents that materialized; positive "delegate only to listed agents" rule; hide harness built-in subagents; retry once on transient errors, fall back to `shuttle` on config errors; category-shuttle descriptions carry `patterns`; Loom never executes plans. Tests at five layers: L1 materialization contract, L2 prompt contract, L3 live delegation proof in Podman, L4 routing evals mined from this audit, L5 session audit. | Not started |
| **WS2 — Parallel execution** | Deterministic `computeExecutionWaves(tasks)` from `Depends on` + `Files`; Pattern keeps waves wide; Tapestry dispatches a whole wave per turn and reports each wave in one line; concurrency cap (see [Spec 36](../specs/36-spec-execution-controls/36-spec-execution-controls.md)); worktree isolation only if needed. | Not started |
| **WS3 — Environment awareness** | Adapter probes CLIs on `PATH` and env-var names (never values) once per session and passes them as template context; GitHub URLs go through `gh`; one symptom check for user-reported bugs; plan Verification runs once at the end. | Not started |
| **WS4 — Friction (pick after re-audit)** | Proportionate review gates (Warp only on security-relevant diffs; one fix-and-re-review within scope); finish the named outcome; plans lead with what you'll get; plain-text fallback when the `question` tool fails; no "N/M done" footers in chat. | Not started |

## Evidence highlights

- Every category-shuttle delegation failed instantly on 0.1.2 because builtin and category models are bare names (`claude-sonnet-4-5`), which OpenCode parses as a provider with an empty model. Fixed on `main` in `b4f8efac`.
- The Aside 19-task plan declared dependencies that allowed parallel work (task 17 depended only on 3b), yet Tapestry ran it serially: its prompt says "when in doubt, run sequentially" and it only parallelises tasks with disjoint `Files`.
- After `/start-work`, any user message lands on Loom, which then carried on executing the plan (e.g. 128 Loom turns vs 48 Tapestry turns in one session).
- Three rounds of "fixed, tests pass" on one madsmenu bug while the reported symptom remained; Loom repeatedly asked the user to paste logs or run commands it could run itself.
- `review_models` variant reviewers (e.g. `weft-github-copilot-claude-opus-5`) ran in 26 sessions on 5–6 Sep only; no current config enables them.
