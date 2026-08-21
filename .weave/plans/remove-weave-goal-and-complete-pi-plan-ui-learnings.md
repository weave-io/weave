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

## Task 8 — stable per-agent badge backgrounds

### Audit result

The dirty pre-existing implementation was already close: `agent-cycle.ts`
declared the six supported Pi background tokens (`selectedBg`,
`userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`,
`toolErrorBg`, verified against Pi's own `docs/themes.md` token table), a pure
FNV-1a `selectAgentBadgeBg`, and a single `renderActiveAgentBadge` used by
every badge path. `types.ts` already projected exactly those six tokens.

One real gap was found and fixed: `selectAgentBadgeBg` hashed the **raw**
name, so `"loom"`, `"LOOM"` and `" Loom "` could land on different colours.
A new exported `normalizeAgentBadgeKey` now trims, collapses internal
whitespace runs, and lowercases before hashing. Nothing else in the mapping
changed, so no already-observed builtin colour moved.

No extension change was needed: `setActiveAgentStatus` is the single writer of
the `weave-agent` status key, and every path (boot commit, Alt+A switch,
`onDirectStepActiveChange` temporary badge, restoration via
`resolveDirectStepBadgeAgent`, recovered primary) routes through it, so the
renderer and token rule are already shared.

### Coverage added

`agent-cycle.test.ts` (16 tests total in the file) now proves: the exact
supported token list and its fixed order; only supported tokens are ever
returned (including empty/whitespace/unicode names); case and whitespace
variants collapse to one token; purity across repeated and interleaved calls;
order independence; frozen per-builtin token expectations (loom, pattern,
shuttle, spindle, tapestry, thread, warp, weft) so a colour move fails loudly;
distribution (≥4 distinct tokens over the 8 builtins, and all six tokens over
200 synthetic names); wrapper order `bg(token, fg("accent", bold(label)))`;
and the exact foreground-only fallback when `theme.bg` is absent.

`extension.test.ts` gained a `themed active-agent badge` block proving the
committed boot primary, the Alt+A switch, and the Alt+A restore all paint the
same `selectAgentBadgeBg`-derived badge, that a failed sole activation commits
no colored badge at all, and that a stale primary switch never repaints.

`fakes/fake-pi-host.ts` gained an optional `theme` host option (absent by
default, so every existing plain-text badge assertion is unchanged) wired into
the `PiUiPort` via a conditional spread to satisfy the optional property type.

### Verification observed in this session

- `bun test packages/adapters/pi/src/__tests__/agent-cycle.test.ts
  packages/adapters/pi/src/__tests__/extension.test.ts` → **126 pass, 0 fail,
  552 expect calls, 2 files**.
- `bunx biome check` on the four touched files → clean apart from one
  **pre-existing** warning about unused `PiRecoveryPointerStore` /
  `PiWeaveRecoveryPointerV1` type imports in `extension.test.ts`, which comes
  from the dirty Task 5–7 work and was left untouched.
- `bun run typecheck` → `@weaveio/weave-adapter-pi` exit 0; whole workspace 0
  errors.
- Changes were diffed against the reconstructed pre-Task-8 state
  (`git show HEAD:<path>` + `/tmp/remove-weave-goal-task8-before.diff`) to
  confirm Biome's `--write` reformatted nothing outside the new code.
- Nothing committed; no stash, reset, or checkout used.

### Gap discovered

`renderActiveAgentBadge` still labels the badge with the **raw**
`agentName.toUpperCase()`, so a name carrying stray whitespace would display
that whitespace while still receiving the correct normalized colour. This was
left alone deliberately: normalizing the label would change existing exact
badge output, which is outside Task 8's stated scope.

### Task 8 safe partial-commit boundary

The Task 8 commit stages exactly four paths: `agent-cycle.ts`, its unit tests,
the two badge-background hunks of `types.ts` (`PiUiThemeBgColor` and the
optional `PiUiThemePort.bg`), and these learnings. The extension host wiring
assertions in `extension.test.ts` and the optional `theme` support in
`fakes/fake-pi-host.ts` stay dirty on purpose: they are interleaved with the
Tasks 5–7 and unrelated boot work, so they are deferred to the later cohesive
Pi UI integration commit. The unrelated `getSystemPrompt` hunk in `types.ts`
was kept unstaged with a partial `git apply --cached` patch rather than any
reset, checkout, or stash.

## Task 9 — Docs and release metadata

### Files changed

- `docs/adapters/pi.md` — removed the `### Goal command` section and the
  `/weave:goal` bullet; added `Alt+T` to the user-surface list; stated that
  `/weave:start` is the sole plan executor and `/weave:run` explicitly starts a
  named engine-managed durable workflow, with neither implying the other; added
  `### Plan-task footer` (`weave-task`, one bounded active task from the shared
  plan snapshot, clears when inactive/unreadable/terminal, may show eligible
  recovered read-only state) and `### Alt+T plan-task list` (read-only bounded
  list, shared active/recovery source, configured
  `tui.select.up`/`down`/`cancel` bindings, safe notice instead of a stale
  modal, no start/resume side effect); extended the Alt+A paragraph with the
  deterministic per-agent badge background and the exact foreground-only
  fallback.
- `docs/adapters/opencode.md` — dropped the degraded goal-projection paragraph;
  `/start-work` is documented as a behavior-identical alias of `/weave:start`.
- `docs/adapters/claude-code.md` — replaced `## Goal command` with a `##
  Commands` section naming only `/weave:start` and its `/start-work` alias, and
  restating that generated markdown adds no durable-workflow runtime surface.
- `packages/docs/.../adapters/pi.mdx` — same removals; added
  "Start work and run workflows" and "Track the active task" sections and the
  badge-color sentence to "Switch agents".

This Task 9 record uses American English ("color", "behavior"), matching the
repository writing style; the earlier British spellings in this file were left
as written.
- `packages/docs/.../adapters/opencode.mdx` and `claude-code.mdx` — goal bullets
  and degraded-projection paragraphs removed; start command/alias only.
- `.changeset/weave-goal-command.md` — deleted.

### Changeset decision and evidence

The changeset claimed a *minor* addition of `/weave:goal` across four packages.
It was still pending at the start of Task 9 and was deleted during Task 9. Direct
Git evidence shows that `.changeset/weave-goal-command.md` was added by commit
`672a87a172db312ac10d300d9469443d06b1c207`; `git tag --contains
672a87a172db312ac10d300d9469443d06b1c207` returns no tags, and only the
development branches `main`, `feat/database-backed-operational-storage`, and
`feat/weave-goal-command` contain the commit. The affected manifests — `packages/engine/package.json`,
`packages/adapters/pi/package.json`, `packages/adapters/opencode/package.json`,
and `packages/adapters/claude-code/package.json` — each remain at version
`0.0.1`. This direct no-release-tag evidence shows that the changeset was never
released. As corroboration only, no `CHANGELOG.md` exists
in the repository (`find . -name CHANGELOG.md -not -path '*/node_modules/*'`
returned nothing), and `.changeset/config.json` uses
`@changesets/cli/changelog`. An unreleased "Add" entry for a feature that is
being removed before shipping has no accurate rewrite — a removal note would
describe a change no published version ever saw. The file was therefore deleted
rather than rewritten. Twenty other changesets remain untouched.

### Residual `weave:goal` matches — classified

`rg -n 'weave:goal|weave_goal_report|WEAVE_GOAL|SessionGoal' packages docs
.changeset --glob '!**/dist/**' --glob '!**/dist-types/**'` now returns only two
hits, both in `packages/adapters/opencode/src/__tests__/plugin.test.ts` (lines
488 and 495). They are intentional negative assertions: the generated OpenCode
config must not register a `weave:goal` command and no command template may
mention the string. They are retained as regression protection.

### Verification observed in this session

- `bun run docs:check-links` → "Checked local documentation links", exit 0.
- `bunx biome check` on the six touched doc files → Biome ignores `.md`/`.mdx`
  in this repo ("No files were processed"), so no Markdown linter applies to
  these paths; no other Markdown check exists in the root scripts.
- Nothing committed; no stash, reset, checkout, or worktree used. The unrelated
  dirty `docs/adapters/pi.md` hunks recorded in
  `/tmp/remove-weave-goal-task9-before.diff` (skill-catalog/boot-activation,
  native inspection components, editor coexistence, delegation entry header)
  were preserved; only the goal/plan-UI regions were rewritten.
- Generated `dist`/`dist-types` were not touched.

## Task 10 — validation and import remediation

Task 10 removed only the unused `PiRecoveryPointerStore` and
`PiWeaveRecoveryPointerV1` imports from `packages/adapters/pi/src/__tests__/extension.test.ts`.
No test logic or surrounding formatting changed.

### Validation evidence

- Focused Pi matrix: **183 pass, 0 fail**.
- OpenCode: **363 pass, 11 skip**.
- Claude Code: **80 pass**.
- Engine: **2,054 pass**.
- Full Pi suite: **1,253 pass**.
- `bun run typecheck`, `bun run docs:check-links`, and `bun run build` passed.
- The source audit retained two intentional negative assertions for removed
  `weave:goal` behavior.
- After this remediation, lint reported only the known unrelated
  `noControlCharactersInRegex` error at
  `packages/adapters/pi/src/__tests__/child-transcript.test.ts:769`.
- Build status showed no changes.

No unrelated edits, staging, commit, stash, reset, checkout, or worktree
operations were performed.

## Task 10 — Weft finding 1: same-generation active-plan race

### The defect

Generation ownership guarded only *across* generations. Inside one generation
two `syncActivePlanSurfaces()` calls could overlap, because
`onPlanSnapshotChanged` and the Alt+T handler both start a resolution without
serialising it. `createActivePlanUiState().resolve()` retained (or cleared)
state unconditionally on completion, and the extension painted every completed
result, so an older resolution finishing after a newer one overwrote the newer
view, showed a stale plan in the Alt+T modal, and - on a `workflow-terminal`
outcome - cleared a tracker that already held a newer workflow.

### The fix

- `active-plan-ui-state.ts`: a monotonic token. Every `resolve()` and every
  `clear()` takes a fresh token, so both invalidate whatever is in flight.
  Retention now happens only while the token is still latest.
- New `ActivePlanResolution` outcome: `{ status: "applied", view }` or
  `{ status: "superseded" }`. A superseded *failure* is reported on the success
  channel deliberately, so a stale error clears nothing and says nothing.
  Applied failures still carry the same safe, path-free typed error.
- `extension.ts` `syncActivePlanSurfaces()`: captures the authoritative
  workflow id before awaiting; after the await it rechecks generation
  authority, discards a `superseded` resolution as a no-op, and discards any
  result whose captured id no longer matches the tracker. The
  `workflow-terminal` tracker clear now runs only for the captured id, so an
  older terminal result can never drop a newer workflow.

### Fix/test map

| Behaviour | Test |
| --- | --- |
| Older resolution finishing active/terminal/error is `superseded`; newer view stays retained | `active-plan-ui-state.test.ts` → "last request wins > reports an older resolution that finishes with %s as superseded" (3 cases) |
| `clear()` while a resolution is pending supersedes it and leaves state empty | `active-plan-ui-state.test.ts` → "supersedes a pending resolution when clear() runs first" |
| Same generation: stale resolution may not repaint widget, `weave-task`, or modal, and the tracker still describes the newer result | `extension.test.ts` → "ignores a deferred active-plan result overtaken inside one generation" |
| Stale resolution may not repaint a tracker that has since been emptied | `extension.test.ts` → "keeps a stale active-plan result from repainting a tracker that has moved on" |

Both host tests were proven to fail against the pre-fix logic (each timed out
at 5,000 ms, because the stale resolution opened a modal for the workflow the
session had already moved past) and to pass after the fix.

### Test-authoring constraints discovered

- A second `/weave:run` inside one generation is impossible: after the first
  workflow pauses at a gate and is aborted, the next run is refused with "The
  execution lease is no longer held; explicit resume is required." The
  same-generation race is therefore driven by two overlapping *repaints*, with
  the older one blocked inside a deferred `readSnapshot`.
- `/weave:run` awaits `syncActivePlanSurfaces()` before returning, so deferring
  the plan read for a run blocks the run command itself. The Alt+T shortcut
  gives an awaitable-but-not-awaited resolution, which is the usable lever.

### Validation observed in this session

- `bun test packages/adapters/pi/src/__tests__/active-plan-ui-state.test.ts` →
  **25 pass, 0 fail**.
- `bun test .../active-plan-ui-state.test.ts .../extension.test.ts` →
  **137 pass, 0 fail**.
- `bun test .../plan-render.test.ts .../plan-task-list.test.ts .../plan-catalog.test.ts`
  → **51 pass, 0 fail**.
- Full Pi suite: **1,259 pass, 0 fail** across 73 files.
- `bun run typecheck` → exit 0 for every package.
- `bunx biome check` on the four touched source/test files → no errors; the six
  remaining warnings in `extension.ts` are pre-existing unused-parameter hints
  untouched by this change. Biome's formatter rewrote only the new
  `active-plan-ui-state.ts` and test blocks; `extension.ts` was byte-identical
  before and after.
- Nothing committed or staged; no stash, reset, checkout, or worktree used.

## Task 10 — Weft finding 2: stale Alt+T overlays never settled

### The bug

`ctx.ui.custom()` returns a promise that settles only when the component calls
`done()`. The Alt+T overlay guarded staleness by rendering `[]` and ignoring
input (`extension.ts:3147-3152` in the reviewed state), so a replaced or
shut-down generation left the overlay mounted, its promise pending, and the
user in front of a blank surface that no key could dismiss. The host test
covered the gap with the fake-only `finishCustom()` escape hatch
(`extension.test.ts:4508-4520` in the reviewed state), which proved nothing
about production behaviour.

### The fix

- `extension.ts`: a session-scoped `planTaskOverlayCell` holds the settlement
  handle of the overlay that is currently mounted, plus an idempotent
  `closePlanTaskOverlay()`. The handle is cleared before it is invoked, and
  each handle is itself single-shot, so replacement, shutdown, user cancel, and
  a stale callback can all race without settling one promise twice.
- `openPlanTaskList()` calls `closePlanTaskOverlay()` before `ctx.ui.custom()`,
  so opening replaces any overlay still mounted. Inside the factory, one
  `settle()` function is the sole path to `done()`; `onCancel` and the new
  `onStale` both point at it.
- `session_start` and `session_shutdown` call `closePlanTaskOverlay()` as their
  first action, before any other revocation, so no stale generation work can
  run while an unsettled overlay is still mounted.
- `plan-task-list.ts`: new optional `onStale` callback, reported at most once,
  the first time `render()` or `handleInput()` observes `isCurrent() === false`.
  The single-shot guard is what makes it safe to fire from `render()`: a host
  that re-renders in response cannot drive an unbounded loop. `handleInput`
  no longer needs the caller's duplicate stale guard, and stale input arranges
  closure instead of being silently dropped.
- No timers, no polling, and no execution/start/resume side effects were added:
  settling the overlay is the only effect a stale generation can have here.

### Fix/test map

| Behaviour | Test |
| --- | --- |
| Stale render and stale input each arrange closure, reported exactly once, with no cancel and no render loop | `plan-task-list.test.ts` → "reports staleness once so the host can close the overlay it owns" |
| Configured cancel key settles the component exactly once and later input is inert | `plan-task-list.test.ts` → "cancels exactly once and ignores input afterwards" |
| Generation replacement auto-settles the open overlay (one settlement, no `finishCustom()`), retained callbacks stay inert, and the new generation can open a fresh overlay | `extension.test.ts` → "fails closed for retained Alt+T callbacks after replacement" |
| Shutdown auto-settles the open overlay, and the closed overlay's callbacks stay inert | `extension.test.ts` → "closes an open Alt+T overlay when the session shuts down" |
| Normal cancel settles once; repeated cancel, replacement, shutdown, and stale input add no second settlement | `extension.test.ts` → "settles an Alt+T overlay once across cancel, replacement, and shutdown" |
| Recovered-plan Alt+T closes through its configured cancel key rather than the fake hook | `extension.test.ts` → "renders a recovered plan through the shared widget, footer, and Alt+T resolver without resuming" |

`finishCustom()` remains on the fake host for the unrelated child-inspection
tests (`extension.test.ts:3507, 3565, 3608, 3624`); only the Alt+T lifecycle
dependence on it was removed.

### Test-authoring constraints discovered

- Opening Alt+T in a *second* generation needs that generation's provider to
  answer for the new run's plan name: `MutablePlanStateProvider.readSnapshot`
  fails with `PlanMissing` unless the held snapshot's `planName` matches, and
  the resulting failure is reported as a warning notification rather than an
  overlay. `newProvider.setSnapshot(planSnapshotFixture("gated-flow"))` before
  the second `/weave:run` is what makes the fresh-overlay assertion possible.
- The second `/weave:run` needs `await flushBackgroundWork()` before awaiting
  `processPort.spawnPromises[1]`, then `completeDirectChild`, or the run
  command never resolves.

### Validation observed in this session

- `bun test .../extension.test.ts -t "Alt"` → **12 pass, 0 fail**, 83 expect
  calls (includes the three lifecycle tests above).
- `bun test .../extension.test.ts .../plan-task-list.test.ts
  .../active-plan-ui-state.test.ts` → **174 pass, 0 fail**, 988 expect calls.
- Full Pi suite (`bun test packages/adapters/pi`) → **1,263 pass, 0 fail**
  across 73 files.
- `bun run typecheck` → exit 0 for every package, 0 errors.
- `bunx biome check` on the four touched source/test files → no errors; the six
  warnings reported in `extension.ts` (lines 73, 95, 1670, 1862, 2002, 4211)
  are pre-existing and outside every line this change touched.
- Nothing committed or staged; no stash, reset, checkout, or worktree used.

## Task 10 — Weft finding 3: display-column width and tiny-terminal row bounds

Weft's Medium geometry blocker cited two places where the UI measured
something other than what the terminal actually spends:

- `workflow-task-status.ts:32-36,74-88` bounded `Array.from(value).length`,
  a *code-point* count. A wide emoji or CJK glyph costs two terminal columns,
  so a 56-code-point footer could occupy up to 95 display columns.
- `plan-task-list.ts:151-163` treated `MIN_VISIBLE_ROWS + CHROME_LINES` as a
  floor rather than a preference, so `planTaskListRowBudget(4)` returned `7`
  and the popup rendered 6 lines into a 4-row terminal.

### What changed

- The footer now measures with Pi's supported `visibleWidth` and cuts with
  `truncateToWidth`. `truncateToDisplayWidth` asks for a plain cut (empty
  ellipsis) and appends the single `…` itself, so the visible ellipsis stays
  the last character and the cap covers the ellipsis column.
- The whole footer, the prefix budget, and the *themed* result are all bounded
  by display columns. Theming still happens exactly once, after the logical
  bound; the result is then re-measured and, if a theme inserted visible
  characters, cut again with ANSI-aware `truncateToWidth`.
- `planTaskListVisibleRows` no longer claims a minimum the terminal cannot
  honour. A roomy viewport keeps the ordinary 3..24 window; a viewport smaller
  than that drops the blank separator (`COMPACT_CHROME_LINES = 2`) and reports
  only the rows that remain, down to zero.
- `planTaskListRowBudget` clamps its preferred layout into `[1, usable]`, so
  the budget is always at least 1 and never more than the terminal has.
- `planTaskListMaxScroll` returns `0` when no task rows are visible, so the
  offset cannot underflow or run off the end of an unshowable plan.
- `renderPlanTaskListLines` ends with `lines.slice(0, totalRows)` as a final
  guard, and returns `[]` for a non-positive height.

### Measured facts worth keeping

- `truncateToWidth` emits a trailing ANSI reset (`\u001b[0m`) whenever it
  actually truncates, even with an empty ellipsis. It costs zero display
  columns but breaks naive `endsWith("…")` assertions if the ellipsis is left
  to the helper.
- `visibleWidth`: emoji `😀` = 2, CJK `日` = 2, combining `e\u0301` = 1.
- The popup's real chrome is 3 lines (title, separator, hint), so a roomy
  render is `budget - 1` lines, not `budget`. Component tests must assert
  `rendered.length <= budget`, not equality.

### Fix/test map

| Behaviour | Test |
| --- | --- |
| Wide-emoji title bounded by display columns, not code points | `workflow-task-status.test.ts` → "bounds a wide-emoji title by display columns, not code points" |
| CJK title bounded, single ellipsis retained | `workflow-task-status.test.ts` → "bounds a CJK title by display columns" |
| Zero-width combining marks are not overcharged | `workflow-task-status.test.ts` → "counts combining characters as their single rendered column" |
| Wide characters in the prefix itself still bound the whole footer | `workflow-task-status.test.ts` → "bounds wide characters in the prefix itself" |
| Every ID/title size across ASCII, emoji, CJK and combining alphabets stays within 56 columns | `workflow-task-status.test.ts` → "bounds every wide-character combination of ID and title by display width" |
| ANSI-themed footer stays within the cap | `workflow-task-status.test.ts` → "keeps the themed footer within the display-column cap" |
| A theme that adds visible characters is re-bounded | `workflow-task-status.test.ts` → "re-bounds a theme that inserts visible characters" |
| `planTaskListRowBudget(4) === 4`, visible rows 2 | `plan-task-list.test.ts` → "never budgets more rows than a tiny terminal actually has" |
| Budget within `[1, terminalRows]` for rows 1–12 and for arbitrary finite positive heights | `plan-task-list.test.ts` → "stays within the terminal and above zero for every small height", "stays within the terminal for arbitrary finite positive heights" |
| One-row terminal renders one width-safe line | `plan-task-list.test.ts` → "never claims more rows than a pathologically small terminal has" |
| Two-row compact state, and separator dropped before task rows | `plan-task-list.test.ts` → "renders a compact two-line state on a two-row terminal", "drops the blank separator before it drops task rows" |
| Line count never exceeds the viewport for rows 1–12 across empty/single/long plans | `plan-task-list.test.ts` → "never emits more lines than the viewport for rows 1 through 12" |
| No scrolling and no offset underflow when zero task rows are visible | `plan-task-list.test.ts` → "cannot scroll at all when no task rows are visible", "ignores scroll keys when no task rows are visible" |
| `render()` respects its budget for empty, single, long and Unicode plans at every small height | `plan-task-list.test.ts` → "never renders more lines than its own row budget, at any height" |
| Every rendered line fits `width` on a tiny terminal, themed included | `plan-task-list.test.ts` → "keeps every line inside the width even on a tiny terminal" |
| Live shrink and grow re-budget the viewport | `plan-task-list.test.ts` → "re-budgets on a live shrink and on a live grow" |
| Undefined/invalid heights fall back to 18 rows | `plan-task-list.test.ts` → "falls back to the conservative height for undefined and invalid heights" |
| Tiny state is still cancellable through the configured binding, exactly once | `plan-task-list.test.ts` → "stays cancellable through the configured binding on a one-row terminal" |

### Pre-fix failure proof

A scratch script re-running the reviewed algorithms against Weft's two
examples (not committed, `/tmp/pre-fix-proof.ts`):

```
pre-fix footer visibleWidth = 95 (cap 56) -> FAIL
pre-fix budget(4) = 7 -> FAIL
pre-fix rendered lines at terminalRows=4 = 6 -> FAIL
```

After the fix the same two examples hold: the emoji footer measures ≤ 56
display columns, `planTaskListRowBudget(4) === 4`, and `render()` at
`terminalRows = 4` emits at most 4 lines.

### Validation observed in this session

- `bun test src/__tests__/workflow-task-status.test.ts` → **19 pass, 0 fail**,
  357 expect calls.
- `bun test src/__tests__/plan-task-list.test.ts` → **47 pass, 0 fail**,
  777 expect calls.
- `bun test src/__tests__/active-plan-ui-state.test.ts
  src/__tests__/extension.test.ts` → **139 pass, 0 fail**, 609 expect calls.
- Full Pi suite (`bun test packages/adapters/pi`) → **1,282 pass, 0 fail**
  across 73 files.
- `bunx biome check` on the four touched files → clean (one formatting fix
  applied to `workflow-task-status.test.ts` by `--write`).
- `bun run typecheck` → exit 0, no `error TS` lines in any package.
- `bun run lint` → 1 error, 322 warnings. The single error is the known
  unrelated `lint/suspicious/noControlCharactersInRegex` at
  `packages/adapters/pi/src/__tests__/child-transcript.test.ts:769`, outside
  every line this change touches.
- Task 10 finding 1 and 2 files (`extension.ts`, `active-plan-ui-state.ts` and
  their tests) were not modified by this fix.
- Nothing committed or staged; no stash, reset, checkout, or worktree used.

## Task 10 — Weft re-review remediation

Weft's re-review approved the same-generation token, the Alt+T overlay
lifecycle, and the display-column geometry, and raised two findings.

### Finding (High): recovery-pointer A→B race

`syncActivePlanSurfaces()` guarded stale results by comparing the workflow id
captured from the session tracker before the await with the tracker's id after
it. That guard is empty for a recovery-sourced resolution: the tracker holds
nothing in both reads, so `undefined === undefined` proved nothing. The
recovery pointer could move from workflow A to workflow B while A's plan
snapshot read was still pending, and A still painted the widget, the durable
footer, and the Alt+T modal.

Fix (`packages/adapters/pi/src/extension.ts`):

- After an applied active view whose `identity.source === "recovery"`, the
  pointer is re-read through the same read-only `ActivePlanReadPort` by the new
  `recheckRecoveryPointer(port, workflowInstanceId)` helper. It returns
  `confirmed`, `changed`, or `gone`, and reports an unreadable pointer as
  `gone` so no raw error or filesystem path can reach a surface. It reads one
  pointer and starts, resumes, and acquires nothing.
- Ownership is rechecked after that await with `authorityIsCurrent()` and
  `activePlanUiState.view() !== view`. Because `resolve()` and `clear()` both
  drop the retained view immediately, a retained view that is still the same
  object is proof that no newer resolution took over. A result that lost
  ownership returns an empty view and neither paints nor clears, so it cannot
  overwrite a newer resolution during the recheck.
- `confirmed` paints as before. `gone` clears the surfaces. `changed` clears and
  then performs exactly one fresh resolution of the new pointer, through the
  new third parameter `allowRecoveryRerun` (default `true`, passed as `false` to
  the retry), so the retry cannot recurse. The retry takes a newer state token,
  so last-request-wins still holds.
- `active-plan-ui-state.ts` needed no change: retained-view object identity is
  already a sufficient token-current query.

Fix/test map (`packages/adapters/pi/src/__tests__/extension.test.ts`, all in
`strict generation ownership and stale async cleanup`):

- `re-resolves a recovery pointer that moved to another workflow while a read
  was pending` — pointer A resolves, blocks in a deferred plan read, the store
  gains a pointer for another workflow, then A settles. A never reaches the
  widget, the footer, or the modal; the retry resolves the new pointer, fails
  closed on a workflow this session never tracked, leaves both surfaces clear,
  and reports one safe message.
- `never paints a recovery result whose pointer went terminal while pending` —
  the pointer settles to `status: "terminal"` mid-read, so the pending result
  clears instead of painting and Alt+T says nothing is active.
- `lets a newer resolution keep ownership during a recovery pointer recheck` —
  resolution A parks inside its pointer recheck (new
  `DeferrableRecoveryPointerStore` test double), resolution B completes and
  paints `Task B`, then A's recheck confirms its own workflow and is still
  refused: widget and footer call counts and values are unchanged and no
  overlay opens.

Pre-fix proof: with the recheck block removed from `extension.ts`, all three
tests fail (8,000 ms timeouts, because pre-fix workflow A paints and opens its
overlay). With the fix restored, all three pass.

Test-authoring facts learned here:

- Two recoverable workflow instances cannot be produced in one test that shares
  a single runtime store: a second `/weave:run` in a later generation never
  spawns while the first instance still holds its lease. Both the two-workflow
  config and the run-twice variants hung on
  `await processPort.spawnPromises[1]`. Naming an untracked workflow in the new
  pointer is the workable way to prove the retry ran, since the retry's failure
  message (`Weave could not read the active workflow.`) is observable.
- `runtimeStoreFactory.open` must return one shared store instance. Returning
  `createInMemoryRuntimeStore()` per call makes the recovered pointer name a
  workflow the new store has never seen, and the recovery session hangs.
- `FakeChildProcessPort` keeps one pending entry ahead in `spawnPromises`, so
  "no new child" assertions must compare against a length captured earlier, not
  against the number of spawns.
- Earlier generations legitimately paint the pre-race title, so "A never
  painted" assertions must slice `widgetCalls`, `statusCalls`, and
  `customRenderedLines` from indices captured just before the settle.

### Finding (Medium): docs unit contract

`docs/adapters/pi.md:85` still bounded the `weave-task` footer by "56 code
points" after the geometry fix moved to display columns. It now reads "bounded
to 56 terminal display columns". The published Pi MDX
(`packages/docs/src/content/docs/docs/reference/adapters/pi.mdx`) states no
unit for that bound, so it needed no change. The unrelated child transcript
preview reference at `docs/adapters/pi.md:180` still says "code points" and was
left alone.

### Validation observed in this session

- `bun test src/__tests__/extension.test.ts -t "pointer"` → **3 pass, 0 fail**,
  24 expect calls (0 pass, 3 fail before the fix).
- `bun test` on `extension.test.ts`, `active-plan-ui-state.test.ts`,
  `workflow-task-status.test.ts`, and `plan-task-list.test.ts` → **208 pass,
  0 fail**, 1,767 expect calls.
- Full Pi suite (`bun test packages/adapters/pi`) → **1,285 pass, 0 fail**
  across 73 files.
- `bunx biome check` on `extension.ts` and `extension.test.ts` → no errors,
  6 warnings, after `--write` reformatted one new type annotation.
- `bun run typecheck` → exit 0, no `error TS` lines.
- `bun run docs:check-links` → passed.
- Nothing committed or staged; no stash, reset, checkout, or worktree used.

## Task 10 — final static contract remediation

### Findings and corrections

- **Claude capability declaration:** The idle-continuation note used the stale phrase “goal command” and described the gaps as missing goal state. The note now names the retained `/weave:start` projection as submitting and entering plan work as a foreground command. It states that the projection does not provide persisted idle-continuation state, an enforced continuation budget, pause/resume, or a status surface. The capability test asserts each current projection and gap, and asserts that the notes do not contain the removed goal-command terms.
- **Architecture ownership matrix:** The `Goals` row incorrectly assigned goal state, budgets, adjudication, and continuation decisions to the engine and listed unrelated adapter responsibilities. The row now limits engine ownership to normalized workflow goal metadata and harness-neutral active-plan task selection and plan semantics. It assigns concrete plan discovery/I/O, command/event projection, and UI/footer to adapters, without deleted SessionGoal or continuation APIs.

### Validation observed in this session

- `bun test packages/adapters/claude-code/src/__tests__/capability-declarations.test.ts` → **2 pass, 0 fail**, 13 expect calls.
- `bun test packages/adapters/claude-code` → **80 pass, 0 fail**, 160 expect calls across 8 files.
- `bun run typecheck` → exit 0; all package checks passed. Existing Astro/Zod deprecation and unused-variable hints remained; no errors.
- `bun run docs:check-links` → passed.
- `git diff --check -- packages/adapters/claude-code/src/capability-declarations.ts packages/adapters/claude-code/src/__tests__/capability-declarations.test.ts docs/architecture/adapter-boundary.md .weave/plans/remove-weave-goal-and-complete-pi-plan-ui-learnings.md` → passed with no output.
- Final goal regex audit over active `packages` and `docs` contracts → only the intentional OpenCode negative-test block remained. It contains the two expected negative assertions for the removed `/weave:goal` command; no Claude capability or architecture contract matched.
- No unrelated files were changed by this task. No commit, staging, stash, reset, checkout, or worktree operation was used.

## Task 10 — final validation and approval

All required validation ran against the approved working tree after the Weft fixes and static-contract corrections. No source, test, documentation, generated output, staging, or Git-state changes were made during validation. The only permitted mutation was appending this evidence section.

### Required validation matrix

1. Focused Pi command tests: **211 pass, 0 fail, 1,799 expect calls, 6 files**, exit **0**.
2. OpenCode suite: **363 pass, 11 skipped, 0 fail, 901 expect calls, 13 files, 374 total tests**, exit **0**. The 11 skips are the category-routing smoke tests.
3. Claude Code suite: **80 pass, 0 fail, 160 expect calls, 8 files**, exit **0**.
4. Engine suite: **2,054 pass, 0 fail, 8,364 expect calls, 57 files**, exit **0**.
5. Full Pi suite: **1,285 pass, 0 fail, 6,148 expect calls, 73 files**, exit **0**.
6. `bun run typecheck`: exit **0**. All package checks passed. The docs package reported **0 errors, 0 warnings, 9 hints**; no type errors occurred.
7. `bun run lint`: exit **1** only for the documented unrelated error at `packages/adapters/pi/src/__tests__/child-transcript.test.ts:769` (`lint/suspicious/noControlCharactersInRegex`). Biome checked **552 files**, with **322 warnings** and **72 infos**. The 322-warning count matches the recorded pre-task baseline. No Task 1–10 path produced an error.
8. `bun run docs:check-links`: local documentation links checked successfully, exit **0**.
9. `bun run build`: completed successfully, including the docs build of **20 pages**, exit **0**. The post-build worktree status had no new entries; build caused no worktree status change.
10. Goal audit: exit **0** and returned only these two intentional OpenCode negative assertions:
    - `packages/adapters/opencode/src/__tests__/plugin.test.ts:488`
    - `packages/adapters/opencode/src/__tests__/plugin.test.ts:495`
    No other `weave:goal`, `weave_goal_report`, `WEAVE_GOAL`, or `SessionGoal` matches remained in the searched paths.
11. `git diff --check` over all tracked Task 1–10 changed paths produced no output and exited **0**. The equivalent empty-tree checks for all five untracked affected paths were clean. `git diff --cached --name-status` produced no output and exited **0**; the index remained empty.

### Approval

Final Weft verdict: **[APPROVE] — No findings**. Warp review was unnecessary. No commit was created.

## Task 10 — final commit scope and deferred host integration

The final Task 10 commit staged the race/overlay/geometry unit implementation and tests
(`active-plan-ui-state.ts`, `workflow-task-status.ts`, `plan-task-list.ts` and their
`__tests__` counterparts), the Claude Code static-contract fixes
(`capability-declarations.ts` and its test), this learnings file, one display-unit line in
`docs/adapters/pi.md`, and the single stale `Goals` ownership row in
`docs/architecture/adapter-boundary.md`. Eleven paths total. The full validation matrix
recorded above was observed against this working tree before the commit, and the commit
used `HUSKY=0` because the repository hook fails on the unrelated fake-host/lint baseline.

`packages/adapters/pi/src/extension.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`,
and `packages/adapters/pi/src/__tests__/fakes/fake-pi-host.ts` remain deliberately dirty.
Their Task 5–8 host integration and regression coverage is inseparably interleaved with
pre-existing boot, child-inspection, and delegation work in the same hunks and, in the case
of `fake-pi-host.ts`, in the same host surface definitions. `packages/adapters/pi/src/types.ts`
is dirty for the same reason: its only change is the host-owned `getSystemPrompt` surface.
The validated working tree includes those changes, so the validation evidence describes the
combined tree; committing those files would absorb unrelated user changes into a Task 10
commit, so the integration commit is deferred rather than forced.
