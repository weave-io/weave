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

## Task 3 — remove goal commands from OpenCode and Claude Code

### Verification observed

- OpenCode tests: 363 pass, 11 skip, 0 fail.
- Claude Code tests: 80 pass, 0 fail.

### Final design

- OpenCode current commands are `start-work` and `weave:start`.
- Claude Code current files are `start.md` and `start-work.md`.
- The old Claude `goal.md` is removed by the existing generic stale sweep, not
  by a dedicated retired-file list.
- No production goal template, export, registration, write, or current-inventory
  entry remains.

### Discrepancy and remediation

The first implementation retained `goal.md` in `commandNames` and added
duplicate retired pruning. The first remediation worker errored without making a
change. The second remediation worker removed both.

### Final source audit

Remaining `goal` mentions are only:

- intentional negative test assertions,
- Claude Code stale-file fixtures and comments,
- one production stale-sweep explanatory comment.

## Task 4 — engine goal module removal

### Pre-deletion consumer proof

A workspace-wide search for `SessionGoal`, `session-goal`, `weave_goal_report`,
`adjudicateSessionGoalCompletion`, and `decideSessionGoalContinuation`
(excluding `dist/`, `dist-types/`, `node_modules/`) matched only:

- the three goal modules themselves,
- their three unit tests,
- the goal export block in `packages/engine/src/index.ts`,
- one historical prose line in `docs/adapters/pi.md` (outside task scope).

The secondary-symbol search (`formatDuration`, `formatTokenCount`,
`countIncompleteLeaves`, `renderGoalPlanBlock`,
`DEFAULT_MAX_GOAL_CONTINUATIONS`, `SESSION_GOAL_STATE_VERSION`,
`parseSessionGoalSnapshot`, `SessionGoalController`) found one extra hit:
`packages/adapters/pi/src/extension.ts` imported `countIncompleteLeaves` from
`@weaveio/weave-engine`. The symbol appeared exactly once in the file, so it was
an unused leftover import from the Task 2 Pi goal removal, not a live consumer.
Removing that import line was required for typecheck after deletion.

### Changes

- Deleted `packages/engine/src/session-goal.ts`,
  `session-goal-plan.ts`, `session-goal-continuation.ts`.
- Deleted `packages/engine/src/__tests__/session-goal.test.ts`,
  `session-goal-plan.test.ts`, `session-goal-continuation.test.ts`.
- Removed only the goal export block from `packages/engine/src/index.ts`.
- Removed the dead `countIncompleteLeaves` import from Pi `extension.ts`.

`selectActivePlanTask`, `PlanTaskSnapshot`, `plan-active-task.ts`,
`plan-state-provider.ts`, and all durable workflow/recovery exports are
unchanged.

### Verification

- `rg -n 'SessionGoal|session-goal|weave_goal_report' packages` (excluding
  `dist/`, `dist-types/`): no matches.
- Engine source imports no harness package: `rg` for
  `@weaveio/weave-adapter*`, `@earendil-works`, `pi-coding-agent` in
  `packages/engine/src` returns nothing.
- `bun test packages/engine/src/__tests__`: 2054 pass, 0 fail, 8364 expect
  calls, 57 files.
- `bun test plan-active-task.test.ts plan-state-provider.test.ts`: 15 pass,
  0 fail, 47 expect calls.
- `bun test packages/adapters/pi/src/__tests__/extension.test.ts`: 73 pass,
  0 fail, 285 expect calls.
- `bun run typecheck`: exit 0 (docs package emits pre-existing hints only).

Unrelated dirty engine and Pi files were left untouched; the only tracked
diffs introduced here are the six deletions plus the two import/export edits.

## Task 5 — coverage audit and verification

### Coverage map

- **Current/recovered parity:** `active-plan-ui-state.test.ts` covers
  `resolves current and recovered workflows through the identical lookup` and
  `cannot retain the previous workflow across a current/recovery transition`;
  `extension.test.ts` adds `renders a recovered plan through the shared widget,
  footer, and Alt+T resolver without resuming`.
- **Shared widget/footer/Alt+T identity:** the resolver's retained identity and
  snapshot tests, the recovered host test above, and the existing stale active
  plan and stale Alt+T generation tests prove that the surfaces use one view and
  reject stale views.
- **Early startup clearing:** `extension.test.ts` adds `clears active-plan
  surfaces before an early startup return`.
- **Failed recovery/read/inspect/snapshot clearing:** the resolver tests cover
  recovery-read, inspect, and snapshot errors plus `clears on demand and is
  idempotent`; the host suite adds `clears active-plan surfaces when a read
  fails through Alt+T`.
