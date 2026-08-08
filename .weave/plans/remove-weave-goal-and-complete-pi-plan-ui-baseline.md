# Baseline and removal contract — remove `/weave:goal`, complete the Pi plan UI

Task 1 of 10. This file is an inventory and baseline record only. No production or docs
file is modified by this task.

## 1. Worktree baseline

| Item | Value |
| --- | --- |
| Branch | `main` |
| HEAD | `e70f77f` |
| Pre-task diff | `/tmp/remove-weave-goal-task1-before.diff` |
| Pre-task diff scope | affected paths only (see capture command below) |
| Pre-task diff size | 4,448 lines |
| Changed tracked files in scope | 28 (`2,566 insertions`, `322 deletions`) |

The baseline diff is path-scoped to the surfaces this initiative touches. It was captured
with exactly this command:

```bash
git diff -- packages/adapters/pi packages/adapters/opencode packages/adapters/claude-code \
  packages/engine/src docs/adapters \
  packages/docs/src/content/docs/docs/reference/adapters \
  .changeset/weave-goal-command.md > /tmp/remove-weave-goal-task1-before.diff
```

The result is **4,448 lines**, which matches the size the plan quoted. A whole-worktree
`git diff` is larger (it also covers `packages/core`, `packages/config`, `packages/cli`,
and unrelated docs); that wider diff is not the baseline for this initiative.

### Dirty-worktree constraint

The checkout was already dirty before this task. Unrelated in-flight work must not be
touched, reverted, or committed. Later tasks must diff against
`/tmp/remove-weave-goal-task1-before.diff`, not against a line count.

Pre-existing dirty work that is **not** part of goal removal (do not disturb):

- Pi child-inspection work: `child-inspection-*.ts`, `child-native-components.ts`,
  `child-session-events.ts`, `child-transcript.ts`, `child-tree.ts`, `agent-cycle.ts`,
  `delegation-controller.ts`, `delegation-tool.ts`, plus `scripts/release/pi-child-inspection-smoke.ts`.
- DSL / prompt / category-shuttle work in `packages/core`, `packages/config`,
  `packages/engine/src/compose.ts`, `packages/engine/src/descriptors.ts`, `packages/cli`,
  and the matching docs (`docs/reference/dsl.md`, `docs/reference/prompts.md`,
  `docs/reference/models.md`, `docs/adr/0001-*`, `docs/contributing/builtin-prompts.md`).
- `.weave/config.weave`, `.weave/plans/weave-pi-child-inspection.md`.

Untracked files present before this task (also unrelated, keep):
`packages/adapters/pi/src/child-native-components.ts`, `plan-task-list.ts`,
`workflow-task-status.ts`, and their tests, plus
`packages/config/src/__tests__/category-shuttle-descriptions.test.ts` and
`packages/adapters/pi/src/__tests__/child-inspection-custom.test.ts`.

Note: `plan-task-list.ts` and `workflow-task-status.ts` are new untracked Pi plan-UI
modules. They are **retained and extended** by this initiative, not removed.

## 2. Removal boundary (pinned contract)

- `/weave:start` is the **sole plan executor**. All plan execution intent that currently
  flows through `/weave:goal` must land on `/weave:start`.
- `/weave:run` remains **explicit named-workflow execution**. Its scope does not change.
- `/weave:goal` and its whole native Pi loop are removed, not re-homed.
- The degraded `/weave:goal` projections in OpenCode and Claude Code are removed, not
  rewritten, because there is no longer a Pi behavior for them to project.
- No goal-shaped replacement command, tool, footer key, or session entry type is added.

## 3. Classification

Legend: **REMOVE-PI** = Pi-only native goal surface. **REMOVE-DEGRADED** = degraded
adapter projection. **RETAIN** = shared plan/workflow behavior that stays.
**GENERATED** = build output, never hand-edited.

### 3.1 Commands and palette entries — REMOVE-PI

