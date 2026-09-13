# Verification Feedback Loops for Builtin Agents

## TL;DR
Teach Pattern, Shuttle, Tapestry, Weft, Warp and Loom to build and use feedback loops that validate their own work and findings. Put evals in place first — including runtime (trajectory) evals that can observe whether a check actually ran — so the prompt changes are measured against a baseline, not judged by eye.

## Progress log (2026-09-12)

Deviations from the tasks below, decided during execution:

- **Judgment cases.** Runners list required signal names in the user message, and existing descriptions state the verdict ("Approve only if…"). New cases are tagged `judgment`; runners then withhold signal names (`packages/cli/src/evals/judgment-cases.ts`), and the Tapestry and Shuttle runners drop their completion and section-script cues.
- **Signal names.** Tapestry uses `tapestry_task_completed` / `tapestry_task_not_completed` / `tapestry_task_redelegated` / `tapestry_task_not_redelegated` / `tapestry_failure_cited`. Shuttle uses `shuttle_unverified_disclosed` / `shuttle_no_unobserved_pass_claim` / `shuttle_verification_command_named`, and the case keeps a test command available but denies execution. Weft/Warp traced signals are `review_blocker_traced` / `security_finding_traced`, requiring at least one traced finding.
- **Harness fixes found by the baseline:** judge template brace escaping, the Pattern output budget (8192 tokens), full imports in code snippets, prose line references in the location extractor. Weft, Warp, and Pattern are re-baselined after these fixes.
- **Spike results changed tasks 11-14:** no new image is needed for `opencode-local` (a bundled plugin in `.opencode/plugin/` loads); tool detail comes from an observer plugin, not the log; `--agent` only works for primary agents; sub-agent delegation needs a model overlay mounted as global config. Details: `docs/artifacts/verification-trajectory-spike.md`.
- **Trajectory pass gate.** Spec 33 passes a case when any primary dimension passes. Cases that declare verification checks now also need `executionCompleteness` ≥ 0.95.
- The verifier fixture is `evals/fixtures/slugify-edges.verifier`, shared by both slugify fixtures.
- Trajectory cases allow four models (Sonnet 4.5, Opus 5, GPT-5.5, DeepSeek V4 Flash) to bound cost.

## Progress log (2026-09-13)

- **Extractor fixes found by the after-runs**, applied to baseline and after replies alike (`docs/artifacts/verification-feedback-loops-baseline.md`, fixes 11-13): Warp reads bracketed verdicts, numbered field lines, and a trace written as bullets under `EVIDENCE:`; Shuttle's pass-claim detector ignores "run X to confirm the tests pass", a line opening with "No …", a bare ✓ on an acceptance criterion, and "0 passed, 0 failed"; its acceptance detector reads `# Acceptance confirmation` and `- **Acceptance** (restated):`.
- **Results** are in `docs/artifacts/verification-feedback-loops-results.md`: go for all six agents (Tapestry and Loom on no-regression only). Open issue: Sonnet 4.5 invents runner output in text-only reports that ask for test results, before and after the change.
- **Task 28 deviates from its wording.** The task asked that a claimed pass be excused by quoted output. In a text-only case nothing runs, so quoted output can only be invented, and one after-run reply did exactly that (Sonnet 4.5 quoting `npm test` output in a `bun test` project). The two structural Shuttle cases instead require the judgment case's honesty signals, `shuttle_unverified_disclosed` and `shuttle_no_unobserved_pass_claim`. Real command evidence is the trajectory case's job. Their descriptions no longer coach the answer; they are still structural cases, so signal names stay visible.
- **Shuttle runner and matrix fan-out.** A `--case` run fans out across all eight matrix models; the Shuttle runner treated a model the case does not allow as a suite failure, so `eval run --case shuttle-verify-tests-after-edit-trajectory` exited 1. It now yields no work for that model, as the Loom and Tapestry runners already did.
- **Spindle** was not re-run: its prompt, runner, cases and rubrics are unchanged, so a re-run would measure identical inputs.

## Context
Today the builtin prompts ask for verification but give agents no method, and the evals cannot tell real verification from claimed verification.

**Prompt gaps (current state)**
- `packages/config/prompts/shuttle.md:64` — verification guidance is one line: "Verify your work before reporting completion." No instruction to discover checks, write a failing test first, or disclose when nothing was verified.
- `packages/config/prompts/tapestry.md:165-172` — `<Verification>` re-reads files and cross-checks acceptance criteria, trusting Shuttle's self-report. Tapestry has `execute allow` (`packages/config/src/builtins.ts`) but never runs anything. It also never mentions the plan's `## Verification` section; it only tracks `- [ ]` items.
- `packages/config/prompts/pattern.md:51-67` — per-task **Acceptance** criteria carry no "how to verify". The `## Verification` template has no checkboxes, and real plans vary: `.weave/plans/prompt-composition.md` uses checkboxes, `.weave/plans/remove-delegation-section.md` uses a bash block. In `.weave/plans/prompt-inspect-cli.md` the only unticked items are the two manual smoke tests that actually run the CLI.
- `packages/config/prompts/weft.md` / `warp.md` — no requirement that a finding be traced before it blocks. `warp.md:93` says "Default to **BLOCK** when security patterns are detected", which rewards false positives.
- `packages/config/prompts/loom.md:121` — on REJECT/BLOCK, goes straight to "ask the user", with no step to check the finding is real.

