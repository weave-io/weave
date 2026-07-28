# Reference contract: `/goal`

Reference: `~/.pi/agent/extensions/goal/` (`index.ts`, `controller.ts`, `index.test.ts`, `README.md`). This note records the behavior to preserve while porting the command to Weave. The copied execution plan under `.weave/plans/` is coordination-only.

## State and legal transitions

`GoalStatus` has exactly five values:

- `pursuing`
- `paused`
- `blocked`
- `achieved`
- `budget-limited`

The controller's legal transitions are:

- `start`: any existing state (or no state) is replaced by a new `pursuing` state.
- `pursuing -> paused`: `pause(reason?)`; records the reason and folds active time.
- `paused | blocked | budget-limited -> pursuing`: `resume()`; clears the reason and starts a new active period.
- `pursuing -> achieved`: `achieve(evidence)`; records trimmed evidence and clears the reason.
- `pursuing -> blocked`: `block(reason)`; records trimmed reason.
- `pursuing -> budget-limited`: `limitBudget(reason)`; records the budget reason.
- `any existing state -> no state`: `clear()`; folds active time when needed.

All mutators return `boolean`; invalid transitions return `false` and do not change state. `restore` loads a valid snapshot (or clears state) and is not a user transition. State persists as a `goal-state` custom session entry; the last valid snapshot found in the current branch wins.

## Commands and aliases

The six subcommand forms are:

1. `/goal <completion condition>` — start a goal and trigger work.
2. `/goal` — show status.
3. `/goal check` or `/goal status` — show status.
4. `/goal pause` — pause automatic work.
5. `/goal resume [direction]` — resume and optionally queue user direction.
6. `/goal clear` — remove the goal.

The five clear aliases are `stop`, `off`, `reset`, `none`, and `cancel`. Thus there are six *forms* when `check`/`status` are one status form and aliases are not counted as separate forms; counting literal spellings gives more than six. This is the plan's count convention and should not be mistaken for six accepted strings. Control words win over start parsing.

## Lifecycle hooks (actual count: ten)

The plan repeatedly says “all nine lifecycle hooks,” but the reference registers **ten** hooks. This is the count mismatch to preserve explicitly:

- `session_start`: stop/reset the status timer bookkeeping, restore branch state, sync the private tool, and update status.
- `session_tree`: restore the current branch, sync the tool, and update status.
- `before_agent_start`: while pursuing, append the `## Active Goal` prompt block containing `<goal>objective</goal>` and completion-audit instructions.
- `agent_start`: move the pending-continuation flag into the current run and reset the run tool-call flag.
- `turn_start`: remember whether the turn began while pursuing.
- `tool_execution_start`: mark that the current run made a tool call.
- `turn_end`: for a pursuing turn, record one turn and assistant token usage, persist, and refresh status.
- `message_end`: for an aborted assistant message, pause with `Interrupted by the user.`, persist, remove the tool, refresh status, and notify the user.
- `agent_settled`: if pursuing, idle, and no messages are pending, enforce no-tool and budget safety valves or queue the next continuation.
- `session_shutdown`: persist existing state, stop the timer, clear status, and reset status deduplication.

## Continuation and tool contract

The private `goal_report` tool is active only while `pursuing`; it accepts `status: achieved | blocked` and non-empty `evidence`, runs sequentially, and always returns `terminate: true`. Achieved records evidence and reports `Goal achieved.`; blocked records the reason and reports `Goal blocked and paused.`. The tool is added/removed through active-tool synchronization.

A settled pursuing run continues only when the context is idle and has no pending user messages. A continuation is hidden (`goal-continuation`), triggers a turn, and is delivered as a follow-up. The three safety valves are:

- If the previous automatic continuation made no tool call, pause with `Automatic continuation stopped because the last continuation made no tool call.` and notify: `Goal paused because the last continuation made no tool call. Use /goal resume after refining the goal.`
- At `100` continuations (the default maximum), transition to `budget-limited` with `Automatic continuation budget reached (100).` and notify `Goal stopped: ...`.
- If an assistant response ends with `stopReason === "aborted"`, pause with `Interrupted by the user.` and notify `Goal paused after interruption. Use /goal resume to continue.`

Pending user input always prevents continuation. Token usage never limits the goal. The timer refreshes status every 60 seconds only while pursuing; writes are deduplicated and the timer is generation-guarded.

## User-visible status

Status is keyed as `goal`: pursuing uses `◎ goal <elapsed> · <turns>t · <tokens> tok`; achieved uses `✓ goal ...`; all other states use `◇ goal <status> ...`. Bare/status commands show `No goal is set. Use /goal <completion condition>.` or `Goal: <Status>`, `Objective: ...`, elapsed/turn/token metrics, and optional `Evidence:`/`Reason:` lines. Clear says `Goal cleared.`; pause says `Goal paused. Use /goal resume to continue.`; resume says `Goal resumed.` or `Goal resumed with new direction.`. Invalid operations notify the corresponding no-active/no-paused warning without throwing.
