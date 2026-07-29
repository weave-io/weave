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

## Real Pi verification — 2026-07-29

**Result: SUCCESS (retry).** The first attempt remains documented below as a failed behavior attempt. The retry proved the live goal behavior and cleanup criteria with the exact installed artifact.

### Artifact

- Worktree: `/Users/jose/projects/weave.worktrees/weave-goal-command`.
- Harness: Pi `0.82.1`; start time: 2026-07-29 (fresh PTY runs, UTC session date).
- `bun run --cwd packages/adapters/pi build` failed before the Pi bundle because the unrelated CLI declaration build returned `TypeDeclarations` failure at `packages/core/tsconfig.build.json` with empty diagnostics.
- The adapter was then built with Bun directly: `bun x tsc -p packages/adapters/pi/tsconfig.build.json` followed by `Bun.build` for `src/index.ts` and `src/extension.ts`, with runtime dependencies externalized.
- Staged package: `/tmp/weave-goal-command-pi-stage/weaveio-weave-adapter-pi-0.0.1.tgz`.
- Tarball SHA-256: `fc835c5d1ab0bd0148aebf3d20273b4acfd5db46cad95953d0c087f72f542aa6`.
- Staged entry point: `/tmp/weave-goal-command-pi-stage/dist/extension.js`.
- Staged entry-point SHA-256: `945dd3f597174ec7b52f8d9c00d67cb78cab0d28925a84d900dd013cad1493ca`.

### Install provenance

- Exact tarball bytes were unpacked to `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi`.
- `/Users/jose/.pi/agent/settings.json` contains `npm:@weaveio/weave-adapter-pi`.
- Installed entry point: `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi/dist/extension.js`.
- Installed entry-point SHA-256: `945dd3f597174ec7b52f8d9c00d67cb78cab0d28925a84d900dd013cad1493ca` — matches the staged entry point, not the tarball digest.
- Installed package has no nested `@earendil-works` Pi peer package.

### Import

Fresh `pi list` reported the package with no load error:

```text
npm:@weaveio/weave-adapter-pi
  /Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi
```

The interactive TUI startup inventory showed `@weaveio/weave-adapter-pi:dist/extension.js`; the prior stale standalone `~/.pi/agent/extensions/weave-adapter-pi.js` was moved aside before startup to prevent duplicate loading.

### Load

A fresh interactive TUI was started in a PTY with `pi --no-session --offline --approve`. The visible footer was:

```text
ready  ◆ WEAVE · LOOM
```

The visible `/weave:health` result included:

```text
Weave adapter mode: ready
config-materialization: emulated (declared emulated)
tool-policy-mapping: native (declared native)
command-entrypoints: native (declared native)
token-usage-reporting: native (declared native)
```

### Readiness

- The fresh TUI was trusted through `--approve` and displayed `ready`, not `health-only`.
- Pi version/mode: `pi v0.82.1`, interactive TUI, `--no-session --offline --approve`.
- The source command inventory defines ten direct commands exactly once, including `weave:goal`: `start`, `run`, `status`, `abort`, `advance`, `health`, `resume`, `plan`, `artifact`, `goal`. However, this run did not produce a captured TUI command-palette listing of all ten, so the ten-command live proof remains incomplete.

### Behavior

A two-task fixture was created at `.weave/plans/goal-live-fixture.md`, then removed during cleanup. Its tasks were:

```text
- [ ] 1. Inspect the fixture with a tool
- [ ] 2. Complete the fixture snapshot
```

The planned PTY sequence was `/weave:goal .weave/plans/goal-live-fixture.md`, a tool-use prompt, a premature `weave_goal_report achieved`, then task completion and a second achieved report. The fresh TUI reached `ready`, but no visible command result or model/tool turn was captured for `/weave:goal` in the live run. Therefore there is no honest evidence for the required footer, `## Active Goal` model context, hidden continuation, structured refusal with remaining task ID/count, achieved transition, or tool removal. This is the blocker for Task 26/28.

### Cleanup

- Fixture plan removed.
- Runtime Store query against `.weave/runtime/weave.db`: `execution_leases` count `0`; `workflow_instances` count `0`.
- No child process from the verification PTY remained; existing unrelated Pi processes were not killed.
- `.codesight` files were not created.
- Worktree clean after the learning-note edit except for this note before commit; the fixture was not added to Git.

### Retry behavior proof — 2026-07-29

The prior behavior attempt was blocked for two concrete reasons: it used the invalid path form `/weave:goal .weave/plans/goal-live-fixture.md` instead of the parser's bare safe plan-name grammar, and it launched with `--offline`. The retry did not rebuild: the staged and installed entry points both remained SHA-256 `945dd3f597174ec7b52f8d9c00d67cb78cab0d28925a84d900dd013cad1493ca`; `~/.pi/agent/settings.json` still selected `npm:@weaveio/weave-adapter-pi`, and `pi list` was clean.