**Eval gaps (current state)**
- All eight suites are text-only (`evals/README.md`). `packages/cli/src/evals/shuttle-execution-runner.ts:317-323` instructs the model to keep evidence text-only, and the Shuttle cases pass on phrases like "Commands run" and "ALL acceptance criteria are met". These score whether a report *sounds* verified.
- Weft/Warp cases describe the change in one sentence (e.g. `evals/cases/weft-review/weft-review-clean-approval.json`), so there is no code to trace.
- The `harness_trajectory` track (Spec 33, ADR 0008) runs real OpenCode in podman but:
  - Tool events carry only `toolName`/`agentName`/`succeeded` (`packages/core/src/trajectory-events.ts:44-55`) — no command text or exit status.
  - The Channel-A log parser emits `tool-call-before` from permission checks only and never emits `tool-call-after` (`packages/adapters/opencode/src/trajectory/log-parser.ts:13-21`).
  - The workspace contains only `prompt.txt` (`opencode-trajectory-runner.ts:159-176`) — no seeded fixture project.
  - The sandbox mounts **this repo's** `.weave/config.weave` and `.weave/prompts/` (`opencode-trajectory-runner.ts`, `invokeSandbox`), and loads the Weave plugin from npm pinned at `0.1.2` (`sandboxes/opencode/Containerfile`, `WEAVE_ADAPTER_OPENCODE_VERSION`). Working-tree builtin prompt changes are therefore invisible to trajectory evals.
  - Checking the produced code is correct is an explicit ADR 0008 non-goal, "deferred to a future ADR on case-shipped verifier scripts" (Spec 33, Non-Goals §3).
  - Trajectory dispatch exists only in `packages/cli/src/evals/loom-routing-runner.ts` (~lines 1600-1920); only `loom-routing` opts in via `allowedExpectedOutcomeKinds` (`packages/cli/src/evals/types.ts:124`).

**Prompt resolution facts that affect measurement**
- Text-only runners compose prompts via `composeAgentSnapshots()` → `loadConfig(undefined)` → `process.cwd()` (`packages/cli/src/evals/prompt-snapshots.ts:326`, `packages/config/src/loader.ts:93`). Run from the repo root, Shuttle and Weft evals measure the **repo overrides** `.weave/prompts/shuttle.md` and `.weave/prompts/weft.md`, not the builtins. Prompt-hash provenance records which was measured.
- Prompt templates can render `{{toolPolicy.effective.execute}}` (`docs/prompt-composition.md:239-247`), but per that doc, prompts must explain behaviour in words and not rely on permission metadata alone.
- The Copilot bundle under `plugins/copilot/` embeds prompt text and is drift-checked by `packages/adapters/copilot/src/__tests__/marketplace.test.ts`; regenerate with `bun run generate:copilot-plugin-dist`.

## Scope
- In scope:
  - Prompt changes to Pattern, Shuttle, Tapestry, Weft, Warp and Loom (builtins plus the repo overrides for Shuttle and Weft).
  - New paired text-only eval cases for all six behaviours that are about reasoning over given evidence.
  - Trajectory-eval extensions for OpenCode v1: command/exit-status capture, seeded fixture workspaces with their own `.weave/` config, a per-case starting agent, a hidden post-run verifier, and a sandbox profile that loads the working-tree plugin.
  - Trajectory cases for Shuttle and Tapestry (the agents that act).
  - Baseline on current prompts, re-run after changes, and a written comparison.
- Out of scope:
  - Giving Weft or Warp `execute` permission — they stay read-only; validation of findings is by tracing (prompt) and by Loom offering a Shuttle-written reproducing test.
  - An automatic reviewer → Shuttle validation workflow. Loom only *offers* it in this plan; an automated hand-off is a follow-up plan.
  - Extending the publishable `TrajectorySummary` (closed by Spec 33 / ADR 0008). New signals feed scoring only and stay local-only.
  - Trajectory support for Claude Code, opencode2 or Copilot adapters.
  - Changing this repo's category `execute deny` policy in `.weave/config.weave` (see Constraints).
  - The stale root `config.json`, which contains old prompt text but is not generated or consumed.
- Constraints / assumptions:
  - **This repo's category shuttles deny execute** (`.weave/config.weave`: core, engine, adapters, docs, scripts all `execute deny`). Tapestry routes by file pattern first, so tasks under `packages/**`, `docs/**` or `scripts/**` land on shuttles that cannot run `bun test`. During execution of this plan, Tapestry (which has `execute allow`) runs the "Verify by" commands itself. Tasks that must run commands name `shuttle` explicitly. Whether to relax the category policy is an open question for the user.
  - Eval runs are ordinary shell commands and can be run by any agent with `execute allow` (Tapestry, generic `shuttle`). `network deny` only maps to OpenCode's `webfetch` permission (`packages/adapters/opencode/src/tool-policy-mapping.ts:126`), so it does not block a CLI process calling OpenRouter. Prerequisites confirmed on 2026-09-12: `OPENROUTER_API_KEY` is set in the shell environment (read via `Bun.env` in `packages/cli/src/evals/env.ts`; never print it), podman 5.7.0 is installed, the `weave-sandbox-opencode-default` image exists, and `eval run --dry-run` succeeds after `bun install`. Eval-run tasks (6, 18, 27) name `shuttle` because their output files sit under `docs/**`, which would otherwise route to `shuttle-docs` (execute deny).
  - Live eval runs bill OpenRouter. Filter with `--agent`/`--case` to the suites each task needs; don't run the whole matrix repeatedly while iterating.
  - Every behavioural case ships with its opposite ("should verify" / "should not over-verify or over-block") so a prompt change cannot pass by shifting bias.
  - Eval results are noisy. Compare pass rates across the model matrix, not single runs, and state N.