| Location | Reference |
| --- | --- |
| `packages/adapters/pi/src/commands.ts:24,49` | `"weave:goal"` in the command name lists (currently described as "the thirteen `/weave:*` direct commands") |
| `packages/adapters/pi/src/commands.ts:1` | `import type { WeaveGoalArgs }` |
| `packages/adapters/pi/src/commands.ts:71-73` | `classifyWeaveGoalInvocation` |
| `packages/adapters/pi/src/extension.ts:1277-1278` | palette description `"Manage the active session goal"` for `case "weave:goal"` |
| `packages/adapters/pi/src/extension.ts:2199-2227` | `if (name === "weave:goal")` dispatch branch |

The command-count prose in `commands.ts` ("thirteen") must be decremented.

### 3.2 Pi goal modules — REMOVE-PI (delete whole files)

| File | Size | Role |
| --- | --- | --- |
| `packages/adapters/pi/src/goal-args.ts` | 1.6K | `parseWeaveGoalArgs`, `WeaveGoalArgs` |
| `packages/adapters/pi/src/goal-commands.ts` | 9.4K | `handleWeaveGoal` |
| `packages/adapters/pi/src/goal-footer-controller.ts` | 6.8K | `PiGoalFooterController` |
| `packages/adapters/pi/src/goal-plan-resolver.ts` | 1.5K | `resolveGoalPlan`, `ResolveGoalPlanInput` |
| `packages/adapters/pi/src/goal-session.ts` | 1.4K | `persistGoalState`, `restoreGoalState`, `WEAVE_GOAL_STATE_ENTRY_TYPE` |
| `packages/adapters/pi/src/goal-status.ts` | 5.6K | `renderGoalFooter`, `WEAVE_GOAL_STATUS_KEY`, `WEAVE_GOAL_STATUS_MAX_WIDTH` |
| `packages/adapters/pi/src/goal-tool.ts` | 6.3K | `buildWeaveGoalReportToolRegistration`, `syncWeaveGoalReportToolAvailability`, `WEAVE_GOAL_REPORT_TOOL_NAME` |

### 3.3 Pi extension lifecycle hooks — REMOVE-PI (surgical edits in `extension.ts`)

Engine imports at lines 18, 23, 26 (`decideSessionGoalContinuation`,
`renderGoalPlanBlock`, `SessionGoalController`) and adapter imports at lines 110,
141-148.

Extension-local goal state (lines ~1833-1843): `goalController`, `goalFooterCell`,
`goalTurnBeganPursuing`, `goalRunMadeToolCall`, `goalCurrentContinuation`,
`goalPendingContinuation`, `goalToolRegisteredCell`.

Hooks and helpers to remove:

| Lines | Hook / helper |
| --- | --- |
| 357, 361 | test seams for goal plan state and durable-workflow goal suspension |
| 1455-1467 | `goalOwnsFooter` parameter threading into the durable footer writer |
| 1941-1968 | `goalOwnsFooter()` and footer-ownership refresh |
| 3064-3115 | `goalReadSnapshot`, `PiGoalFooterController` construction, `restoreGoalLifecycle` call, goal tool registration |
| 3441, 3479 | `goalOwnsFooter()` call sites |
| 3921-3931 | `syncGoalReportToolAvailability` |
| 3934-3974 | `restoreGoalLifecycle` |
| 3976 | session-restore hook calling `restoreGoalLifecycle` |
| 3980-3998 | system-prompt injection of the `## Active Goal` block |
| 4007-4021 | turn-begin / tool-call bookkeeping |
| 4025-4056 | turn-end `recordTurn` + `persistGoalState` |
| 4060-4087 | abort handling (`pause("Interrupted by the user.")`) |
| 4094-4217 | continuation decision, auto-continuation send (`customType: "weave-goal-continuation"`), status adjudication, notices |
| 4274-4290 | dispose/teardown clearing goal state, footer, and the `weave_goal_report` active tool |

