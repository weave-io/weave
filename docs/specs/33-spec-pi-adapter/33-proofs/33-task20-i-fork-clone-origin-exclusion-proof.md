# Task 20(i) fork/clone origin-exclusion proof

**Verdict: PASS**

Checklist row `S059`. Run attempt `3` against exact subject `a7b72bd` in the isolated Pi 0.83 harness.

This attempt rebuilds and installs the production subject that adds parent-local status/history reconstruction after a source return. Fork and clone exclusion still hold. Returning to the unchanged source parent now yields `/weave:status children: 1`, one completed `/weave:history` row, and an inspectable settled overlay for the original child. Destination-owned children never appear in the source. Repeating clone↔source navigation does not duplicate refs or history rows.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Working tree at run time | only this proof file dirty (attempt-2 FAIL draft being replaced) |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist row | `S059` |
| Run attempt | `3` |
| `childSettlementMissingCount` | `0` |

| Field | Verified value |
| --- | --- |
| Artifact | `$ISO/pi-agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-a7b72bd-task20iso-0f7fbf77cb99.tgz` |
| Artifact SHA-256 | `0f7fbf77cb99d38ecbf952c46b16da2fffb3308f2ce346d5e35b9040e0c6deec` |
| Built and installed `dist/extension.js` SHA-256 | `0dff94ac4167e8f2d7ecbafcfd91f1a1895b5c782ffa747043d872547d300314` |
| Built and installed `dist/index.js` SHA-256 | `c654510917e651c09f22c6b19d52bda6a0f6f9dabda8436ee91aa8af1b9bc1be` |
| Built and installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |

`$ISO` is `$HOME/.local/share/weave/task20-pi083-harness`. Tarball entry digests matched the installed entry points. Unsafe provenance override was unset. No local extension shadow directory existed.

## Environment