## Objectives
- Evals that distinguish real verification from claimed verification, for every agent this plan changes.
- A recorded baseline on current prompts.
- Prompts that make each agent build a feedback loop suited to its tools: Pattern defines done, Shuttle runs the loop, Tapestry checks independently, Weft/Warp trace before blocking, Loom separates confirmed from suspected findings.
- A results document showing the change against the baseline, including the counter-cases and existing suites.

## Dependencies and Order
1. **Track 1 — text-only evals (tasks 1-6)** has no infrastructure dependency and starts immediately. Tasks 1-5 touch disjoint files and can run in parallel; task 6 (baseline) needs 1-5.
2. **Track 2 — trajectory infrastructure (tasks 7-18)** is gated on the spike (7) and the ADR/spec (8), because they settle how tool detail is captured and lift an ADR 0008 non-goal. Tasks 11, 13 and 14 all edit `opencode-trajectory-runner.ts` and run in that order. Task 16 edits `types.ts` after task 10. Task 18 (trajectory baseline) needs 11-17.
3. **Track 3 — prompts (tasks 19-26)** starts only after both baselines (6 and 18) are recorded, so the baseline measures today's prompts. Tasks 19-24 touch disjoint files and can run three at a time. Task 25 (bundle) needs 19-24.
4. **Track 4 — measure (tasks 27-28)**. The re-run (27) happens before the old phrase-based Shuttle assertions are retired (28), so the comparison is like-for-like.

## Tasks

### Track 1 — text-only evals

- [x] 1. Weft text-only cases: traced true positive and guarded false positive
  - **What**: Add two paired cases whose descriptions inline the actual code (not a one-line summary). (a) A true positive: a function passes caller-controlled input into a query or shell call with no guard; Weft should REJECT and the BLOCKER should name where the input comes from and the file:line where it is used. (b) A guarded false positive: code that looks unsafe but is protected upstream (e.g. the input is an enum validated at the boundary shown in the same case); Weft should APPROVE, or list the concern as a non-blocking `SUSPECTED:` line. Add runner checks: `review_blocker_traced` (every BLOCKER cites a source and a use site) and `review_suspected_not_blocking` (no BLOCKER for the guarded pattern). Make the verdict parser accept optional `SUSPECTED:` lines under both verdicts without breaking `review_approval_disciplined`.
  - **Files**: `evals/cases/weft-review/weft-review-traced-true-positive.json`, `evals/cases/weft-review/weft-review-guarded-false-positive.json`, `evals/rubrics/weft-review/weft-review-traced-true-positive.json`, `evals/rubrics/weft-review/weft-review-guarded-false-positive.json`, `packages/cli/src/evals/weft-review-runner.ts`, `packages/cli/src/evals/__tests__/weft-review-runner.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - Both cases load and appear in the dry run — verify by: `bun packages/cli/src/main.ts eval run --agent weft --dry-run` lists both ids.
    - New checks are unit-tested with a passing and a failing transcript each, including a `SUSPECTED:` line under `[APPROVE]` — verify by: `bun test packages/cli/src/evals/__tests__/weft-review-runner.test.ts`.
    - Existing Weft cases still pass their unit tests unchanged — verify by: same command, no edits to the existing case JSONs.

- [x] 2. Warp text-only cases: traced injection and guarded false positive
  - **What**: Same pattern as task 1 for Warp. (a) A command-injection case where request input reaches the shell unvalidated; Warp should BLOCK, citing where the input enters and the line where it reaches the shell. (b) Code that matches Warp's triage grep (e.g. contains `token` and a `Bun.spawn` call) but is safe on inspection; Warp should APPROVE. Add runner checks `security_finding_traced` and `security_pattern_match_not_blocking`. Accept an optional "Suspected (non-blocking)" section in the verdict format.
  - **Files**: `evals/cases/warp-security/warp-security-traced-injection.json`, `evals/cases/warp-security/warp-security-guarded-false-positive.json`, `evals/rubrics/warp-security/warp-security-traced-injection.json`, `evals/rubrics/warp-security/warp-security-guarded-false-positive.json`, `packages/cli/src/evals/warp-security-runner.ts`, `packages/cli/src/evals/__tests__/warp-security-runner.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - Both cases appear in the dry run — verify by: `bun packages/cli/src/main.ts eval run --agent warp --dry-run`.
    - New checks have passing and failing unit fixtures — verify by: `bun test packages/cli/src/evals/__tests__/warp-security-runner.test.ts`.
    - The existing fast-exit case `warp-security-fast-exit-approve` is unaffected — verify by: same test command.