Footer-ownership consequence: once goal mode is gone, the durable workflow footer is the
only owner. The `goalOwnsFooter` switch, the suppression branch, and the comments at
`extension.ts:1455-1467`, `1941-1968` collapse to unconditional rendering.
`packages/adapters/pi/src/workflow-task-status.ts:5,19` carries comments that reference
`WEAVE_GOAL_STATUS_KEY`; those comments must be rewritten, but the module is RETAIN.

### 3.4 Persistence — REMOVE-PI

- Session entry type `"weave-goal-state"` (`goal-session.ts:13`), appended at
  `goal-session.ts:23` and `goal-commands.ts:59`.
- Status key `"weave-goal"` (`goal-status.ts:10`).
- Prompt custom type `"weave-goal-continuation"` (`extension.ts:4143`).
- Engine snapshot version `SESSION_GOAL_STATE_VERSION = 1` (`session-goal.ts:3`).

There is no database migration to write: goal state lives in the Pi session transcript,
not the Runtime Store. Restore of an old session containing `weave-goal-state` entries
must simply ignore them, which is the default once `restoreGoalState` is deleted.

### 3.5 Tools — REMOVE-PI

`weave_goal_report` (`goal-tool.ts:17,87-104`), including its availability sync at
`extension.ts:3102-3115`, `3921-3931`, `4283-4285`.

### 3.6 Engine modules — REMOVE-PI (goal-only, no shared consumer)

| File | Exports |
| --- | --- |
| `packages/engine/src/session-goal.ts` | `SessionGoalError`, `SessionGoalSnapshot`, `SessionGoalState`, `SessionGoalStatus`, `DEFAULT_MAX_GOAL_CONTINUATIONS`, `formatDuration`, `formatTokenCount`, `parseSessionGoalSnapshot`, `SESSION_GOAL_STATE_VERSION`, `SessionGoalController` |
| `packages/engine/src/session-goal-continuation.ts` | `SessionGoalContinuationDecision`, `SessionGoalContinuationInput`, `decideSessionGoalContinuation` |
| `packages/engine/src/session-goal-plan.ts` | `AdjudicateSessionGoalCompletionInput`, `SessionGoalReportedStatus`, `SessionGoalVerdict`, `adjudicateSessionGoalCompletion`, `countIncompleteLeaves`, `renderGoalPlanBlock` |

Caution — verified consumers of the generic helpers inside these modules:

- `formatDuration` and `formatTokenCount` (`session-goal.ts`) have **no consumer outside
  goal code**. Only `packages/engine/src/index.ts:490-491` re-exports them. Safe to delete
  with the module, unless a later plan-UI task wants them; in that case relocate them to a
  neutral engine module instead of deleting.
- `countIncompleteLeaves` (`session-goal-plan.ts`) is used at
  `packages/adapters/pi/src/extension.ts:16` and `:3991`, but only inside the `## Active
  Goal` prompt block that is itself being removed. After that block goes, the only
  remaining reference is the re-export at `index.ts:508`. If the completed Pi plan UI needs
  a remaining-leaf count, relocate `countIncompleteLeaves` to a neutral plan module rather
  than deleting it.

### 3.7 Engine exports — REMOVE-PI

`packages/engine/src/index.ts:483-509` (the three `session-goal*` export blocks).
Line 230 `export { selectActivePlanTask } from "./plan-active-task.js"` is **RETAIN**.

### 3.8 Degraded adapter projections — REMOVE-DEGRADED

OpenCode:

| Location | Reference |
| --- | --- |
| `packages/adapters/opencode/src/command-templates.ts:101` | `GOAL_EXECUTION_INSTRUCTIONS` |
| `packages/adapters/opencode/src/command-templates.ts:159-167` | `/weave:goal` template + `renderCommandEnvelope("weave:goal")` |
| `packages/adapters/opencode/src/plugin.ts:339` | comment listing `/start-work`, `/weave:start`, `/weave:goal` |
| `packages/adapters/opencode/src/plugin.ts:359` | `cfg.command["weave:goal"] = { ... }` |
| `packages/adapters/opencode/src/plugin.ts:366` | log payload `commands: ["start-work", "weave:start", "weave:goal"]` |