| Check | Observed | Outcome |
| --- | ---: | --- |
| Fresh test-created pane | `w23:pAH` | PASS |
| Herdr agent | `task20i` (`herdr agent start --kind pi`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi"]` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:health` mode | `ready` | PASS |
| Trusted | `true` | PASS |
| Health-only | `false` | PASS |
| `child inspection` | `native-overlay` | PASS |
| Same pane retained | `true` | PASS |
| Nested Pi processes launched | `0` | PASS |
| Production files edited | `0` | PASS |

## Source child baseline

One bounded `shuttle-mini` child was created by prompting the live Pi parent to delegate.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Bounded shuttle-mini children created | `1` | PASS |
| Completed logical children | `1` | PASS |
| Durable child-ref envelopes | `2` | PASS |
| Durable logical child refs | `1` | PASS |
| Terminal child status | `completed` | PASS |
| Pre-transition `/weave:status` child count | `1` | PASS |
| Source session id | `019fd83a-e5b0-70b3-b80d-ad5e97a5293e` | PASS |
| Source fingerprint SHA-256 | `57b8df4b0eabcd7bb68a10d77e99c34c1249907f9bed2222cfb2c385ad1344fe` | PASS |
| Source ref SHA-256 | `83ab8c4726b64d519179dbca784e8dad58a706f7b0cd250ef5e90377ab8780ae` | PASS |
| Final output marker | `SRC_CHILD_OK` | PASS |

## Clone-derived parent

Pi's documented `/clone` route was used in the same pane. Observed: `Cloned to new session`.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Route completed | `true` | PASS |
| Parent link matched source | `true` | PASS |
| Fingerprint differed from source | `true` | PASS |
| Clone session id | `019fd83b-a37a-7b6c-97cd-980e9223e5d7` | PASS |
| Clone fingerprint SHA-256 | `ff22172f920175ed214d34d290989d5eaaeff88d12e930a6673d2b1af1751ad7` | PASS |
| Imported ref envelopes retained | `2` | PASS |
| Imported logical children retained | `1` | PASS |
| Source origin retained | `true` | PASS |
| Doctor `originMismatch` | `1` | PASS |
| Doctor `usable` | `0` | PASS |
| `/weave:status` active children | `0` | PASS |
| Source history rows | `0` | PASS |
| Source picker rows | `0` (`No Weave children are available to inspect.`) | PASS |
| Direct slot `Alt+1` | ignored (`no matching child`) | PASS |
| Sibling keys `Alt+H`/`Alt+L` | ignored (`no matching child`) | PASS |
| Source overlay mounted | `false` | PASS |

## Fork-derived parent

Pi's documented `/fork` route was used in the same pane from the clone-derived parent. Observed: `Forked to new session`.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Route completed | `true` | PASS |
| Parent link matched selected source (clone) | `true` | PASS |
| Fingerprint differed from source | `true` | PASS |
| Fingerprint differed from clone | `true` | PASS |
| Fork session id | `019fd83c-0a67-7025-bea9-74b74501fd1f` | PASS |
| Fork fingerprint SHA-256 | `96824ceadd4915f0d97c6bd10f90778b96657e51d0a8f12aa723b76419704637` | PASS |
| Imported ref envelopes retained | `0` (path truncated at the selected user message) | PASS |
| `/weave:status` active children | `0` | PASS |
| Doctor source-origin usable refs | `0` | PASS |
| Doctor `originMismatch` | `0` | PASS |
| Source picker rows | `0` | PASS |
| Direct/sibling keys | ignored (`no matching child`) | PASS |
| Source overlay mounted | `false` | PASS |

## Destination child does not leak to source

A second `shuttle-mini` child (`TASK20I DEST CHILD` / `DEST_CHILD_OK`) was created while the clone parent was live.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Clone `/weave:status` children | `1` (destination child only) | PASS |
| Clone picker rows | `1` (`TASK20I DEST CHILD...`) | PASS |
| Clone doctor usable / originMismatch | `1` / `1` | PASS |
| Source durable refs after return | still only the original source child | PASS |
| Source picker after return | only `TASK20I SRC CHILD...` | PASS |
| Source doctor usable / originMismatch | `1` / `0` | PASS |

## Return to the source parent

| Check | Observed | Outcome |
| --- | ---: | --- |
| Reopened source parent | `true` | PASS |
| Source fingerprint matched handoff | `true` | PASS |
| Source fingerprint SHA-256 | `57b8df4b0eabcd7bb68a10d77e99c34c1249907f9bed2222cfb2c385ad1344fe` | PASS |
| Source ref SHA-256 matched handoff | `true` | PASS |
| Durable child-ref envelopes | `2` | PASS |
| Durable logical child refs | `1` | PASS |
| Terminal child status | `completed` | PASS |
| `/weave:status` child count | `1` | PASS |
| `/weave:history` completed rows | `1` | PASS |
| `/weave:history` empty notice | `false` | PASS |
| History row identity | `8f8a1522-10d1-48bb-beb1-a5cae6f1eb75 completed TASK20I SRC CHILD...` | PASS |
| `/weave:inspect` picker opened | `true` | PASS |
| Source child selectable | `true` | PASS |
| Source overlay opened | `true` | PASS |
| Source overlay showed completed state | `true` (`SETTLED`, `SRC_CHILD_OK`) | PASS |

## Repeated navigation stays idempotent

Clone↔source resume was repeated after the first successful return. Source projections stayed at one completed child; source durable refs stayed at two envelopes / one logical child; destination child ids never entered the source session.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Source `/weave:status` after repeat | `children: 1` (source child only) | PASS |
| Source `/weave:history` after repeat | one completed source-child row | PASS |
| Clone `/weave:status` during repeat | `children: 1` (destination child only) | PASS |
| Source ref envelopes / logical children | `2` / `1` (unchanged) | PASS |
| Destination child id in source refs | absent | PASS |

## Repository checks

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused reconstruction tests | `15` pass (`child-session-reconstruction.test.ts`) | PASS |
| Origin/doctor/ref tests | `62` pass (`child-doctor`, `resume-origin.integration`, `child-session-refs`) | PASS |
| `bun run docs:check-links` | pass | PASS |

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Residual `ChildSettlementMissing` | `0` | PASS |
| Active Runtime Store lease | `false` | PASS |
| Closed only the created pane | `w23:pAH` | PASS |
| Pre-existing panes preserved | `w23:p70 w23:p79 w23:p82` | PASS |
| Created agent after close | `agent_not_found` | PASS |
| Residual harness processes | `0` | PASS |