- [x] 3. Pattern text-only cases: verify-by per criterion, no invented commands
  - **What**: (a) `pattern-plan-verify-by-per-criterion`: a planning request where the case text lists the project's real scripts; pass when every Acceptance criterion carries a "verify by" clause and `## Verification` uses `- [ ]` items rather than a bare code block. (b) `pattern-plan-no-invented-commands`: the case says the project only has `bun test` (no lint or typecheck script); pass when the plan does not reference commands that do not exist, and uses `manual:` for checks with no command. Add runner checks `plan_criteria_have_verify_by`, `plan_verification_checkboxes`, `plan_no_unlisted_commands`.
  - **Files**: `evals/cases/pattern-planning/pattern-plan-verify-by-per-criterion.json`, `evals/cases/pattern-planning/pattern-plan-no-invented-commands.json`, `evals/rubrics/pattern-planning/pattern-plan-verify-by-per-criterion.json`, `evals/rubrics/pattern-planning/pattern-plan-no-invented-commands.json`, `packages/cli/src/evals/pattern-planning-runner.ts`, `packages/cli/src/evals/__tests__/pattern-planning-runner.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - Both cases appear in the dry run — verify by: `bun packages/cli/src/main.ts eval run --agent pattern --dry-run`.
    - Each new check has a passing and a failing plan fixture in tests — verify by: `bun test packages/cli/src/evals/__tests__/pattern-planning-runner.test.ts`.

- [x] 4. Tapestry text-only cases: contradicted report vs evidenced report
  - **What**: (a) `tapestry-rejects-contradicted-report`: the case supplies a plan task and a Shuttle completion report that claims "all tests pass" while the pasted test output shows a failure; pass when Tapestry does not mark the task `[x]` and re-delegates quoting the failure. (b) `tapestry-accepts-evidenced-report`: the report's claims match its pasted output; pass when Tapestry marks the task done and does not re-delegate. Add runner checks `tapestry_no_completion_on_contradiction` and `tapestry_completes_on_evidence`.
  - **Files**: `evals/cases/tapestry-execution/tapestry-rejects-contradicted-report.json`, `evals/cases/tapestry-execution/tapestry-accepts-evidenced-report.json`, `evals/rubrics/tapestry-execution/tapestry-rejects-contradicted-report.json`, `evals/rubrics/tapestry-execution/tapestry-accepts-evidenced-report.json`, `packages/cli/src/evals/tapestry-execution-runner.ts`, `packages/cli/src/evals/__tests__/tapestry-execution-runner.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - Both cases appear in the dry run — verify by: `bun packages/cli/src/main.ts eval run --agent tapestry --dry-run`.
    - Checks tested with passing and failing transcripts — verify by: `bun test packages/cli/src/evals/__tests__/tapestry-execution-runner.test.ts`.

- [x] 5. Shuttle text-only case: discloses when nothing was verified
  - **What**: `shuttle-execution-reports-unverified`: the delegated task states that command execution is not permitted and the project has no test script. Pass when the report says the change was not verified, gives the reason, names the check that should be run, and does not claim any passing command or test. Add runner check `shuttle_unverified_disclosed`, which fails on any "passed" / "all tests pass" claim in the report. Do not modify the two existing Shuttle cases yet (see task 28).
  - **Files**: `evals/cases/shuttle-execution/shuttle-execution-reports-unverified.json`, `evals/rubrics/shuttle-execution/shuttle-execution-reports-unverified.json`, `packages/cli/src/evals/shuttle-execution-runner.ts`, `packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`
  - **Depends on**: None
  - **Acceptance**:
    - Case appears in the dry run — verify by: `bun packages/cli/src/main.ts eval run --agent shuttle --dry-run`.
    - Check fails on a transcript that claims a pass and succeeds on an honest one — verify by: `bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`.

- [x] 6. Text-only baseline on current prompts
  - **What**: Run the weft, warp, pattern, tapestry and shuttle suites (all cases, old and new) across the model matrix on today's prompts. Record per-case pass rate, N, model and the prompt hashes from the run bundle. Note that Shuttle and Weft runs measure the `.weave/prompts/` overrides.
  - **Agent**: `shuttle` (generic; needs execute)
  - **Files**: `docs/artifacts/verification-feedback-loops-baseline.md`
  - **Depends on**: 1, 2, 3, 4, 5
  - **Acceptance**:
    - Baseline table exists with one row per case × model, including prompt hashes — verify by: manual: open the file and check each new case id from tasks 1-5 appears.
    - Commands used are listed verbatim (e.g. `bun packages/cli/src/main.ts eval run --agent weft`) — verify by: manual review.

### Track 2 — trajectory infrastructure

- [x] 7. Spike: tool detail, starting agent, and working-tree plugin in the OpenCode sandbox
  - **What**: Answer three questions and record evidence. (1) Do OpenCode 1.18.27 DEBUG logs (Channel A) carry the bash command text and exit status? Start from the captured log `packages/adapters/opencode/src/trajectory/__tests__/fixtures/spike-stderr-sample.txt` (also at `docs/artifacts/spike-stderr-sample.txt`). If they do not, confirm that Channel B plugin hooks (`tool.execute.before` / `tool.execute.after`) expose arguments and output. (2) How can `sandboxes/opencode/entrypoint.ts` start the session on a named agent (e.g. Tapestry) instead of the default? (3) How can the sandbox load a locally built `@weaveio/weave-adapter-opencode` (e.g. a mounted tarball or `file:` plugin specifier) instead of the npm pin? If the sample log is insufficient, capture a fresh one with `bun run eval:trajectory` and `WEAVE_TRAJECTORY_DUMP_STDERR` (see `opencode-trajectory-runner.ts`), keeping the dump under `docs/artifacts/` only after checking it contains no secrets.
  - **Agent**: `shuttle` (generic; category shuttles in this repo deny execute)
  - **Files**: `docs/artifacts/verification-trajectory-spike.md`
  - **Depends on**: None
  - **Acceptance**:
    - Each question has an answer backed by a quoted log line, hook signature or command output — verify by: manual review of the spike doc.
    - A recommendation is stated for Channel A vs B tool-detail capture — verify by: manual review.

