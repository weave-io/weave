# Task 20(a) compact live settlement proof

**Verdict: PASS**

Checklist version `3`. Matrix item `(a)` (compact block live fragment and settlement tail), covering related smoke rows `S040` and `S041`. Run attempt `1` against exact subject `a7b72bd` in the isolated Pi 0.83 harness. This replaces the earlier proof bound to older artifacts (`6a547d3` / `e905209b8cf5…` and prior failed remediations).

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Working tree at run time | unrelated overlay WIP preserved unstaged; only this proof committed |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist rows | `S040`, `S041` |
| Run attempt | `1` |
| `childSettlementMissingCount` | `0` |
| Host | `joses-Apple-MacBook-Pro` |

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-a7b72bd-task20iso-0f7fbf77cb99.tgz` |
| Artifact SHA-256 | `0f7fbf77cb99d38ecbf952c46b16da2fffb3308f2ce346d5e35b9040e0c6deec` |
| Built and installed `dist/extension.js` SHA-256 | `0dff94ac4167e8f2d7ecbafcfd91f1a1895b5c782ffa747043d872547d300314` |
| Built and installed `dist/index.js` SHA-256 | `c654510917e651c09f22c6b19d52bda6a0f6f9dabda8436ee91aa8af1b9bc1be` |
| Built and installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

`$ISO` is `$HOME/.local/share/weave/task20-pi083-harness`. Tarball entry digests matched the installed entry points. Unsafe provenance override was unset in the pane and in the isolated launcher. No local extension shadow directory existed under `$ISO/pi-agent/extensions`. Global `~/.pi/agent` remained on Pi `0.84.0` with its own package list untouched.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Fresh test-created pane | `w23:pAW` | PASS |
| Herdr agent | `task20a` (`herdr agent start --kind pi`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` in both live ISO Pi processes | PASS |
| Isolated `settings.json` packages | `npm:@weaveio/weave-adapter-pi`, `npm:pi-vim` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js`, `pi-vim` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:status` trust | `trusted` | PASS |
| `/weave:status` mode | `tui` | PASS |
| `health-only` | `false` | PASS |
| Generation | `b9afdae4-8b3b-4145-af49-88f4a1e81e8c` | PASS |
| Nested ISO rpc child processes after settlement | `0` | PASS |
| Production source edited | `0` | PASS |

Startup reported the same pre-existing, unrelated overlay key-conflict warnings already recorded for other Task 20 items (`alt+left` / `alt+right`). The isolated agent directory has no `rose-pine` theme, so Pi fell back to `dark`. Neither notice affects this item.

## Ordinary delegation

One ordinary `shuttle-mini` delegation ran a harmless no-edit task. The child streamed a bounded assistant fragment while `running`, then settled with the unique terminal marker `TASK20A_PASS_M4P8`.

A 5 ms dual-source (`visible` + `recent-unwrapped`) sampler inspected the collapsed `weave_delegate` block. It retained only booleans, counts, SHA-256 digests, and short activity previews. It stored no raw prompt or child transcript.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Ordinary delegation completes successfully | parent reported `ok, completed, TASK20A_PASS_M4P8` | PASS |
| Live compact block has exactly three sanitized lines | `running.seen=true`, `lineCount=3`, `sanitized=true` | PASS |
| Live block contains a non-whitespace assistant fragment | `nonWhitespaceActivity=true`; preview `TASK 20 A _PASS _M 4 P 8` (streaming) | PASS |
| Live status observed before settlement | `runningStatusSeen=true`; `runningEllipsisCount=191` then one non-ellipsis live sample | PASS |
| Settled compact block has exactly three sanitized lines | `settled.seen=true`, `lineCount=3`, `sanitized=true` | PASS |
| Final tail is the authoritative terminal response | settled activity SHA-256 `e6316d0ed93b00fcc75f785408507cb200756fc354e4a2b77d253fb76d90be01` matches `TASK20A_PASS_M4P8` | PASS |
| Terminal status / identity / run metadata | `weave_delegate · shuttle-mini · completed` / `TASK20A_PASS_M4P8` / `run 1 · start` | PASS |
| Compact block exposes no path | `forbiddenPath=false` in live and settled samples | PASS |
| Compact block exposes no native session ID | `nativeSessionId=false` in live and settled samples | PASS |
| Sampler stores no prompt or transcript | `sampleStoredPromptOrTranscript=false` | PASS |
| No continued spinner/stream mutation after settlement | settled frames remained `completed` with frozen three-line tail | PASS |

## Freeze after reopen/inspect

After settlement, the compact block SHA-256 was `f48130eeafc809760aa508984bb146fb8042ef240408e1cf3893068b41f3d71a` over the three sanitized lines. Opening the child through `Alt+I` / `Enter` mounted the settled overlay (`· SETTLED`) and showed the marker in the overlay body. Closing the overlay left the compact block byte-identical (`unchanged: true`).

| Check | Observed | Outcome |
| --- | ---: | --- |
| Reopen/inspect does not mutate the frozen compact block | before/after SHA-256 identical | PASS |

## Settlement missing and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| `childSettlementMissingCount` | `0` (authoritative completed settlement; no `ChildSettlementMissing`) | PASS |
| No ISO-harness rpc child process remains | `0` matching `task20-pi083-harness` + `--mode rpc` | PASS |
| Runtime Store lease | schema 5 reported `No active lease.` | PASS |
| Created pane closed | `w23:pAW` closed; agent `task20a` gone | PASS |
| Pre-existing panes preserved | `w23:p70 w23:p79 w23:p82 w23:pAR` unchanged | PASS |
| Global Pi 0.84 / other workspaces untouched | no ISO process remained after close | PASS |

```yaml
childProcessRemaining: false
runtimeStoreLeaseActive: false
samplerRunning: false
cleanupPending: false
otherPanesAltered: false
createdPaneClosed: true
```

## Repository checks (detached `a7b72bd` worktree)

Focused compact-render and settlement tests, plus docs link check, were run from a detached temporary worktree at exact subject `a7b72bd` (main working-tree overlay WIP left unstaged):

| Check | Result |
| --- | --- |
| `bun test` `child-compact-render.test.ts` + `repeated-settlement-validator.test.ts` | **22 pass**, 0 fail |
| `bun run docs:check-links` | PASS |

## Acceptance

| Acceptance | Result |
| --- | --- |
| Fresh Herdr pane runs Pi 0.83.0 with exact `a7b72bd` npm-provenance artifact; unsafe override absent; built/installed digests match | PASS |
| Parent delegates deterministic bounded work to `shuttle-mini` that emits enough progress to exercise live compact updates, then returns one terminal marker | PASS |
| Compact block updates in place with bounded live fragments/status and never dumps full transcript or raw prompt | PASS |
| On settlement, the block freezes with correct terminal status, bounded result tail, child/thread identity, duration/metadata as specified, and no continued spinner/stream mutation | PASS |
| Reopening/inspecting the child does not mutate the frozen compact block | PASS |
| `childSettlementMissingCount: 0`; proof records checklist v3, subject/artifact/digests, host, run attempt, sanitized observations, and cleanup | PASS |
| Close only created pane; no created process, Runtime Store lease, or pane remains; pre-existing panes preserved | PASS |
| Focused compact-render/settlement tests and docs links from clean committed source; commit only proof plus hook metadata; pre-existing dirty/untracked WIP remains byte-identical and unstaged | PASS |

## Notes

The plan checkbox for Task 20(a) was not marked. Unrelated overlay WIP in the main working tree was preserved unstaged and verified byte-identical to the pre-run baseline after this proof.