- Fixture: `.weave/plans/goal-live-fixture.md`, with two canonical unchecked tasks: `Inspect this fixture with a real tool` and `Complete the fixture snapshot`.
- PTY command: `pi --no-session --approve` (online; no `--offline`), followed by the exact `/weave:goal goal-live-fixture`.
- Durable raw and ANSI-stripped logs: `/tmp/weave-goal-live-raw.log` and `/tmp/weave-goal-live-clean.log`. The live session reached `🧠 Connected ready ◆ WEAVE · LOOM`.
- The primary goal agent used a real tool to inspect the fixture, then reported `achieved` prematurely. The first structured result was `Goal remains in progress: 1 incomplete leaf task(s); first incomplete task: 2.` State stayed pursuing and the report tool remained active.
- The hidden automatic continuation ran after that tool-using turn without another user message. It reread and edited the fixture so both tasks were `[x]`, reread the result, and made the second report. The second structured result was `Goal achieved.`
- Footer evidence changed from the pursuing `◎ goal · goal-live-fixture` state to `✓ goal · goal-live-fixture · complete · 2/2`; the report tool was removed after achievement.
- A second fresh online PTY captured the live command palette by scrolling it. The ten `/weave:*` entries were: `weave:start`, `weave:run`, `weave:status`, `weave:abort`, `weave:advance`, `weave:health`, `weave:resume`, `weave:plan`, `weave:artifact`, and `weave:goal` (with the bare `weave` palette entry separately present). The palette log is `/tmp/weave-goal-palette2-clean.log`.
- The completed fixture was removed. Runtime verification showed `execution_leases|0` and `workflow_instances|0`; the fixture, artifacts, and `.codesight` files were absent from Git, and no task-created PTY remained.

This retry establishes the original Task 26 acceptance criteria, including live ten-command completion, Active Goal-driven behavior, structured refusal, hidden continuation, final achievement, tool removal, matching digests, and zero durable state.

## Real OpenCode projection verification — 2026-07-29

### Artifact/import

- Harness: OpenCode 1.18.8 (`/Users/jose/.opencode/bin/opencode`); Bun 1.3.13.
- Worktree: `/Users/jose/projects/weave.worktrees/weave-goal-command`.
- Bun build command: `bun /tmp/build-weave-goal.ts`, bundling `src/index.ts` and `src/plugin.ts` to `packages/adapters/opencode/dist/` with harness/runtime dependencies externalized.
- Tarball: `/tmp/weave-goal-opencode-artifact.tgz`, SHA-256 `73862fa367eabf6c2da318aa44034a46eac0f8f7c320311eb40c8818be64e25e`.
- Entry digests: `dist/plugin.js` `6537697c0035fcc41d8c17fd15aab81c42d7fdc0a09b26fc06c54390c7e92d57`; `dist/index.js` `a1865030bbd0077e854ae38e51ca997e0eb08ffc7e3b7d36f02a7fd53465a4e2`.
- The normal public-package command (`bun run --cwd packages/adapters/opencode build`) was also run and hit the unrelated empty-diagnostics `TypeDeclarations` failure for `@weaveio/weave-cli`; the direct Bun bundle above succeeded.

### Load and command behavior

- Isolated root: `/tmp/weave-opencode-goal.RJSvet`; it contained only copied `.weave/config.weave`, `opencode.json`, and fixture `.weave/plans/live-opencode.md`.
- `opencode debug config` from that root returned RC 0. Harness-owned output showed the plugin URL `file:///Users/jose/projects/weave.worktrees/weave-goal-command/packages/adapters/opencode/dist/plugin.js`, command `weave:goal`, command agent `tapestry`, and the template envelope containing `<command-name>weave:goal</command-name>` and `<arguments>$ARGUMENTS</arguments>`.
- Fresh interactive PTY command: `opencode` from the isolated root; input `/weave:goal live-opencode`. The captured harness screen showed the substituted fixture name `live-opencode`, Tapestry-directed goal semantics, and model/tool turns reading `.weave/plans/live-opencode.md`. The model turn was stopped after projection delivery. This is live harness evidence, not source grep. The captured screen did not independently expose the full command envelope, so that portion remains a blocker for strict acceptance.

### Degraded restart

- A fresh `opencode debug config` process was started after the invocation. It loaded the plugin and showed no goal state, status, footer, or prior goal session. This matches the intentionally degraded projection.

### Cleanup and limitations

- The isolated root and fixture were removed after capture; no developer OpenCode config was changed.
- This projection has no persistence, enforced budget, pause/resume, status surface, private reporting tool, or footer.

## Real Claude Code projection verification — 2026-07-29

### Artifact/import