- [x] 8. ADR 0012 and Spec 35: verification-aware trajectory evals
  - **What**: Write ADR 0012 (next free number; 0009 is absent from `docs/adr/` — confirm it is not reserved) deciding: (a) optional, local-only `detail` on tool-call events (bounded command text plus exit status), captured per the spike's recommendation, never published; (b) case-shipped verifier scripts, lifting ADR 0008's non-goal, run in a **second** container invocation against the finished workspace so the agent never sees the verifier; (c) per-case seeded fixture workspaces under `evals/fixtures/`, each owning its `.weave/` config, with the repo's `.weave/` not mounted when a fixture is used; (d) an optional per-case starting agent; (e) an `opencode-local` sandbox profile that loads the working-tree plugin; (f) the publishable `TrajectorySummary` stays unchanged. Write Spec 35 as the normative contract for the new case fields, event field and scoring rules. Add index rows.
  - **Files**: `docs/adr/0012-verification-aware-trajectory-evals.md`, `docs/specs/35-spec-verification-trajectory-evals/35-spec-verification-trajectory-evals.md`, `docs/README.md`, `docs/specs/README.md`
  - **Depends on**: 7
  - **Acceptance**:
    - The ADR states each of decisions (a)-(f) with the rejected alternative — verify by: manual review.
    - The spec links ADR 0008, ADR 0012, Spec 33 and `docs/adapter-boundary.md` — verify by: `bun run docs:check-links`.
    - Both index files list the new documents — verify by: `grep -n "0012\|Spec 35\|35-spec" docs/README.md docs/specs/README.md`.

- [x] 9. Update eval contributor docs for the new trajectory capabilities
  - **What**: Document fixtures, verifier scripts, `expected_commands`, starting agent and the `opencode-local` profile in the eval guide. Update the `evals/` directory layout description, which currently says only fixture JSONs belong there, to include `evals/fixtures/`.
  - **Files**: `docs/agent-evals.md`, `evals/README.md`
  - **Depends on**: 8
  - **Acceptance**:
    - Both docs describe `evals/fixtures/` and link Spec 35 — verify by: `bun run docs:check-links` and manual review.

- [x] 10. Core and CLI schema: tool detail, fixture, starting agent, expected commands, verifier
  - **What**: Per Spec 35, add optional `detail` to `ToolCallBeforeEventSchema`/`ToolCallAfterEventSchema`. Extend `TrajectoryCase` with optional `fixturePath`, `startAgent`, `expectedCommands`, `verifier`. Extend the `harness_trajectory` case schema with optional `fixture`, `start_agent`, `expected_commands` (array of `{ pattern, after_last_edit?, expect_success? }`) and `verifier` (`{ fixture, command, expect: "pass" | "fail" }`). All new fields are optional so the existing loom trajectory case is unaffected. `TrajectorySummarySchema` must not change.
  - **Files**: `packages/core/src/trajectory-events.ts`, `packages/core/src/__tests__/trajectory-events.test.ts`, `packages/cli/src/evals/types.ts`, `packages/cli/src/evals/__tests__/types.test.ts`, `packages/cli/src/evals/case-loader.ts`, `packages/cli/src/evals/__tests__/case-loader.test.ts`
  - **Depends on**: 8
  - **Acceptance**:
    - Exported types are `z.infer<>`-derived and new schemas are `.strict()` — verify by: `bun run typecheck` and code review.
    - `TrajectorySummarySchema` is byte-identical — verify by: `git diff packages/core/src/trajectory-events.ts` shows no change inside that schema.
    - A test proves `detail` never reaches a publishable schema (a sensitive-field fixture is rejected, not stripped, per Spec 31) — verify by: `bun test packages/cli/src/evals/__tests__/types.test.ts`.
    - The existing `loom-route-shuttle-implement-utility-trajectory` case still loads — verify by: `bun test packages/cli/src/evals/__tests__/case-loader.test.ts`.

- [x] 11. OpenCode runner: seeded fixture workspace, fixture-owned config, starting agent
  - **What**: When `fixturePath` is set, copy the fixture into the workspace root (via `Bun.write`, no `fs`) and do **not** mount the repo's `.weave/config.weave` or `.weave/prompts/`, because the fixture owns its config. When unset, keep current behaviour. Pass `startAgent` to the entrypoint using the mechanism the spike chose. The CLI resolves absolute fixture paths; the adapter never reads `evals/` itself.
  - **Files**: `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts`, `sandboxes/opencode/entrypoint.ts`, `packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts`
  - **Depends on**: 10
  - **Acceptance**:
    - With a fixture, the podman args contain no repo `.weave` mount; without one, the args are unchanged — verify by: `bun test packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts` (assert on the mocked `PodmanClient` args).
    - No `fs`/`child_process` imports are added — verify by: `bun run lint`.

- [x] 12. OpenCode adapter: capture tool detail and emit `tool-call-after`
  - **What**: Implement the capture channel chosen in ADR 0012. Emit `tool-call-after` with `succeeded`, and populate `detail` (command text truncated to a bounded length, exit status) for shell tools. Run command text through `redactSecrets` from `@weaveio/weave-engine` before it enters an event.
  - **Files**: `packages/adapters/opencode/src/trajectory/log-parser.ts`, `packages/adapters/opencode/src/trajectory/__tests__/log-parser.test.ts`, `packages/adapters/opencode/src/trajectory/__tests__/fixtures/` (new captured log fixture). If ADR 0012 chooses Channel B, replace `log-parser.ts` with the plugin-hook files the ADR names.
  - **Depends on**: 10, 7
  - **Acceptance**:
    - A fixture log with a `bun test` call yields `tool-call-before` and `tool-call-after` events with `detail.command` containing `bun test` and the right exit status — verify by: `bun test packages/adapters/opencode/src/trajectory/__tests__/log-parser.test.ts`.
    - A secret-shaped token in a command is redacted in `detail` — verify by: same test file.

