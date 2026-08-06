# Task 20(m)/21 Pi pi-vim coexistence proof

**Date:** 2026-08-06  
**Pane:** `w23:p9T`  
**Verdict:** **PASS**

A fresh real Pi 0.83.0 parent loaded the exact installed trusted npm artifact with pi-vim. Weave remained ready and outside health-only mode while the live editor, commands, selectors, and available overlays were exercised. The editor accepted and cleared ordinary text, each mounted Weave overlay returned to a usable empty input in `INSERT`, and two delayed Escape cycles reached pi-vim `NORMAL`. No production source changed.

This proof contains no raw user prompt, delegated task text, session identifier, or transcript content.

## Requirement results

| Requirement | Result | Sanitized evidence |
| --- | --- | --- |
| Fresh owned pane only | PASS | All live checks used `w23:p9T`. No pane, tab, workspace, or session was created, moved, split, closed, or restarted. |
| Pi 0.83 | PASS | `pi --version` returned `0.83.0`; the owned pane process ran the installed Pi CLI under Bun. |
| Trusted npm provenance | PASS | Settings contained exactly one `npm:@weaveio/weave-adapter-pi` package entry. The command completion source labels identified the Weave commands as npm package commands. No local adapter extension shadow existed. |
| Exact installed artifact | PASS | The installed `dist/extension.js` hash matched the same file extracted from the artifact listed below. |
| Unsafe override absent | PASS | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from the active process environment, launcher, settings, and shell configuration. |
| Project trusted | PASS | The applicable filesystem trust scope was `true`; live status reported `trust: trusted`. |
| Weave ready | PASS | The live footer remained `Connected ready ◆ WEAVE · LOOM`; `/weave:health` reported ready behavior. |
| Not health-only | PASS | `/weave:status` reported `health-only: false` and `children: 0`. |
| pi-vim loaded | PASS | The real editor rendered pi-vim `INSERT` and `NORMAL` modes throughout the checks. |
| Ordinary text entry and clear | PASS | Before and after the overlay checks, a bounded synthetic line appeared in `INSERT`, was deleted without submission, and left an empty usable editor. The text is omitted here. |
| Overlay close restores input | PASS | The inspector, Weave palette, and plan selector each closed to an empty editor in pi-vim `INSERT`; ordinary text entry and deletion still worked after all overlays. |
| Delayed Escape round trips | PASS | After startup and again after the live overlay checks: delayed Escape reached `NORMAL`, `i` returned to `INSERT`, and a second delayed Escape reached `NORMAL`. The footer remained ready. |
| Keybinding diagnostics checked | PASS | `/weave:health` exposed the bounded skipped-binding diagnostics listed below. Tested non-conflicting shortcuts remained usable. |
| Child-dependent gaps recorded | PASS | The parent had zero children and no child history. Unavailable child-only states are listed without claiming they opened. |
| Final cleanup | PASS | Child RPC process count was zero; Runtime Store schema 5 reported no active lease; the owned pane remained open. |

## Exact installed artifact

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Artifact: `weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz`
- Artifact SHA-256: `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6`
- Installed `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`
- Installed `dist/index.js`: `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e`
- Installed `dist/cli.js`: `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd`
- Extracted artifact `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`

## Live command and overlay checks

The checks invoked only read-only commands or a cleanup command whose empty precondition made it a no-op. No workflow, child, ref, private child session, or history record was created.

| Surface | Sanitized outcome | Result |
| --- | --- | --- |
| Weave command completion | Typing the Weave command prefix opened a bounded list and reported `1/14`; entries carried the npm package source label. Deleting the unsubmitted line closed the completion list. | PASS |
| `/weave` | Opened the bounded native Weave action palette with five actions valid for the current state. Escape closed it and restored `INSERT`. | PASS |
| `/weave:health` | Reported ready behavior, native child inspection, bounded capability notes, and keybinding diagnostics. | PASS |
| `/weave:status` | Reported trusted TUI mode, `health-only: false`, and zero children. | PASS |
| `/weave:plan` | Opened the bounded plan selector. Escape closed it and restored `INSERT`. | PASS |
| `/weave:inspect` | Opened the native `Weave child inspection` selector with the empty execution view. Escape closed it and restored `INSERT`. | PASS |
| `/weave:history` | Reported no child history for the workspace. | PASS |
| `/weave:doctor` | Returned a bounded sanitized report: degraded overall, 12 capability checks passed, 8 unavailable, session and ref scans completed, and the cache source was degraded. | PASS |
| `/weave:clear-children` | Reported no terminal child history to clear. It was a no-op. | PASS |
| `Alt+T` | Reported that no Weave workflow was active, so no plan-task popup was available. | PASS |

Mutating commands were not invoked. This avoided changes to workflows, artifacts, child recovery state, or user data.

## Editor and pi-vim coexistence

The live checks established this sequence:

1. The fresh parent rendered an empty editor in pi-vim `INSERT` while Weave showed ready.
2. Ordinary synthetic text was entered and cleared without submission.
3. Delayed Escape reached `NORMAL`; `i` returned to `INSERT`; a second delayed Escape reached `NORMAL`.
4. The inspector, Weave palette, and plan selector opened and closed. Each returned to an empty editor in `INSERT` with the ready footer intact.
5. Ordinary synthetic text was entered and cleared again after the overlay checks.
6. A final delayed Escape reached `NORMAL`, return to `INSERT` succeeded, and the second delayed Escape again reached `NORMAL`.

The command completion list remained visible when Escape changed pi-vim from `INSERT` to `NORMAL`; deleting the unsubmitted command line with the normal-mode editor command closed the list. This preserved pi-vim's Escape semantics and left the editor usable.

## Keybinding conflict diagnostics

`/weave:health` reported the adapter's raw-key limitation and named-action emulation. It also reported these skipped bindings:

- `weave.child.sibling.previous` skipped `alt+left` because Pi already bound it to `tui.editor.cursorWordLeft`.
- `weave.child.sibling.next` skipped `alt+right` because Pi already bound it to `tui.editor.cursorWordRight`.

These diagnostics were bounded and contained no prompt or transcript data. They did not prevent the tested `Alt+I`, `Alt+1`, `Alt+T`, Escape, or editor mode checks.

## Unavailable child-dependent overlay checks

The fresh parent reported zero children, no child history, and no active child RPC process. The following states were therefore unavailable and are not claimed as observed:

- `Alt+I` child picker: reported that no Weave children were available.
- `Alt+1` direct-child overlay: reported no matching child.
- Running-child stream, steering, follow-up, and cancellation states.
- Completed-child read-only transcript and historical pagination/search states.
- Nested child, parent, and sibling navigation states.
- Retry, continue, and recovered-child states.
- History selection overlay.

`Alt+T` was also unavailable because no Weave workflow was active. No child or workflow was created merely to expose an otherwise unavailable state.

## Cleanup and validation

Final checks:

- Pi child RPC processes: `0`
- Runtime Store schema: `5`
- Active Runtime Store lease: none
- Parent child count: `0`
- Production source changes: none
- Pre-existing panes and data: preserved
- Owned pane `w23:p9T`: open
- `bun run docs:check-links`: PASS
