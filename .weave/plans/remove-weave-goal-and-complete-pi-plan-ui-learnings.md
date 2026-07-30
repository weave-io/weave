# Learnings — remove `/weave:goal` and complete the Pi plan UI

## Baseline test state (pre-commit, before Task 2)

The full pre-commit baseline was **7,093 pass, 11 skip, 1 fail**.

The single failure is unrelated to this plan:

- `scripts/release/__tests__/pi-adapter-fake-host-consumer.test.ts` fails because
  the fake Pi host pinned at version `0.81.1` does not export
  `createLsToolDefinition`.

Treat that failure as a known, pre-existing condition. Do not attribute it to
goal removal or to the plan UI work.

## Task 2 — remove the native Pi goal loop

### What the removal boundary already covered

Task 1 (`c72ebd8`) had already removed, from `packages/adapters/pi/src`:

- every `goal-*` import in `extension.ts`
- the `goalController`, `goalFooterCell`, `goalToolRegisteredCell`,
  `goalPendingContinuation`, `goalCurrentContinuation`, `goalRunMadeToolCall`,
  and `goalTurnBeganPursuing` declarations
- `weave:goal` from `commands.ts` (tuple, mutating set, and
  `classifyWeaveGoalInvocation`)
- the fourth `goalOwnsFooter` parameter of `refreshWorkflowTaskStatus`

The result was a source tree that referenced those identifiers without
declaring them, so `bun run typecheck` was the fastest way to find every
remaining goal call site. Run it first on this kind of task.

### What Task 2 removed from `extension.ts`

- `goalOwnsFooter()` and its doc comment; `syncWorkflowTaskFooter` now paints
  the durable workflow footer unconditionally.
- The three `refreshWorkflowTaskStatus(..., goalOwnsFooter())` arguments. The
  helper already took three parameters, so the fourth argument had to go, not
  become `false`.
- The whole `/weave:goal` command branch, including its own health-only gate.
  Health-only gating for the remaining commands still runs through
  `controller.evaluateCommandGate(name)`.
- `PiGoalFooterController` construction, `goalReadSnapshot`,
  `restoreGoalLifecycle`, and the `weave_goal_report` tool registration in
  `session_start`.
- `syncGoalReportToolAvailability`.
- Four whole hooks that existed only for the goal loop: `session_tree`,
  the goal-prompt `before_agent_start`, `turn_start`, `tool_execution_start`,
  the goal-accounting `turn_end`, the abort-pause `message_end`, and the
  continuation `agent_settled`.
- The goal cleanup block in `session_shutdown`.

The telemetry `message_end` hook and the primary-activation
`before_agent_start` hook are separate registrations and stay.

### Hook-count assertions are the real regression detector

`extension.test.ts` asserts the exact sorted list of `pi.on` events. After
removal the list is:

```
agent_start, before_agent_start, input, message_end, model_select,
session_shutdown, session_start
```

`agent_settled`, `session_tree`, `turn_start`, `tool_execution_start`,
`turn_end`, and the duplicate `before_agent_start`/`message_end` entries are
gone. Command counts moved from 13 to 12 direct commands and from 28 to 26
`registerCommand` calls across two installs.

### Files deleted

`goal-args.ts`, `goal-commands.ts`, `goal-footer-controller.ts`,
`goal-plan-resolver.ts`, `goal-session.ts`, `goal-status.ts`, `goal-tool.ts`,
and the seven matching `__tests__/goal-*.test.ts` files.

### Two references outside the stated edit list

Both had to be fixed to keep the tree compiling and clean:

- `workflow-task-status.test.ts` imported `WEAVE_GOAL_STATUS_KEY` from the
  deleted `goal-status.js`. The assertion became "uses its own dedicated status
  key".
- `workflow-task-status.ts` described itself as the counterpart of goal mode in
  its module and constant doc comments.

`extension.test.ts` also held dead goal scaffolding: `installHealthyGoalExtension`
was defined but never called. It was removed, and `goalSnapshot` /
`"weave-goal-command"` were renamed to the neutral `planSnapshotFixture` /
`"weave-plan-command"`.

### Verification observed in this session

- `bun run typecheck` — clean, no errors.
- `bun test` for `commands.test.ts`, `extension.test.ts`, `child-mode.test.ts`,
  `package-consumption.test.ts` — 110 pass, 0 fail.
- `bun test packages/adapters/pi` — 1,135 pass, 0 fail across 71 files.
- `bun run lint` — 1 pre-existing error in
  `packages/adapters/pi/src/__tests__/child-transcript.test.ts:769`
  (`noControlCharactersInRegex`, an ANSI-stripping regex). That file is an
  unrelated dirty edit and was not touched.
- `rg -n 'weave:goal|weave_goal_report|weave-goal-state|weave-goal|goalController|goalFooter' packages/adapters/pi/src`
  returns nothing.