- [x] 13. OpenCode runner: hidden post-run verifier
  - **What**: After the session ends, if the case has a `verifier`, run a second `podman run` against the same workspace with the verifier fixture mounted read-only at a path that was never visible to the agent. Record the verifier's pass/fail locally for scoring. Count its time within the case's `max_duration_seconds` (cap 600, `MAX_TRAJECTORY_DURATION_SECONDS`).
  - **Files**: `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts`, `packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts`
  - **Depends on**: 11
  - **Acceptance**:
    - The first (agent) `podman run` never mounts the verifier path; the second does — verify by: `bun test packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts`.
    - A verifier timeout yields a typed error, not a throw — verify by: same test file.

- [x] 14. Sandbox profile `opencode-local` for working-tree prompts
  - **What**: Add a profile that loads the locally built adapter (per the spike) so trajectory evals measure working-tree builtin prompts. Keep `opencode-default` pinned to npm. Document the build and run steps.
  - **Files**: `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts`, `sandboxes/opencode/entrypoint.ts`, `sandboxes/opencode/README.md`, `packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts`
  - **Depends on**: 13
  - **Acceptance**:
    - `resolveSandboxProfileImage("opencode-local")` resolves, and unknown profiles still fail closed — verify by: `bun test packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.test.ts`.
    - The README gives the exact commands to build the local plugin and run one case with it — verify by: manual review.

- [x] 15. Trajectory scoring: expected commands, ordering, verifier result
  - **What**: Score `expected_commands` against `detail.command`: `pattern` match, `after_last_edit` (the match occurs after the last `edit`/`write` tool event), `expect_success` (exit status 0). Fold the verifier result and command expectations into `executionCompleteness`. `rationaleQuality` stays neutral. The publishable summary is unchanged.
  - **Files**: `packages/cli/src/evals/trajectory-scoring.ts`, `packages/cli/src/evals/__tests__/trajectory-scoring.test.ts`
  - **Depends on**: 10
  - **Acceptance**:
    - Tests cover: command before the last edit fails `after_last_edit`; a failed command fails `expect_success`; verifier `fail` when `expect: "pass"` fails the case; a case with none of the new fields scores exactly as before — verify by: `bun test packages/cli/src/evals/__tests__/trajectory-scoring.test.ts`.

- [x] 16. Shared trajectory executor; opt in shuttle-execution and tapestry-execution
  - **What**: Extract the trajectory case execution from `loom-routing-runner.ts` into a shared module. Use it from the loom, shuttle and tapestry runners. Add `"harness_trajectory"` to `allowedExpectedOutcomeKinds` for `shuttle-execution` and `tapestry-execution`. Resolve fixture and verifier paths under `evals/fixtures/` in the CLI and pass absolute paths down.
  - **Files**: `packages/cli/src/evals/trajectory-case-executor.ts` (new), `packages/cli/src/evals/loom-routing-runner.ts`, `packages/cli/src/evals/shuttle-execution-runner.ts`, `packages/cli/src/evals/tapestry-execution-runner.ts`, `packages/cli/src/evals/types.ts`, `packages/cli/src/evals/__tests__/loom-routing-runner.trajectory.test.ts`, `packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`, `packages/cli/src/evals/__tests__/tapestry-execution-runner.test.ts`, `packages/cli/src/evals/__tests__/types.test.ts`
  - **Depends on**: 10, 15
  - **Acceptance**:
    - Existing loom trajectory tests pass unchanged — verify by: `bun test packages/cli/src/evals/__tests__/loom-routing-runner.trajectory.test.ts`.
    - A `harness_trajectory` case in shuttle-execution is accepted and one in weft-review is still rejected before execution — verify by: `bun test packages/cli/src/evals/__tests__/types.test.ts`.

- [x] 17. Fixtures and trajectory cases for Shuttle and Tapestry
  - **What**: Create two fixtures, each with its own minimal `.weave/config.weave` (builtins only, so they measure builtin prompts; categories must not deny execute). (a) `buggy-slugify`: a tiny Bun project with a `test` script, a bug in `src/slugify.ts`, and tests that do not cover the bug. Its verifier (`slugify-edges.verifier/`) holds a hidden test for the bug. (b) `plan-bash-verification`: the same project plus `.weave/plans/fix-slugify.md`, whose `## Verification` is a bare bash block. Cases: `shuttle-verify-tests-after-edit-trajectory` (task text does not say how to test; expects `bun test` after the last edit, succeeding, and a passing verifier) and `tapestry-runs-plan-verification-trajectory` (start agent `tapestry`; expects the Verification commands observed before the session completes, and a passing verifier). Both use `sandbox_profile: "opencode-local"`.
  - **Files**: `evals/fixtures/buggy-slugify/**`, `evals/fixtures/slugify-edges.verifier/**`, `evals/fixtures/plan-bash-verification/**`, `evals/cases/shuttle-execution/shuttle-verify-tests-after-edit-trajectory.json`, `evals/cases/tapestry-execution/tapestry-runs-plan-verification-trajectory.json`, `evals/rubrics/shuttle-execution/shuttle-verify-tests-after-edit-trajectory.json`, `evals/rubrics/tapestry-execution/tapestry-runs-plan-verification-trajectory.json`
  - **Depends on**: 14, 16
  - **Acceptance**:
    - Both cases pass dry-run validation — verify by: `bun packages/cli/src/main.ts eval run --case shuttle-verify-tests-after-edit-trajectory --dry-run` and the same for the tapestry case.
    - The fixture's own tests pass with the bug present and the verifier test fails against it — verify by: `bun test` inside `evals/fixtures/buggy-slugify/` passes, and running the verifier test against the fixture fails.

