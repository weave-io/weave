# Task 20(m) Pi pi-vim coexistence proof

**Verdict: PASS**

Checklist version `3`. Matrix item `(m)` (pi-vim coexistence), covering the related smoke rows `S047` (restore pi-vim mode on unmount), `S049` (named overlay keys), and `S050` (keybinding conflicts never overwrite Pi-owned bindings). Run attempt `2` against exact subject `a7b72bd` in the isolated Pi 0.83 harness with real `npm:pi-vim`. This replaces the earlier proof bound to artifact `1f69937` / `636b8fac98ce…`.

This proof contains no raw delegated task bodies beyond short titles and markers.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| pi-vim identity | `npm:pi-vim@0.14.1` (isolated install under `$ISO/pi-agent/npm/node_modules/pi-vim`) |
| Checklist version | `3` |
| Checklist rows | `S047`, `S049`, `S050` (matrix item `(m)`) |
| Run attempt | `2` |
| `childSettlementMissingCount` | `0` |

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-a7b72bd-task20iso-0f7fbf77cb99.tgz` |
| Artifact SHA-256 | `0f7fbf77cb99d38ecbf952c46b16da2fffb3308f2ce346d5e35b9040e0c6deec` |
| Built and installed `dist/extension.js` SHA-256 | `0dff94ac4167e8f2d7ecbafcfd91f1a1895b5c782ffa747043d872547d300314` |
| Built and installed `dist/index.js` SHA-256 | `c654510917e651c09f22c6b19d52bda6a0f6f9dabda8436ee91aa8af1b9bc1be` |
| Built and installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

`$ISO` is `$HOME/.local/share/weave/task20-pi083-harness`. Tarball entry digests matched the installed entry points. Unsafe provenance override was unset. No local extension shadow directory existed. Global `~/.pi/agent` remained on Pi `0.84.0` with its own package list untouched.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Fresh test-created pane | `w23:pAQ` | PASS |
| Herdr agent | `task20m` (`herdr agent start --kind pi`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi", "npm:pi-vim"]` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js, pi-vim` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:health` mode | `ready` | PASS |
| Trusted | `true` | PASS |
| Health-only | `false` | PASS |
| `child inspection` | `native-overlay` | PASS |
| Proof `XDG_DATA_HOME` | `/Users/jose/Library/Application Support/weave-task20-xdg` (symlink-free) | PASS |
| Generation | `ab82b334-16ca-4112-a7e6-1f4e51d1df5d` | PASS |
| Same pane retained | `true` | PASS |
| Production source edited by this proof | `0` | PASS |

Startup also reported the bounded Pi-owned conflict diagnostics listed below. The isolated agent directory has no `rose-pine` theme package, so Pi fell back to `dark`. That notice does not affect this item.

## Native children created through parent delegation

Exactly two bounded `shuttle-mini` children were created by prompting the live Pi parent to delegate.

| Child | Logical id | Native session id | Title | Status |
| --- | --- | --- | --- | --- |
| LIVE | `fcccfd8a-09a5-41a5-86f0-e9cce49a751c` | `019fd85a-9521-793f-8fc9-0190301c766b` | `Title: TASK20M LIVE` | `cancelled` (after live overlay checks) |
| LIVE2 | `775253b0-8533-41f9-b8c9-fb78495f6287` | `019fd85c-b1d9-7e21-8b63-abdf17f2acfc` | `Title: TASK20M LIVE2` | `completed` (marker `PARENT_DELEGATED_2_OK`, last line `live2 45`) |

| Check | Observed | Outcome |
| --- | ---: | --- |
| Origin parent session id | `019fd857-db12-7a1c-a0e7-6ee6b6aaf967` | PASS |
| Parent host path | `$ISO/pi-agent/sessions/2026-08-06T18-31-04-210Z_019fd857-db12-7a1c-a0e7-6ee6b6aaf967.jsonl` | PASS |
| Post-run `/weave:status` | `children: 2` (one cancelled, one completed) | PASS |
| Residual `ChildSettlementMissing` in parent session | `0` | PASS |

## pi-vim editor coexistence

Observed sequence in the owned pane:

1. Fresh parent rendered empty editor in pi-vim `INSERT` with `ready ◆ WEAVE · LOOM`.
2. Delayed Escape reached `NORMAL`; `i` returned to `INSERT`; a second delayed Escape reached `NORMAL`.
3. Synthetic primary-editor draft `DRAFTM2` was typed without submission.
4. While LIVE was running, `Alt+I` opened the Weave children picker; `Enter` mounted the native overlay (`◆ Title: TASK20M LIVE · LIVE`) with live transcript lines.
5. Overlay input showed `> STEER1`; `Enter` cleared the overlay prompt without appending that text to the primary draft.
6. Overlay input accepted a follow-up string and `Alt+Enter` cleared the overlay prompt the same way.
7. `Alt+Left` / `Alt+Right` left the overlay on `TASK20M LIVE` (Pi-owned bindings; Weave sibling actions skipped).
8. Overlay `Up` navigation disengaged live-tail enough to show a bounded earlier-lines expansion cue.
9. `Alt+1` remounted the live overlay on the active child.
10. Double `Escape` opened the cancel-subtree confirmation with `→ Keep running` first; `Enter` accepted Keep running and restored primary draft `DRAFTM2` in pi-vim `INSERT`.
11. Later insert/normal cycles (`INSERT` ↔ delayed Escape `NORMAL`) continued to work with drafts `KEEPM4` / `KEEPM5` / `KEEPM6` surviving picker open/close.
12. LIVE2 completed while draft `KEEPM6` remained in the primary editor in `INSERT`.