Claude Code:

| Location | Reference |
| --- | --- |
| `packages/adapters/claude-code/src/command-templates.ts:117-139` | `CC_WEAVE_GOAL_COMMAND`, `WEAVE_GOAL_PLAN_PATH` |
| `packages/adapters/claude-code/src/adapter.ts:25` | `CC_WEAVE_GOAL_COMMAND` import |
| `packages/adapters/claude-code/src/adapter.ts:272` | `writeFile(join(commandsDir, "goal.md"), CC_WEAVE_GOAL_COMMAND)` |

Materialization consequence: Claude Code stops emitting `.claude/commands/goal.md`.
`start.md` (line 265) and `start-work.md` (line 269) are **RETAIN**. Stale
already-materialized `goal.md` files in user projects are out of scope for this
initiative unless a later task adds cleanup.

### 3.9 Tests

Dedicated goal tests — REMOVE:

- `packages/adapters/pi/src/__tests__/goal-args.test.ts`
- `packages/adapters/pi/src/__tests__/goal-commands.test.ts`
- `packages/adapters/pi/src/__tests__/goal-footer-controller.test.ts`
- `packages/adapters/pi/src/__tests__/goal-plan-resolver.test.ts`
- `packages/adapters/pi/src/__tests__/goal-session.test.ts`
- `packages/adapters/pi/src/__tests__/goal-status.test.ts`
- `packages/adapters/pi/src/__tests__/goal-tool.test.ts`
- `packages/engine/src/__tests__/session-goal.test.ts`
- `packages/engine/src/__tests__/session-goal-continuation.test.ts`
- `packages/engine/src/__tests__/session-goal-plan.test.ts`

Tests with goal references to prune while keeping the rest — EDIT:

- `packages/adapters/pi/src/__tests__/commands.test.ts` (command list, count, classifier)
- `packages/adapters/pi/src/__tests__/extension.test.ts` (goal lifecycle assertions)
- `packages/adapters/pi/src/__tests__/child-mode.test.ts` (goal inertness in child mode)
- `packages/adapters/pi/src/__tests__/package-consumption.test.ts` (exported goal surface)
- `packages/adapters/opencode/src/__tests__/plugin.test.ts` (registered command set)
- `packages/adapters/opencode/src/__tests__/capability-declarations.test.ts`
- `packages/adapters/claude-code/src/__tests__/adapter.test.ts` (emitted `goal.md`)
- `packages/adapters/claude-code/src/__tests__/capability-declarations.test.ts`

Tests that match `goal` only as the English word or an unrelated identifier — VERIFY,
likely no change: the `workflow-*`, `child-inspection-*`, `step-prompt-*`,
`execution-lifecycle*`, `runtime-*`, `artifact-*`, `start-plan`, `status-control`,
`run-workflow`, `runtime-command-projection`, and `start-plan-execution` suites.

New coverage required (later tasks): `/weave:goal` is rejected as unknown; the durable
workflow footer renders unconditionally; the retained plan UI covers what goal mode used
to show.

### 3.10 Docs — source files to edit

| File | Lines |
| --- | --- |
| `docs/adapters/pi.md` | 73, 82, 84, 86 |
| `docs/adapters/opencode.md` | 45 |
| `docs/adapters/claude-code.md` | 34 |
| `packages/docs/src/content/docs/docs/reference/adapters/pi.mdx` | 39, 43, 45, 47 |
| `packages/docs/src/content/docs/docs/reference/adapters/opencode.mdx` | 41, 43 |
| `packages/docs/src/content/docs/docs/reference/adapters/claude-code.mdx` | 22 |

Docs must be reworded so `/weave:start` is named as the sole plan executor and
`/weave:run` as explicit named-workflow execution. Any command counts in prose need
updating. Non-doc references also exist in `.codesight/CODESIGHT.md` and
`.codesight/libs.md`; treat those as generated or tool-owned caches, out of scope for
hand edits.