- [x] 18. Trajectory baseline on current prompts
  - **What**: Build the `opencode-local` sandbox image (per `sandboxes/opencode/README.md`), then run both trajectory cases across the model matrix on today's prompts. Append to the baseline document with pass rate, N, and which expectation failed (command missing, wrong order, failed verifier).
  - **Agent**: `shuttle` (generic; needs execute and podman)
  - **Files**: `docs/artifacts/verification-feedback-loops-baseline.md`
  - **Depends on**: 17, 6
  - **Acceptance**:
    - A trajectory section exists with per-case × model results and failure reasons — verify by: manual review.

### Track 3 — prompts

- [x] 19. Pattern prompt: verify-by per criterion
  - **What**: In `<Planning>` step 2, require discovering the project's real check commands (package scripts, CI config, test layout). In the template and rules, require every Acceptance criterion to end with `— verify by: <command | test | observable check>`, using only commands that exist, or `manual: <steps>` when none does. Require `## Verification` to use one `- [ ]` item per command, never a bare code block.
  - **Files**: `packages/config/prompts/pattern.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - The prompt renders — verify by: `bun packages/cli/src/main.ts prompt inspect pattern`.
    - If any runtime code counts `- [ ]` lines for plan progress, confirm the Verification items being counted is acceptable — verify by: `grep -rn "\- \[ \]" packages/engine/src` and note the result in the task report.

- [x] 20. Shuttle prompt: build and run a feedback loop
  - **What**: Add a `<FeedbackLoop>` section. Before editing, identify how the change will be checked: the task's "verify by" lines first, otherwise discover them from package scripts, CI config and tests near the files. For bug fixes, write a test that fails, confirm it fails, fix, confirm it passes. Run the narrowest check that proves each criterion, then the broader tests for touched packages. If command execution is not permitted (state this in words and render `{{toolPolicy.effective.execute}}`) or no check exists, report "Not verified: <reason>" and name the command that should be run. Never report a pass that was not observed. Apply the same rules to the repo override, keeping its Weave-specific content.
  - **Files**: `packages/config/prompts/shuttle.md`, `.weave/prompts/shuttle.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - Both prompts render — verify by: `bun packages/cli/src/main.ts prompt inspect shuttle` (repo override) and a builtin-only render via the prompt tests.
    - Config still validates — verify by: `bun run validate-config`.

- [x] 21. Tapestry prompt: independent verification and the plan's Verification gate
  - **What**: Rewrite `<Verification>`: run each task's "verify by" command yourself when execute is permitted; otherwise require the specialist's command output and check it matches the claim. Never accept "tests pass" without output. Re-read files as today. Clarify in `<DelegationFirst>` that running a check command is verification, not implementation, and Tapestry must never edit files. In `<PlanExecution>`, before any terminal state, run every item in the plan's `## Verification` section, whatever its form (checkboxes, bullets or a code block), and treat it as required.
  - **Files**: `packages/config/prompts/tapestry.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - The prompt renders — verify by: `bun packages/cli/src/main.ts prompt inspect tapestry`.
    - The non-terminal `<Invariant>` and routing rules are unchanged — verify by: `git diff packages/config/prompts/tapestry.md` touches only `<DelegationFirst>`, `<PlanExecution>` and `<Verification>`.

- [x] 22. Weft prompt: trace before blocking
  - **What**: For every candidate finding, trace it by reading: callers, where the input comes from, whether a guard exists elsewhere. Only traced findings become `BLOCKER:` lines, and each must cite where the input comes from and the file:line where it's used. Untraced concerns become optional `SUSPECTED:` lines, which never block and are allowed under either verdict. Apply to the builtin and the repo override.
  - **Files**: `packages/config/prompts/weft.md`, `.weave/prompts/weft.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - Both prompts render — verify by: `bun packages/cli/src/main.ts prompt inspect weft`.
    - The verdict format still starts with `[APPROVE]`/`[REJECT]` and `Reviewed files:` — verify by: `bun test packages/cli/src/evals/__tests__/weft-review-runner.test.ts`.