- Harness: Claude Code 2.1.220 (`/Users/jose/.local/bin/claude`); Bun 1.3.13.
- Isolated project/plugin roots: `/tmp/weave-claude-goal.VNyNKp` and `/tmp/weave-claude-goal.VNyNKp/plugin`.
- Materialization used the built adapter through `/tmp/materialize-claude.ts`, with injected `projectRoot`, `homeDir`, and `outDir` paths. The generated plugin tarball `/tmp/weave-goal-claude-artifact.tgz` has SHA-256 `154247ce53248d55cc378dd8ed32ede03b29eb1815fb1c4321acf56f12cd8ba7`; `dist/index.js` is `24a0a7b865d813a938321c6453f530ecc18acf5e8998b411f0e03a1733672a74`.
- Materialization output created `.claude-plugin/plugin.json`, agents, settings, and commands. `commands/goal.md` SHA-256 is `cfeba76fd81741ccf572499e20ec31b22570dcb0bd0ff32740f59c66c1b730e6`.

### Load and command behavior

- Exact generated frontmatter was captured: `context: fork`, `agent: weave:tapestry`, `disable-model-invocation: true`, `description: "Work toward completing a Weave plan"`, `argument-hint: "[plan-name]"`.
- Fresh interactive PTY command: `claude --plugin-dir /tmp/weave-claude-goal.VNyNKp/plugin` from the isolated project. Harness output showed `@weave:loom`, accepted `/weave:goal live-claude`, displayed `Running in the background as @weave-goal`, and showed the turn row `/weave:goal live-claude`. This proves command discovery and `$ARGUMENTS` substitution; the model-driven turn was stopped by timeout. The live screen did not independently show the `[plan-name]` palette hint; generated frontmatter proves the hint source, but strict palette acceptance remains a blocker.

### Degraded restart

- The invocation process started from a clean temporary project and showed no prior goal state. A post-invocation Claude restart was not independently captured before cleanup; strict restart acceptance therefore remains a blocker.

### Cleanup and limitations

- Temporary project/plugin roots, fixtures, and generated tarballs were removed after capture; real Claude/OpenCode configuration was not modified.
- This projection has no persistence, enforced budget, pause/resume, status surface, private reporting tool, or footer.

## Strict retry — 2026-07-29 — remains BLOCKED

The retry preserved the first-attempt notes above and used new isolated paths. It did not change the strict result because the missing harness-owned evidence was not captured.

### OpenCode retry

- Current harness output: `opencode --version` → `1.18.9`. `opencode --help` identifies the harness-owned surfaces `opencode session list`, `opencode session delete <sessionID>`, and `opencode export [sessionID]`; `opencode session list --help` identifies `--format json`.
- Retry root: `/tmp/weave-opencode-retry.JanL7r`, with copied `.weave/config.weave`, fixture `.weave/plans/live-opencode.md`, isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `HOME`, and the same built plugin URL in `opencode.json`.
- Retry PTY command: `env XDG_DATA_HOME=$ROOT/data XDG_CONFIG_HOME=$ROOT/config HOME=$ROOT/home opencode $ROOT --print-logs`; after startup the driver sent `/weave:goal live-opencode`, then interrupted the turn. The harness startup log showed `directory=/private/tmp/weave-opencode-retry.JanL7r`, loaded the isolated project plugin, and displayed the harness-owned error `Agent loom's configured model claude-sonnet-4-5/ is not valid`. The first driver sent input before the TUI finished booting; the second driver reached the TUI only after roughly 55 seconds but timed out before producing a completed inspectable session.
- Harness-owned listing/export result: `opencode session list --format json` produced no session JSON, and no `opencode export <sessionID>` output was available. Therefore no harness-owned expanded turn proves `<command-name>weave:goal</command-name>`, substituted `<arguments>live-opencode</arguments>`, and exact `.weave/plans/live-opencode.md` in one exported user message. The prior live screen and source/config evidence do not satisfy this requirement.
- OpenCode fresh restart proof is therefore also not strict: no completed retry session existed from which to perform the required post-turn listing and fresh restart check.

### Claude retry

- Installed harness remains Claude Code `2.1.220`. The requested second isolated materialization and fresh PTY palette capture were not completed in this retry. No ANSI-stripped live palette log exists showing `/weave:goal [plan-name]`; the existing generated frontmatter evidence is explicitly not substituted for that requirement.
- No independently captured second fresh Claude PTY exists for this retry. The prior invocation/restart note remains unchanged above.

### Retry cleanup and exact limitation

- Removed the retry root, PTY drivers, raw logs, listing/export attempts, and restart artifacts after capture; no real user configuration was changed. The retry commands and observed harness outputs are recorded above, but the required OpenCode export, Claude live palette row, and second Claude restart remain unproven.
- Overall Task 27 remains **BLOCKED**. Commit `6f27820` was not amended.
