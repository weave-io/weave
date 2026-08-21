# Task 20(l) Pi `/resume` exclusion proof

**Verdict: PASS**

Checklist row `S061`. Run attempt `2` against exact subject `a7b72bd` in the isolated Pi 0.83 harness. This replaces the earlier BLOCKED draft that never opened the real `/resume` selector and used a different artifact.

This proof contains no raw delegated task bodies beyond the short titles and markers needed to identify rows.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Working tree at run time | clean before this proof rewrite |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist row | `S061` |
| Run attempt | `2` |
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
| Fresh test-created pane | `w23:pAP` | PASS |
| Herdr agent | `task20l` (`herdr agent start --kind pi`) | PASS |
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
| Proof `XDG_DATA_HOME` | `/Users/jose/Library/Application Support/weave-task20-xdg` (symlink-free; same pattern as item (k)) | PASS |
| Same pane retained | `true` | PASS |
| Nested Pi processes launched by the parent agent turn | `0` | PASS |
| Production files edited | `0` | PASS |

## Native children created through parent delegation

Exactly two bounded `shuttle-mini` children were created by prompting the live Pi parent to delegate.

| Child | Logical id | Native session id | Title | Marker | Status |
| --- | --- | --- | --- | --- | --- |
| A | `7d159a23-4c86-43b1-9e72-32c803975284` | `019fd850-b88e-7654-988e-6cc2c4a9e300` | `TASK20L CHILD A` | `TASK20L_A_OK` | `completed` |
| B | `1196c520-9a6c-4326-a6e0-1151ef5b69dd` | `019fd850-daa9-7100-9b47-9d4b8b3f2848` | `TASK20L CHILD B` | `TASK20L_B_OK` | `completed` |

| Check | Observed | Outcome |
| --- | ---: | --- |
| Origin parent session id | `019fd850-644b-7c3d-b46a-04eccc01a854` | PASS |
| Parent host path | `$ISO/pi-agent/sessions/2026-08-06T18-22-55-051Z_019fd850-644b-7c3d-b46a-04eccc01a854.jsonl` | PASS |
| Native child directories under proof XDG | `…/weave/adapters/pi/sessions/<logical-id>/…jsonl` | PASS |
| Native header `version` | `3` | PASS |
| Native header `parentSession` | both children point at `019fd850-644b-7c3d-b46a-04eccc01a854` | PASS |
| Native file mode | `0600` | PASS |
| Host session count | `20` | PASS |
| Private-to-host session-id overlap | `0` | PASS |
| Child native ids present as host session files | `false` | PASS |
| Post-settlement `/weave:status` | `children: 2` (both completed) | PASS |
| `/weave:history` rows for A/B | present as completed | PASS |

## Real `/resume` selector

Pi's documented `/resume` route opened the real `Resume Session` selector in the same pane.

| Check | Observed | Outcome |
| --- | ---: | --- |
| Selector opened | `Resume Session (Current Folder)` with scope/name/sort chrome | PASS |
| Default list count | `(1/20)` | PASS |
| Expected parent rows present | current TASK20L parent plus prior harness parents | PASS |
| Path display (`ctrl+p` on) | every visible path under `$ISO/pi-agent/sessions/` | PASS |
| Private/XDG/adapter paths in selector | `0` | PASS |
| Child native ids in selector section | absent (`019fd850-b88e`, `019fd850-daa9`) | PASS |
| Child logical ids in selector section | absent as session rows | PASS |
| Filter `7d159a23` (Current Folder) | `No sessions in current folder.` | PASS |
| Filter `1196c520` (Current Folder) | `No sessions in current folder.` | PASS |
| Filter `019fd850-b88e` (Current Folder) | `No sessions in current folder.` | PASS |

Parent first-message previews may mention child titles because those titles appear in the parent prompt text. That is parent content, not a Weave child session row. With path display on, no child storage path appeared.

## Parent resume does not activate or mutate children

Before any direct child-path probe, child file SHA-256 digests were recorded:

| Child | SHA-256 |
| --- | --- |
| A | `fdddf70368e34e41e13c7b63fc5031ff18f7b883a5562af0c083afefa6e2783d` |
| B | `6b6d0292344d1319828b971f868a049bf76092f4b5a9598e860a848e1ba89905` |

Selecting a different host parent (TASK20K session `019fd849-743c-72a4-8e18-43965eee4989`) showed `Resumed session`. `/weave:status` on that parent reported `children: 0`. Both child digests still matched the pre-resume snapshot. No child overlay activated.

Later, the original TASK20L parent was reselected from `/resume` and resumed again (`Resumed session`). `/weave:status` returned `children: 2` with both TASK20L completed rows. `/weave:history` still listed both children. Children remained reachable through Weave inspection/history only.

## Direct child resume / discovery contract

| Attempt | Observed | Outcome |
| --- | ---: | --- |
| `pi --session 019fd850-b88e -p …` | `No session found matching '019fd850-b88e'` (exit `1`) | PASS |
| `pi --session 7d159a23-4c86-43b1-9e72-32c803975284 -p …` | `No session found matching '…'` (exit `1`) | PASS |
| Absolute `--session` path under private XDG | Host opened the file; Weave activated `healthOnlyMode:true` in print mode | PASS (fail-closed Weave mode; not a `/resume` row) |

The absolute-path print probe appended to child A after the parent-resume non-mutation check. Child B kept its pre-resume digest. Parent-link headers remained intact for both children.

## Repository checks

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused resume-origin + native-session tests | `97` pass (`resume-origin.integration`, `child-native-sessions`, `native-session-fs`) | PASS |
| `bun run docs:check-links` | pass | PASS |

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Residual `ChildSettlementMissing` | `0` | PASS |
| Active Runtime Store lease | `false` (schema `5`) | PASS |
| Closed only the created pane | `w23:pAP` | PASS |
| Pre-existing panes preserved | `w23:p79 w23:p70 w23:p82 w23:pAN` | PASS |
| Created agent after close | `agent_not_found` | PASS |
| Residual harness processes | `0` | PASS |
| Global Pi version after cleanup | `0.84.0` | PASS |
| Task temporary files | removed | PASS |

## Acceptance mapping

| Acceptance criterion | Result |
| --- | --- |
| Fresh Herdr pane runs Pi 0.83.0 with exact `a7b72bd` npm-provenance artifact; unsafe override absent; digests match | PASS |
| Parent delegates ≥2 `shuttle-mini` children; native dirs/headers exist with parent links | PASS |
| `/resume` opens the real selector and shows expected parent rows | PASS |
| No Weave child title/id/path appears as a selectable session in search, default list, or filtered results | PASS |
| Selecting/resuming a parent does not activate a child or mutate child refs; children stay Weave-only | PASS |
| Direct discovery resume of a child ref/id is rejected; absolute private path is not a `/resume` entry and Weave stays fail-closed | PASS |
| `childSettlementMissingCount: 0`; proof records checklist v3, subject/artifact/digests, host, run attempt, sanitized selector observations, cleanup | PASS |
| Close only created pane; no created process/lease/pane remains; pre-existing panes preserved | PASS |
| Focused tests and docs links run; proof committed; plan checkbox not marked | PASS |