- **Terminal settlement and abort/no-active:** the resolver covers terminal
  pointers and empty state; `extension.test.ts` adds `clears active-plan
  surfaces on terminal abort and remains clear with no active workflow`.
- **Generation replacement:** existing `ignores a deferred active-plan result
  from an old generation`, `ignores a deferred Alt+T plan result from an old
  generation`, and `fails closed for retained Alt+T callbacks after
  replacement` cover replacement and stale callbacks.
- **Shutdown:** existing `clears the compact plan widget on session_shutdown`
  covers widget and footer clearing at shutdown.
- **Read-only recovery:** the resolver's `exposes only read methods, so a
  recoverable plan can be shown but never resumed` and the recovered host test's
  unchanged child-process count prove that resolution does not resume execution.

### Verification

- Added only the four missing host-level tests listed above. No production bug
  was exposed. The test setup required an injected in-memory runtime store and
  an explicit abort confirmation; neither was a production change.
- The previous Task 5 delegation returned `completed` without the required
  evidence report. This audit independently checked the map and reran all
  required commands.
- The exact focused command passed with **143 tests passed, 0 failed, and
  567 expect calls**.
- `bunx biome check` passed on the four Task 5 TypeScript files with exit 0;
  it reports seven existing warnings for unused imports, variables, and a
  parameter, but no errors.
- `bun run typecheck` passed with exit 0.
- Host integration wiring/tests remain in the dirty working tree for the next cohesive Pi UI commit because staging them now would absorb unrelated post-baseline work.

## Task 6 — durable-workflow task footer (`weave-task`)

### Discovered bug: the width cap bounded only the title

The first footer implementation computed `budget = MAX - prefix.length` and
truncated *only* the title. When the prefix itself (`▸ task N/M · <id>. `)
was already at or past `WEAVE_WORKFLOW_TASK_STATUS_MAX_WIDTH`, the budget went
to zero and the title was dropped, but the returned string was still
`prefix`-length — so a pathological `taskId`, ordinal, or total pushed the
footer past 56 code points. The Task 5 test only asserted that the title
disappeared, so it passed against the broken bound.

Fix: `renderWorkflowTaskFooter` now bounds the whole normalized string.

- Preferred degradation keeps the full `▸ task N/M · <id>. ` prefix and spends
  the remaining budget on the truncated title.
- When the prefix alone exhausts the budget, the entire footer is truncated to
  56 code points, which keeps the leading `▸ task N/M` visible.
- Exactly one `…` appears in any truncated result.
- `taskId` and `taskTitle` are both whitespace-normalized. An empty ID drops the
  ` · <id>` segment; an empty title drops the `. <title>` segment, so a cleared
  or untitled task never names stale work.
- Theming is unchanged: `fg("accent", text)` is applied once, after bounding,
  and never on the `undefined` clear path.

### Coverage added

- `workflow-task-status.test.ts`: replaced the enormous-ID test with one that
  asserts the *total* code-point bound, single ellipsis, and preserved
  `▸ task 2/5 · ` prefix; added a pathological ordinal/total case; added an
  exhaustive 8×8 sweep over ID and title sizes asserting the bound holds; added
  empty/whitespace title and empty/whitespace ID cases.
- `extension.test.ts`: the shutdown test `clears the compact plan widget on
  session_shutdown` asserted only `weave-plan`. Added the explicit
  `weave-task` clear assertion. This was the only genuinely missing host-level
  footer assertion.

### Host coverage audit (all `weave-task` assertions verified present)

| Scenario | Test | Footer assertion |
| --- | --- | --- |
| Eligible recovery render | `renders a recovered plan through the shared widget, footer, and Alt+T resolver without resuming` | present |
| Early startup return | `clears active-plan surfaces before an early startup return` | present |
| Read error via Alt+T | `clears active-plan surfaces when a read fails through Alt+T` | present |
| Terminal abort + no active workflow | `clears active-plan surfaces on terminal abort and remains clear with no active workflow` | present (twice) |
| Generation replacement | `ignores a deferred active-plan result from an old generation`, `ignores a deferred Alt+T plan result from an old generation` | present |
| Shutdown | `clears the compact plan widget on session_shutdown` | **added in Task 6** |

No production `extension.ts` change was needed: shutdown already clears
`WEAVE_WORKFLOW_TASK_STATUS_KEY`; only the assertion was missing.

The host shutdown assertion remains unstaged for the later cohesive Pi UI integration commit because staging the interleaved file would absorb unrelated work.

### Results

- `bun test packages/adapters/pi/src/__tests__/workflow-task-status.test.ts
  packages/adapters/pi/src/__tests__/active-plan-ui-state.test.ts
  packages/adapters/pi/src/__tests__/extension.test.ts` →
  **137 pass, 0 fail, 620 expect calls, 3 files**. (The Task 5 note claims 143
  tests / 567 expects for the same command; that count was not reproducible
  here and the discrepancy is unexplained — the current number is what this
  session actually observed.)
- `bunx biome check` on the three touched files: **0 errors**, 1 warning
  (pre-existing unused `PiRecoveryPointerStore` / `PiWeaveRecoveryPointerV1`
  type imports in `extension.test.ts`, from unrelated dirty work; the fix is
  marked unsafe, so it was left alone). Formatting fixes were applied with
  `biome check --write`.
- `bun run typecheck` → exit 0 across all packages, no TypeScript errors.
- Nothing committed; unrelated dirty work untouched.

## Task 7 — Rebuild Alt+T as a compliant read-only Pi modal

### What changed

- `packages/adapters/pi/src/plan-task-list.ts` (rewritten): now owns the whole
  Alt+T surface as a real Pi component. New exports:
  `createPlanTaskListComponent()` returning `{ render(width), handleInput(data),
  invalidate() }`, `planTaskListRowBudget(terminalRows)`,
  `planTaskListOffsetForIndex(index, count, rows)`, plus the existing
  `PI_PLAN_TASK_LIST_SHORTCUT`, `planTaskListVisibleRows`,
  `planTaskListMaxScroll`, and `renderPlanTaskListLines` (which now accepts
  optional `width`, `theme`, and `hint`).
- `packages/adapters/pi/src/extension.ts`: deleted `PLAN_TASK_LIST_ROWS = 20`
  and `createPlanTaskListView` (raw `\u001b` / `\u001b[A` / `\u001b[B` / `j` /
  `k` / `q` comparisons). `openPlanTaskList` now builds the component inside
  the `ctx.ui.custom` factory, passing the injected `theme` and `keybindings`
  and a `getTerminalRows` reader over the injected `tui`, and forwards
  `invalidate()` to Pi. Removed the now-unused `PlanTaskSnapshot` type import.
- `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts`: the fake
  `ctx.ui.custom` now injects `terminal: { rows }` on the `tui` object and
  `getKeys()` on the keybindings object (defaulting to Pi's documented
  `tui.select.*` keys), with `host.terminalRows` and
  `host.customKeybindingKeys` for tests to vary.
- Tests: `__tests__/plan-task-list.test.ts` rewritten (32 tests);
  `__tests__/extension.test.ts` gained two host tests
  (`opens, scrolls, and cancels the Alt+T plan list for the current plan`,
  `notifies instead of opening a stale Alt+T modal when no workflow is active`).
- `packages/adapters/pi/src/types.ts` needed no change: `PiUiPort.custom`
  already passes `tui`, `theme`, `keybindings`, and `done` as `unknown`, which
  the extension narrows locally.

### Pi API constraints found (verified against the installed 0.82.x packages)

- `render(width)` must return lines whose `visibleWidth` never exceeds `width`.
  The safe order is **truncate the plain string first, then apply theme
  styling**: ANSI escapes have zero visible width, so styling after
  `truncateToWidth` cannot break the bound. Styling first and truncating after
  would work too, but only because `truncateToWidth` is ANSI-aware; the plain
  path is cheaper and easier to prove.
- `matchesKey(data, keyId)` from `@earendil-works/pi-tui` is typed as
  `(data: string, keyId: KeyId) => boolean`. `KeyId` is a template-literal
  union, so binding key arrays must be typed `readonly KeyId[]`, not
  `readonly string[]`, or `bun run typecheck` fails with TS2345.
- The injected keybindings object is a `KeybindingsManager`, which exposes both
  `matches(data, binding)` and `getKeys(binding): KeyId[]`. `getKeys` is what
  makes user configuration observable in the rendered hint, so the component
  reads keys once and matches against them. It uses Pi's documented defaults
  (`up`, `down`, `escape`/`ctrl+c`) only when no keybinding manager or
  `getKeys` function is available; an available `getKeys` that returns `[]`
  intentionally leaves that action unbound.
- The injected `theme` may be a partial object in non-Pi hosts (the fake host
  passes `{}`). `theme.fg` and `theme.bold` are therefore probed with `typeof
  ... === "function"` and the component degrades to unstyled text instead of
  throwing mid-render. This was a real failure: three host tests crashed with
  `theme.fg is not a function` before the guard was added.
- `invalidate()` is called by Pi on theme change and must drop cached *themed*
  strings, not just a line array. The component's cache key is `(width, rows)`
  and `invalidate()` clears all three cached fields, so a theme swap rebuilds
  every styled line.
- Terminal height is read from `tui.terminal?.rows` on every render, so a
  resize re-budgets the viewport instead of serving a stale window.

### Row budgeting

`planTaskListRowBudget(terminalRows)` = `clamp(terminalRows - 6 host rows,
MIN_VISIBLE_ROWS + 4 chrome rows, MAX_VISIBLE_ROWS + 4 chrome rows)` = a value
in `[7, 28]`, falling back to 24 terminal rows (→ 18) when the host reports
nothing usable. `planTaskListVisibleRows(rows)` = `clamp(rows - 4, 3, 24)`.
The result: a 4-row terminal still scrolls 3 tasks, and a 400-row terminal is
capped at 24 task rows rather than becoming a full-screen takeover.

### Behaviour notes

- The popup opens scrolled so the active task (from the shared
  `selectActivePlanTask` resolver) is inside the first window.
- Cancel is guarded by a `cancelled` flag, so `done(undefined)` fires exactly
  once, and later input is ignored.
- The stale-generation branch in `extension.ts` returns **without** calling
  `done(undefined)`. Calling `done` there breaks
  `fails closed for retained Alt+T callbacks after replacement`, which asserts a
  retained old component changes no counters including `customDoneCalls`: a
  replaced generation must not settle a promise the current generation owns.
- Nothing in this surface mutates state: no execution starts or resumes, and no
  interval or polling loop exists.

### Results

- `bun test packages/adapters/pi/src/__tests__/plan-task-list.test.ts
  packages/adapters/pi/src/__tests__/active-plan-ui-state.test.ts
  packages/adapters/pi/src/__tests__/workflow-task-status.test.ts
  packages/adapters/pi/src/__tests__/extension.test.ts` →
  **171 pass, 0 fail, 1012 expect calls, 4 files** (plan-task-list 32,
  extension 106).
- `bunx biome check` on `plan-task-list.ts`, `plan-task-list.test.ts`, and
  `fake-pi-host.ts` → **clean, 0 errors, 0 warnings** (formatting applied with
  `--write`). `extension.ts` + `extension.test.ts` → 0 errors, 7 warnings, all
  pre-existing unrelated dirty work (unused child-inspector/recovery imports,
  `WEAVE_CHILD_TREE_WIDGET_KEY`, `WeaveChildTreeEditor`, `readPlanSnapshot`,
  and a `defaultInput` parameter). Removing the `PlanTaskSnapshot` import this
  task orphaned took the count from 8 to 7.
- `bun run typecheck` → exit 0 across all packages.
- Nothing committed; unrelated dirty work untouched.

### Task 7 retry — respect intentionally empty injected keybindings

The verification gap was that the original test named `when the host resolves no
keys` injected `getKeys: () => []` but expected Pi's defaults. It did not verify
that missing keybinding managers or missing `getKeys` functions are the only
fallback cases, and it did not prove that an intentionally empty binding is
unbound.

The fix makes the injected manager authoritative: `resolveKeys` uses documented
Pi defaults only when the manager or its `getKeys` function is unavailable. When
the function is present, its result is used, with an undefined result treated as
no keys. The hint now labels empty actions as `unbound` instead of claiming that
the disabled default is active. Tests cover default fallback, alternate
`matchesKey()` bindings, and empty up/down/cancel bindings that ignore default
raw keypresses without cancelling.

Retry verification observed in this session:

- The required four-file Bun test command → **172 pass, 0 fail, 1,020 expect
  calls, 4 files**.
- `bunx biome check packages/adapters/pi/src/plan-task-list.ts
  packages/adapters/pi/src/__tests__/plan-task-list.test.ts` → clean; no fixes
  applied.
- `bun run typecheck` → exit 0 across all packages. The docs package emitted
  existing hints only.
- Nothing committed; no stash used; unrelated dirty work untouched.

### Process warning for later tasks

`git stash push --keep-index --include-untracked` was run in this session while
trying to produce a lint baseline and it stashed the entire in-progress Task 7
change set, including the untracked component file. It was recovered
immediately with `git stash pop` and verified byte-for-byte, but **do not run
`git stash` in this repository while the plan's dirty work is unstaged**; use
`git show HEAD:<path>` piped into `biome check --stdin-file-path=<path>` for a
baseline instead.

### Task 7 safe partial-commit boundary

The extension host wiring/tests and fake-host support are intentionally deferred
to the later cohesive Pi UI integration commit because those files contain
unrelated pre-existing work; this commit stages only the standalone component,
its unit tests, and these learnings.
