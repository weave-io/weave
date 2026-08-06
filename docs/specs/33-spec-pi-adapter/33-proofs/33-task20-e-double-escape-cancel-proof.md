# Task 20(e) double-Escape subtree cancellation proof

**Verdict: PASS**

This record covers acceptance-matrix item (e) and
[smoke checklist](../33-smoke-checklist.md) row `S051`: a single `Escape` inside a mounted child
overlay arms a hint and never falls through to Pi, a second `Escape` inside the `750 ms` window opens
the cancel-subtree confirmation for the focused child, the confirmation defaults to **Keep running**,
and choosing **Cancel subtree** cancels only the selected subtree.

No keybinding override was configured. No DSL, production, or test change was made for this item.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Repository HEAD | `01d3aea` |
| Production subject for the installed bytes | `683e0d1a1c032e840b4a37f97d7e38abcee04763` |
| `git diff --stat 683e0d1 HEAD` | documentation only (`.codesight/CODESIGHT.md`, item (d) proof) |
| Working tree at run time | clean (`git status --porcelain` empty) |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist row | `S051` |
| Run attempt | `1` |
| `childSettlementMissingCount` | `0` |

The item (d) artifact was reused because the production bytes at `HEAD` are byte-identical to the
bytes built from its subject commit: every change between `683e0d1` and `01d3aea` is documentation.

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-683e0d1-task20iso-a8b952589f66.tgz` |
| Artifact SHA-256 | `a8b952589f66bde3b72c07a0f6feabd6370abc789ca416ab129c8295684891f4` |
| Installed `dist/extension.js` SHA-256 | `b89858ad6aec3bfb8cf24e325b262b98f286a46068b55c4250ac0811ad345503` |
| Installed `dist/index.js` SHA-256 | `f4c3f151187c6a936988e3e50184053a91349faaac165dee9a2d8c37b69d2d08` |
| Installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

`$ISO` is the isolated harness root described in
[`33-task-20-isolated-pi-083-harness-setup.md`](33-task-20-isolated-pi-083-harness-setup.md):
`$HOME/.local/share/weave/task20-pi083-harness`.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Fresh test-created pane | `w23:pAA` | PASS |
| Herdr agent | `task20e` (`herdr agent start --kind pi`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi"]` | PASS |
| Local extension shadow directory | absent (`No such file or directory`) | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:health` mode | `ready` | PASS |
| `child inspection` | `native-overlay` | PASS |
| `/weave:status` trust | `trusted` | PASS |
| `/weave:status` mode | `tui` | PASS |
| `health-only` | `false` | PASS |
| Generation | `5f50f18a-f291-428a-bfeb-bdd770698ea6` | PASS |
| Keybinding override configured | `no` | PASS |

Startup reported the same pre-existing, unrelated conflicts already recorded for item (d), verbatim:

```text
weave overlay action weave.child.sibling.previous skipped key alt+left: already bound to tui.editor.cursorWordLeft
weave overlay action weave.child.sibling.next skipped key alt+right: already bound to tui.editor.cursorWordRight
weave overlay search skipped key ctrl+f: already bound to tui.editor.cursorRight
```

The isolated agent directory has no `rose-pine` theme, so Pi fell back to `dark`. Neither notice
affects this item.

## Children used

Two bounded `shuttle-mini` batches ran in the same session. Every child ran a long bounded shell loop
so it stayed live across the key assertions.

| Batch | Children | Concurrency |
| --- | --- | --- |
| 1 | `TASK20E ALPHA`, `TASK20E BRAVO`, `TASK20E CHARLIE` | the parent model issued the three `weave_delegate` calls sequentially, so one child was live at a time |
| 2 | `TASK20E LIVE ONE`, `TASK20E LIVE TWO`, `TASK20E LIVE THREE` | three live siblings at once |

Batch 1 proved the Escape mechanics against a live child while the parent turn was actively working.
Batch 2 proved subtree isolation with three concurrent siblings.

## Single Escape arms a hint and never falls through

The overlay was mounted on the live batch-1 child through `Alt+I` and `Enter`:

```text
◆ TASK20E BRAVO: run this bash command and then report its last line: for i in \$(seq 1 40); do echo bravo \$i; sleep 8; done · LIVE
run 1
$ for i in $(seq 1 40); do echo bravo $i; sleep 8; done (timeout 400s)
```

A single `Escape` produced the hint, verbatim:

```text
Warning: Press Escape again to cancel this child subtree
```

| Check | Observed | Outcome |
| --- | ---: | --- |
| Hint text matches `CHILD_OVERLAY_ESCAPE_HINT` | `true` | PASS |
| Pi's own `escape interrupt` fired | `false` (parent stayed `Working...`) | PASS |
| Overlay stayed mounted | `true` | PASS |
| Focused child cancelled by the first `Escape` | `false` (child kept emitting output) | PASS |
| A later `Escape` past the window re-armed the same hint | `true` | PASS |

Pi's own footer advertises `escape interrupt`, and the parent turn was mid-tool-call for the whole
sequence, so a fall-through would have been immediately visible as an interrupted turn. It never
occurred.

## Second Escape inside the window opens the confirmation

`herdr pane send-keys w23:pAA esc esc` delivered two `Escape` presses inside the `750 ms` window. The
confirmation opened for the focused child:

```text
 Press Escape again to cancel this child subtree

 → Keep running
   Cancel subtree

 ↑↓ navigate  enter select  escape/ctrl+c cancel