### 3.11 Changeset

`.changeset/weave-goal-command.md` announces the feature being removed. It names
`@weaveio/weave-engine`, `@weaveio/weave-adapter-pi`, `@weaveio/weave-adapter-opencode`,
and `@weaveio/weave-adapter-claude-code` as `minor`. Because the feature never shipped
in a release, delete this changeset and add a single new changeset describing the removal
and the completed Pi plan UI.

## 4. RETAIN — explicitly out of scope for removal

| Surface | Location |
| --- | --- |
| `selectActivePlanTask` | `packages/engine/src/plan-active-task.ts`, exported at `index.ts:230` |
| Plan state provider | `packages/engine/src/plan-state-provider.ts` |
| Plan snapshots and providers (Pi) | `packages/adapters/pi/src/plan-catalog.ts`, `plan-provider.ts`, `plan-render.ts`, `plan-task-list.ts` |
| Workflow task status footer | `packages/adapters/pi/src/workflow-task-status.ts` |
| Workflow controller and commands | `packages/adapters/pi/src/workflow-controller.ts`, `workflow-commands.ts` |
| Runtime Store, recovery pointers, leases, reconciliation | `packages/engine/src/runtime-*`, `execution-lifecycle*` |
| Runtime command operations, incl. `startPlan`, `runWorkflowLifecycle`, `runtimeHealth` | `packages/engine/src/runtime-command-operations/*`, exported at `index.ts:478-481` |
| `/weave:start` | `commands.ts:15,44`; `extension.ts:1271`, `2329` |
| `/weave:run` | `commands.ts:16,45`; `extension.ts:1273`, `2387` |
| Claude Code `start.md`, `start-work.md` | `packages/adapters/claude-code/src/adapter.ts:265,269` |
| OpenCode `/start-work`, `/weave:start` registrations | `packages/adapters/opencode/src/plugin.ts:339-366` (keep, drop only the goal entry) |

## 5. GENERATED — identified and excluded from hand edits

Build outputs must be regenerated by `bun run build`, never edited by hand.

Directories: `packages/{core,config,engine,cli,docs}/dist`,
`packages/{cli}/dist-types`, `packages/adapters/{pi,opencode,claude-code}/dist`,
`packages/adapters/{pi,opencode,claude-code}/dist-types`.

Generated files that currently contain goal references:

- `packages/engine/dist/index.js`, `dist/index.d.ts`, `dist/session-goal.js`,
  `dist/session-goal.d.ts`, `dist/session-goal-continuation.js`,
  `dist/session-goal-continuation.d.ts`, `dist/session-goal-plan.js`,
  `dist/session-goal-plan.d.ts`
- `packages/adapters/pi/dist/extension.js`, `dist/index.js`, `dist/index.d.ts`
- `packages/adapters/pi/dist-types/commands.d.ts`, `goal-args.d.ts`,
  `goal-commands.d.ts`, `goal-footer-controller.d.ts`, `goal-session.d.ts`,
  `goal-status.d.ts`, `goal-tool.d.ts`, `untrimmed-index.d.ts`
- `packages/adapters/opencode/dist/index.js`, `dist/plugin.js`,
  `dist-types/command-templates.d.ts`
- `packages/docs/dist/docs/reference/adapters/{pi,opencode,claude-code}/index.html`

## 6. Verification commands for later tasks

```bash
bun run typecheck
bun run lint
bun test
bun run validate-config
bun run docs:check-links
rg -n 'weave:goal|weave_goal_report|SessionGoal|session-goal|weave-goal' \
  packages/*/src packages/adapters/*/src docs packages/docs/src .changeset
```

The final `rg` must return no source, docs, or changeset hits. Hits under `dist/`,
`dist-types/`, and `.codesight/` are acceptable until a rebuild.

## 7. Commit handling

Do not commit in this task. The coordinator verifies and commits.
