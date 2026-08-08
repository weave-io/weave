# Task 20(d) picker and named-key navigation proof

**Verdict: PASS**

This record covers acceptance-matrix item (d) and
[smoke checklist](../33-smoke-checklist.md) row `S049`: `Alt+I` picker ordering and metadata,
`Alt+1..9` direct-child selection, sibling navigation on the resolved fallback keys, and empty
`Backspace` hierarchy behavior.

Pi's `alt+left` and `alt+right` were preserved. No keybinding override was configured. The adapter's
existing conflict-safe fallback keys `alt+h` and `alt+l` were confirmed in diagnostics before use.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `683e0d1a1c032e840b4a37f97d7e38abcee04763` |
| Subject HEAD subject line | `fix(pi): keep live children listable when picker sources degrade` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist row | `S049` |
| Run attempt | `1` |
| `childSettlementMissingCount` | `0` |

Artifact and digests, built from the exact subject commit and installed into the isolated harness
described in [`33-task-20-isolated-pi-083-harness-setup.md`](33-task-20-isolated-pi-083-harness-setup.md):

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-683e0d1-task20iso-a8b952589f66.tgz` |
| Artifact SHA-256 | `a8b952589f66bde3b72c07a0f6feabd6370abc789ca416ab129c8295684891f4` |
| Built and installed `dist/extension.js` SHA-256 | `b89858ad6aec3bfb8cf24e325b262b98f286a46068b55c4250ac0811ad345503` |
| Built and installed `dist/index.js` SHA-256 | `f4c3f151187c6a936988e3e50184053a91349faaac165dee9a2d8c37b69d2d08` |
| Built and installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

The built and installed digests are identical for all three entry points. The installed package
contains no nested copy of `@earendil-works/pi-coding-agent`.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Fresh test-created pane | `w23:pA9` | PASS |
| Herdr agent | `task20d` (`herdr agent start --kind pi`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi"]` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:health` mode | `ready` | PASS |
| `health-only` | `false` | PASS |
| `child inspection` | `native-overlay` | PASS |
| Keybinding override configured | `no` | PASS |

## Key resolution diagnostics

Startup warnings and `/weave:health` both reported the same two conflicts, verbatim:

```text
weave overlay action weave.child.sibling.previous skipped key alt+left: already bound to tui.editor.cursorWordLeft
weave overlay action weave.child.sibling.next skipped key alt+right: already bound to tui.editor.cursorWordRight
```

`/hotkeys` proved both outcomes at once: Pi still owns the arrow keys, and the adapter registered its
fallback keys.

Pi's own table:

```text
│ Option+Left/Ctrl+Left/Option+B / Option+Right/Ctrl+Right/Option+F │ Move by word │
```

The `Extensions` table:

```text
│ Option+I │ Open the Weave child picker      │
│ Option+1 │ Focus active child 1             │
│ Option+2 │ Focus active child 2             │
│ Option+3 │ Focus active child 3             │
│ Option+4 │ Focus active child 4             │
│ Option+5 │ Focus active child 5             │
│ Option+6 │ Focus active child 6             │
│ Option+7 │ Focus active child 7             │
│ Option+8 │ Focus active child 8             │
│ Option+9 │ Focus active child 9             │
│ Option+H │ Focus the previous sibling child │
│ Option+L │ Focus the next sibling child     │
```

| Check | Observed | Outcome |
| --- | ---: | --- |
| `alt+left` skipped, owner named | `tui.editor.cursorWordLeft` | PASS |
| `alt+right` skipped, owner named | `tui.editor.cursorWordRight` | PASS |
| `alt+left`/`alt+right` still Pi's word motion | `true` | PASS |
| `alt+h` resolved to previous sibling | `true` | PASS |
| `alt+l` resolved to next sibling | `true` | PASS |
| Registered `alt+i` and `alt+1..9` | `true` | PASS |

One additional pre-existing conflict was reported and is unrelated to this item:
`weave overlay search skipped key ctrl+f: already bound to tui.editor.cursorRight`.

## Children used

Two bounded `shuttle-mini` batches ran in the same session.

| Batch | Children | Terminal state during key tests |
| --- | --- | --- |
| 1 | `TASK20D CHILD ONE echo alpha`, `TASK20D CHILD TWO echo bravo`, `TASK20D CHILD THREE echo charlie` | completed |
| 2 | `TASK20D LIVE ALPHA`, `TASK20D LIVE BRAVO`, `TASK20D LIVE CHARLIE` | running |

Batch 2 held three live direct children open while every key assertion below ran.

## Alt+I picker

With batch 1 settled and no live child, `Alt+I` rendered:

```text
 Weave children

 → ○ TASK20D CHILD ONE echo alpha [completed] 8/6/2026, 11:34:52 AM
   ○ TASK20D CHILD THREE echo charlie [completed] 8/6/2026, 11:34:52 AM
   ○ TASK20D CHILD TWO echo bravo [completed] 8/6/2026, 11:34:52 AM

 ↑↓ navigate  enter select  escape/ctrl+c cancel