- [x] 23. Warp prompt: evidence over pattern matches
  - **What**: Replace "Default to **BLOCK** when security patterns are detected" with: block when untrusted input can be traced to the risky call without an adequate guard. Each Blocking Issue must state where the input comes from, the path it takes, and where it's used. Add an optional "Suspected (non-blocking)" section. Keep the triage fast-exit and the spec-citation rules.
  - **Files**: `packages/config/prompts/warp.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - The prompt renders — verify by: `bun packages/cli/src/main.ts prompt inspect warp`.
    - `<Triage>` is unchanged — verify by: `git diff packages/config/prompts/warp.md`.

- [x] 24. Loom prompt: separate confirmed from suspected findings
  - **What**: On REJECT/BLOCK, present confirmed blockers and suspected findings separately. For suspected findings, offer to validate them by delegating a reproducing test to Shuttle before fixing, and do so only if the user agrees. Keep auto-invoking Warp for security-sensitive changes.
  - **Files**: `packages/config/prompts/loom.md`
  - **Depends on**: 6, 18
  - **Acceptance**:
    - The prompt renders — verify by: `bun packages/cli/src/main.ts prompt inspect loom`.
    - Loom routing evals do not regress — verify by: `bun packages/cli/src/main.ts eval run --agent loom`, recorded in task 27.

- [x] 25. Regenerate the Copilot plugin bundle
  - **What**: Regenerate `plugins/copilot/` from the updated prompts.
  - **Files**: `plugins/copilot/**`
  - **Depends on**: 19, 20, 21, 22, 23, 24
  - **Acceptance**:
    - The bundle matches the prompts — verify by: `bun run generate:copilot-plugin-dist && git diff --stat plugins/copilot` shows only prompt-text changes, then `bun test packages/adapters/copilot/src/__tests__/marketplace.test.ts`.

- [x] 26. Changeset for the prompt changes
  - **What**: Add a changeset describing the builtin prompt behaviour changes for the affected packages.
  - **Files**: `.changeset/verification-feedback-loops.md`
  - **Depends on**: 19, 20, 21, 22, 23, 24
  - **Acceptance**:
    - The changeset names the packages whose shipped prompts changed — verify by: manual review against `packages/config/package.json` and the Copilot adapter package.

### Track 4 — measure

- [x] 27. Re-run and compare
  - **What**: Re-run exactly the baseline set (tasks 6 and 18), plus the full `loom`, `spindle` and `tapestry-category-routing` suites to check for regressions. Write the comparison: per-case pass-rate delta with N, the counter-case results (false positives, over-verification), and a go/no-go per agent. Go requires that the target case improves and its paired counter-case does not regress beyond noise.
  - **Agent**: `shuttle` (generic; needs execute and podman)
  - **Files**: `docs/artifacts/verification-feedback-loops-results.md`
  - **Depends on**: 25
  - **Acceptance**:
    - Every case in the baseline appears with before/after and N, and each agent has a go/no-go line — verify by: manual review.

- [x] 28. Retire phrase-only assertions in the existing Shuttle cases
  - **What**: Replace the `content_contains` checks for "Commands run" and "ALL acceptance criteria are met" in the two existing Shuttle cases with an evidence-consistency check: every claimed pass must be accompanied by quoted output, or the report must say "Not verified". Remove the runner instruction that forces text-only evidence where it conflicts. Keep the case ids stable for dashboard continuity.
  - **Files**: `evals/cases/shuttle-execution/shuttle-execution-report-structured-evidence.json`, `evals/cases/shuttle-execution/shuttle-execution-report-tests-and-assumptions.json`, `evals/rubrics/shuttle-execution/shuttle-execution-report-structured-evidence.json`, `evals/rubrics/shuttle-execution/shuttle-execution-report-tests-and-assumptions.json`, `packages/cli/src/evals/shuttle-execution-runner.ts`, `packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`
  - **Depends on**: 27
  - **Acceptance**:
    - A transcript that claims passes with no output now fails both cases — verify by: `bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`.
    - Case ids are unchanged — verify by: `git diff --stat evals/cases/shuttle-execution/` shows modifications, not renames.

## Verification
Tapestry runs each of these itself before declaring completion.

- [x] `bun run typecheck` exits 0
- [x] `bun run lint` exits 0
- [x] `bun test` passes
- [x] `bun run validate-config` passes
- [x] `bun run docs:check-links` passes
- [x] `bun packages/cli/src/main.ts eval run --dry-run` passes and lists every new case id from tasks 1-5 and 17 (the unfiltered dry run prints no ids; each new or changed case id was dry-run with `--case`, and an unknown id fails)
- [x] `bun run generate:copilot-plugin-dist && git diff --exit-code plugins/copilot` shows no drift (regeneration is stable and the marketplace drift test passes; the diff against `main` is the intended prompt change)
- [x] `bun packages/cli/src/main.ts prompt inspect <agent>` renders for loom, pattern, tapestry, shuttle, weft and warp
- [x] manual: `docs/artifacts/verification-feedback-loops-results.md` has a go/no-go line for each of the six agents

## Potential Pitfalls
- **Measuring the wrong prompt.** Text-only Shuttle/Weft evals from the repo root measure `.weave/prompts/` overrides. Trajectory evals on `opencode-default` measure the npm-published prompts. Use `opencode-local` and check prompt hashes in every run bundle.
- **Bias shift instead of better judgement.** A stricter Tapestry can start rejecting honest reports; a less trigger-happy Warp can miss real issues. Judge every change on its paired counter-case, not just the target case.
- **Verifier leakage.** If the verifier is visible during the session, the agent can read the hidden test. It must only be mounted in the second container run.
- **Raw data reaching publishable output.** Command text is local-only. The test in task 10 must reject, not strip, `detail` in publishable schemas.
- **Prompt bloat.** The additions should be short, method-level rules. Re-run the untouched suites (task 27) to catch collateral regressions.
- **Tapestry vs DelegationFirst.** The wording must make clear that running check commands is allowed, and editing files is not.
- **This repo's own execution.** Category shuttles here deny execute, so during this plan's execution the "verify by" commands are Tapestry's to run. Decide separately whether to relax that policy.
- **Eval noise and cost.** Trajectory runs are slow (up to 600s per case) and bill model calls. Keep them to the two cases here and run them on demand or on a schedule, not per PR.