No overlay key sequence left the primary editor executing the steered/follow-up text or switching pi-vim modes while the overlay owned the keyboard.

## Keybinding conflict diagnostics

`/weave:health` and startup warnings named Pi owners and Weave fallbacks:

- `weave.child.sibling.previous` skipped `alt+left` because Pi already bound it to `tui.editor.cursorWordLeft`.
- `weave.child.sibling.next` skipped `alt+right` because Pi already bound it to `tui.editor.cursorWordRight`.
- Overlay search skipped `ctrl+f` because Pi already bound it to `tui.editor.cursorRight`.

These diagnostics were bounded. Pi retained the conflicting keys. Tested non-conflicting routes (`Alt+I`, `Alt+1` while live, Escape arming, Enter steer, Alt+Enter follow-up) remained usable under Weave ownership.

## Overlay key isolation (sanitized)

| Route | Sanitized observation | Leak into pi-vim / primary editor | Result |
| --- | --- | --- | --- |
| `Alt+I` picker | Opened `Weave children` with running/completed rows | no | PASS |
| `Alt+1` (live) | Mounted `◆ Title: TASK20M LIVE · LIVE` | no | PASS |
| `Alt+2` / `Alt+9` (no slot) | Bounded `weave overlay key ignored: no matching child` | no | PASS |
| Resolved sibling keys | Pi kept `alt+left` / `alt+right`; overlay stayed on LIVE | no | PASS |
| Overlay scroll | `Up` showed earlier-lines expansion while LIVE | no | PASS |
| Overlay search key | `ctrl+f` skipped with Pi-owner diagnostic (search trigger not installed) | no | PASS |
| Enter steering | Overlay prompt `> STEER1` then cleared; primary draft unchanged | no | PASS |
| Alt+Enter follow-up | Overlay prompt cleared; primary draft unchanged | no | PASS |
| Backspace hierarchy | Empty Backspace closed live overlay path without primary mode corruption | no | PASS |
| Double-Escape | Hint then confirmation `Keep running` / `Cancel subtree`; Keep running restored draft + `INSERT` | no | PASS |

## Repository checks

Focused coexistence/input suites were run against the committed adapter sources (unrelated parallel dirty edits in `render-width.ts` / overlay files were temporarily stashed for the run, then restored untouched):

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused extension + overlay + inspection-runtime tests | `267` pass / `0` fail | PASS |
| Filtered pi-vim coexistence tests | `3` pass / `0` fail | PASS |
| `bun run docs:check-links` | pass | PASS |

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Residual child RPC under proof XDG session dirs | `0` | PASS |
| Active Runtime Store lease (`weave runtime status`) | `false` (schema `5`) | PASS |
| Closed only the created pane | `w23:pAQ` | PASS |
| Pre-existing panes preserved | `w23:p79 w23:p70 w23:p82 w23:pAN` (plus unrelated later pane `w23:pAR` left untouched) | PASS |
| Created agent after close | `agent_not_found` | PASS |
| Residual harness parent after pane close | `0` | PASS |
| Global Pi version after cleanup | `0.84.0` | PASS |
| Plan checkbox marked | `false` (not marked) | PASS |

## Acceptance mapping

| Acceptance criterion | Result |
| --- | --- |
| Fresh Herdr pane runs Pi 0.83.0 with exact `a7b72bd` npm-provenance artifact plus real pi-vim; unsafe override absent; Weave digests match | PASS |
| Startup reaches `ready ◆ WEAVE · LOOM`; pi-vim reaches INSERT, then delayed Escape reaches NORMAL | PASS |
| Parent delegates real bounded `shuttle-mini` work; Alt+I, Alt+1..9, sibling keys, overlay scroll/search route, Enter steer, Alt+Enter follow-up, Backspace, double-Escape do not leak into pi-vim or primary editor commands | PASS |
| Closing overlay / Keep-running path restores prior editor draft and pi-vim mode; later insert/normal navigation works | PASS |
| Pi-owned conflicting keys remain Pi-owned; bounded diagnostics name owners/fallbacks | PASS |
| `childSettlementMissingCount: 0`; proof records checklist v3, subject/artifact/digests, host, pi-vim identity, run attempt, sanitized observations, cleanup | PASS |
| Close only created pane; no created process/lease/pane remains; pre-existing panes preserved | PASS |
| Focused coexistence/input tests and docs links run; proof committed; plan checkbox not marked | PASS |