```

Cancelling and reopening produced a byte-identical list, proving deterministic order.

With batch 2 live, `Alt+I` rendered active children first:

```text
 Weave children

 → ● shuttle-mini [running] 8/6/2026, 11:36:29 AM
   ● shuttle-mini [running] 8/6/2026, 11:36:29 AM
   ● shuttle-mini [running] 8/6/2026, 11:36:31 AM
   ○ TASK20D CHILD ONE echo alpha [completed] 8/6/2026, 11:34:52 AM
   ○ TASK20D CHILD THREE echo charlie [completed] 8/6/2026, 11:34:52 AM
   ○ TASK20D CHILD TWO echo bravo [completed] 8/6/2026, 11:34:52 AM
```

| Check | Observed | Outcome |
| --- | ---: | --- |
| Picker opened on `Alt+I` | `true` | PASS |
| Valid children listed | `6` (3 live, 3 settled) | PASS |
| Active rows sorted before settled rows | `true` | PASS |
| Order stable across reopen | `true` | PASS |
| Title present on every row | `true` | PASS |
| Status present on every row | `[running]` / `[completed]` | PASS |
| Local timestamp present on every row | `true` | PASS |
| Active marker rendered | `→` on the focused row; `●`/`○` live marker | PASS |

Live rows render the title precedence fallback: live registrations carry no explicit title and no task
first line, so the resolved title is the agent name `shuttle-mini`. Settled rows resolve their durable
ref title, which is the task first line. This matches the documented precedence
(explicit title → task first line → workflow step → agent) and is recorded as an observation, not a
defect.

## Alt+1..Alt+9 direct selection

Slot order follows stable spawn order among live direct children.

| Key | Overlay header after the key | Outcome |
| --- | --- | --- |
| `Alt+1` | `◆ TASK20D LIVE BRAVO · LIVE` | PASS |
| `Alt+2` | `◆ TASK20D LIVE CHARLIE · LIVE` | PASS |
| `Alt+3` | `◆ TASK20D LIVE ALPHA · LIVE` | PASS |
| `Alt+4` | unchanged (`ALPHA`), warning `weave overlay key ignored: no matching child` | PASS |
| `Alt+5` | unchanged, same warning | PASS |
| `Alt+6` | unchanged, same warning | PASS |
| `Alt+7` | unchanged, same warning | PASS |
| `Alt+8` | unchanged, same warning | PASS |
| `Alt+9` | unchanged, same warning | PASS |

Before batch 2 existed, `Alt+1` with only settled children produced the same bounded warning and no
overlay, so unassigned slots are safe in both directions.

## Sibling navigation on the resolved fallback keys

Starting from `TASK20D LIVE BRAVO`:

| Key sequence | Observed headers | Outcome |
| --- | --- | --- |
| `Alt+L`, `Alt+L`, `Alt+L` | `CHARLIE` → `ALPHA` → `BRAVO` | PASS |
| `Alt+H`, `Alt+H`, `Alt+H` | `ALPHA` → `CHARLIE` → `BRAVO` | PASS |

| Check | Observed | Outcome |
| --- | ---: | --- |
| Forward cycle visits every sibling and wraps | `true` | PASS |
| Reverse cycle is the exact inverse | `true` | PASS |
| Navigation left the sibling set | `false` | PASS |
| Settled non-sibling children ever focused | `false` | PASS |

## Backspace hierarchy

| Step | Observed | Outcome |
| --- | ---: | --- |
| Typed `a`, `b`, `c` in the overlay draft | draft `> abc` | PASS |
| `Backspace` with a non-empty draft | draft `> ab`, overlay still `◆ TASK20D LIVE ALPHA · LIVE` | PASS |
| Two more `Backspace` presses | draft empty, overlay still open | PASS |
| `Backspace` with an empty draft at a direct child | overlay closed, parent session transcript restored | PASS |

Every live child in this run was a direct child, so the empty-draft `Backspace` resolved the parent as
the direct root and closed the overlay instead of focusing another child. `shuttle-mini` is a leaf
worker and cannot delegate, so no deeper level existed in this session.

## Settlement and final state

| Check | Observed | Outcome |
| --- | ---: | --- |
| `ChildSettlementMissing` occurrences in the full pane scrollback | `0` | PASS |
| `/weave:status` children | `6` | PASS |
| Terminal status of every child | `completed` | PASS |
| Trust | `trusted` | PASS |
| `health-only` | `false` | PASS |

## Cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Test-created pane closed | `w23:pA9` | PASS |
| Panes remaining in the workspace | `w23:p79`, `w23:p8W`, `w23:p70`, `w23:p82` (all pre-existing) | PASS |
| `herdr agent get task20d` | `agent_not_found` | PASS |
| Processes matching the isolated harness | `0` | PASS |
| Runtime Store database under the isolated root | none | PASS |
| Project Runtime Store lease | `No active lease.` | PASS |
| Global Pi 0.84.0 install | unchanged | PASS |
| Production or test files edited | `0` | PASS |

## Scope boundary

No DSL change, keybinding override, production change, or test change was made for this item. The run
used the adapter's own default resolution path. The only repository change is this record.