```

| Check | Observed | Outcome |
| --- | ---: | --- |
| Confirmation opened on the second `Escape` | `true` | PASS |
| Confirmation targeted the focused child | `true` | PASS |
| Choice list matches `CHILD_OVERLAY_CANCEL_CHOICES` | `Keep running`, `Cancel subtree` | PASS |
| `Keep running` is first and pre-selected (`→`) | `true` | PASS |
| Parent turn interrupted by the prompt | `false` | PASS |

## Accepting the default keeps everything running

Pressing `Enter` on the pre-selected row accepted **Keep running**.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Any child cancelled | `false` | PASS |
| Focused child still producing output after the choice | `true` (`bravo 32` … `bravo 40`) | PASS |
| Child registry unchanged | `true` (picker still listed the same rows) | PASS |
| Per-child draft preserved across the confirmation | `true` | PASS |

Draft preservation was proved explicitly on a live batch-2 sibling. The overlay draft was `> drf`
before the confirmation. After `Escape`, `Escape`, `Enter` on **Keep running**, reopening the same
child restored `> drf` verbatim while the child was still running (`two 30` … `two 33`).

Observation, not a defect: Pi 0.83 renders `ctx.ui.select` in place of the extension's custom overlay
component, and the adapter does not remount the overlay after the host prompt resolves. The child, its
transcript, its live tail, and its draft all survive; reopening with `Alt+I` and `Enter` returns to the
exact prior state. No child state is lost, so this is a host-modal presentation detail rather than a
state-preservation failure.

## Cancelling only the selected subtree

Three live siblings existed at this point. The overlay was focused on:

```text
◆ TASK20E LIVE THREE: run bash: for i in $(seq 1 60); do echo three $i; sleep 10; done · LIVE
```

`Escape`, `Escape`, `↓`, `Enter` selected **Cancel subtree**. The selection moved as expected:

```text
   Keep running
 → Cancel subtree
```

The compact block for that child updated immediately:

```text
Mini-Shuttle
weave_delegate · shuttle-mini · cancelled
cancelled
run 1 · start
```

`/weave:status` immediately after the cancellation:

```text
 children: 6
   shuttle-mini [completed] turn:2 elapsed:22m40s in:9608 out:74 cost:0.0546
   shuttle-mini [completed] turn:2 elapsed:17m6s in:952 out:81 cost:0.0159
   shuttle-mini [completed] turn:2 elapsed:11m34s in:951 out:78 cost:0.0158
   shuttle-mini [cancelled] turn:2 elapsed:3m49s in:275 out:57 cost:0.0074
   shuttle-mini [running] tool:bash turn:1 elapsed:3m49s in:275 out:78 cost:0.008
   shuttle-mini [running] tool:bash turn:1 elapsed:3m49s in:275 out:61 cost:0.007
```

| Check | Observed | Outcome |
| --- | ---: | --- |
| Selected subtree cancelled | `1` child | PASS |
| Unrelated live siblings still running | `2` | PASS |
| Settled children from batch 1 disturbed | `false` | PASS |
| Compact block moved to a terminal `cancelled` state | `true` | PASS |
| Picker moved the cancelled child into the settled group | `true` (`[cancelled] 8/6/2026, 12:15:26 PM`) | PASS |
| Cancelled row keeps its resolved title | `true` (`TASK20E LIVE THREE: …`) | PASS |

The remaining two siblings were then cancelled the same way, one at a time, and each cancellation again
affected only its own subtree (`TASK20E LIVE TWO` at `12:18:09 PM`, then `TASK20E LIVE ONE`).

## Draft and overlay-close behavior

| Step | Observed | Outcome |
| --- | ---: | --- |
| Typed characters in the overlay draft | `> kxy` | PASS |
| `Escape` with a non-empty draft | hint armed, draft still `> kxy`, no fall-through | PASS |
| Three `Backspace` presses | draft emptied to `>`, overlay still mounted | PASS |
| `Backspace` with an empty draft at a direct child | overlay closed, primary editor restored | PASS |

Every live child in this run was a direct child, so the empty-draft `Backspace` resolved the parent as
the direct root and closed the overlay. `shuttle-mini` is a leaf worker and cannot delegate, so no
deeper subtree level existed in this session; a cancelled subtree therefore equals its single child.

## Settlement and final state

| Check | Observed | Outcome |
| --- | ---: | --- |
| `ChildSettlementMissing` occurrences in the captured pane scrollback | `0` | PASS |
| `/weave:status` children | `6` | PASS |
| Terminal states | `3 completed`, `3 cancelled` | PASS |
| Children left in a non-terminal state | `0` | PASS |
| Trust | `trusted` | PASS |
| `health-only` | `false` | PASS |
| Agent status at the end | `idle` | PASS |

## Cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Test-created pane closed | `w23:pAA` | PASS |
| Panes remaining in the workspace | `w23:p79`, `w23:p8W`, `w23:p70`, `w23:p82` (all pre-existing) | PASS |
| `herdr agent get task20e` | `agent_not_found` | PASS |
| Processes matching the isolated harness | `0` | PASS |
| Runtime Store database under the isolated root | none | PASS |
| Project Runtime Store lease | `No active lease.` | PASS |
| Global Pi 0.84.0 install | unchanged | PASS |
| Production or test files edited | `0` | PASS |

Parent session files written inside the isolated harness root remain there by design; nothing was
written to the global Pi agent directory.

## Scope boundary

No DSL change, keybinding override, production change, or test change was made for this item. The run
used the adapter's own default key resolution path. The only repository change is this record.
