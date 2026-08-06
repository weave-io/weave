# Task 20(k) history, doctor, and CLI proof

**Verdict: PASS**

Checklist rows `S063`, `S064`, `S065`, and `S066`. Run attempt `2` against exact subject `a7b72bd` in the isolated Pi 0.83 harness. This replaces the earlier FAIL draft that used a different artifact and hit `CacheUnavailable`.

This proof contains no raw user prompt, delegated task text, or transcript content.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Working tree at run time | clean before proof file rewrite |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| Checklist version | `3` |
| Checklist rows | `S063`, `S064`, `S065`, `S066` |
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
| Fresh test-created pane | `w23:pAM` | PASS |
| Herdr agent | `task20k` (`herdr agent start --kind pi`) | PASS |
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
| Nested Pi RPC child processes from this parent | `0` | PASS |
| Production files edited | `0` | PASS |

### Symlink-free proof `XDG_DATA_HOME`

The host default data home resolves through `~/.local -> dotfiles/.local`. The production metadata-cache filesystem walks every path component with `O_NOFOLLOW`, so that symlink fails closed as `CacheUnavailable` / doctor `cache mode degraded`. Attempt 1 in this continuation reproduced that host failure before any child projection.

For attempt 2, the pane exported a symlink-free proof data home:

```text
XDG_DATA_HOME=/Users/jose/Library/Application Support/weave-task20-xdg
```

With that harness env, doctor reported `doctor.cache: pass — cache mode active`, and CLI list/show/delete used the exact installed adapter ports against the same cache root. Global Pi 0.84 and the default host XDG tree were not modified for production use.

## Baseline

Before the disposable child:

| Surface | Baseline |
| --- | --- |
| `/weave:status` children | `0` |
| `/weave:history` | `No child history for this workspace.` |
| `/weave:doctor` cache | `pass — cache mode active` |
| CLI `children list` | `No children found for this workspace.` |
| CLI `children list --json` SHA-256 | `1274da0132bb1435cf86548e5e9769ca7ea366fd0511349a60240bf333ce361e` |
| Native sessions under proof XDG | `0` |
| Active Runtime Store lease | none (schema `5`) |

## Disposable children

Exactly two bounded `shuttle-mini` children were created by prompting the live Pi parent to delegate. Marker text and task bodies are omitted.

| Child role | Sanitized identity | Terminal status |
| --- | --- | --- |
| Primary disposable | `63ab7275-dabe-4164-9be7-6e9652559235` / title `TASK20K CHILD` | `completed`, then `tombstoned` |
| Orphan/stale fixture | `d6a30f80-5763-48fe-8c1d-5f49cd44f8a7` / title `TASK20K ORPHAN SRC` | `completed`, later used for stale/orphan, then `tombstoned` |

Origin parent session id for both: `019fd849-743c-72a4-8e18-43965eee4989`.

## Live TUI checks

### `/weave:history`

After the primary child settled, history returned one bounded row:

```text
63ab7275-dabe-4164-9be7-6e9652559235  completed  TASK20K CHILD
```

`/weave:inspect` listed `history: TASK20K CHILD [settled]` and opened a read-only completed overlay. Direct slot `Alt+1` was not required for the open path after picker selection.

After delete, history retained the tombstone representation:

```text
63ab7275-dabe-4164-9be7-6e9652559235  tombstoned (tombstone)  TASK20K CHILD
```

The inspect picker no longer offered a product open target for that child. `Alt+1` reported `no matching child`.

### `/weave:doctor`

Post-settlement (source parent, cache active):

```text
Doctor status: degraded
doctor.capabilities: fail — ok=12 degraded=0 unavailable=8
doctor.permissions: pass — session root resolved
doctor.sessions: pass — available=1 missing=0 corrupt=0 unavailable=0
doctor.refs: pass — scanned=9 usable=1 malformed=0 conflict=0 originMismatch=0 unusable=0
doctor.cache: pass — cache mode active
doctor.stale: pass — scanned=1 stale=0 tombstoned=0
doctor.orphans: pass — scanned=1 orphans=0 bound=50
```

After primary delete:

```text
doctor.refs: pass — scanned=9 usable=0 malformed=0 conflict=0 originMismatch=0 unusable=1
doctor.cache: pass — cache mode active
doctor.stale: pass — scanned=1 stale=0 tombstoned=1
doctor.orphans: pass — scanned=1 orphans=0 bound=50
```

Reports contained only bounded counters and status text. No paths, prompts, or transcript data.

## Real CLI checks

Commands used the workspace `weave adapter pi …` router over the installed `@weaveio/weave-adapter-pi` digests above, with the same proof `XDG_DATA_HOME`.

### Children list / show

After the primary child settled:

```text
63ab7275-dabe-4164-9be7-6e9652559235  completed  TASK20K CHILD
```

JSON list SHA-256: `2e66689fdbf685f15d3bc8c083812b0641a36a5c62e791de63a8eb6d18b3b953`. Rows carried metadata only (`childId`, `threadId`, `title`, `status`, timestamps, origin parent, `tombstoned`, `stale`). No `sessionPath` by default.

Show returned newest entry summaries without content payloads (5 entries: `custom`, `model_change`, `thinking_level_change`, two `message` ids). JSON show SHA-256: `2d863c17fcaaf16dcc4a78fa1d64ea253a3fdac63bd83871a9758f489363481c`. The payload contained no marker text, prompt text, or transcript bodies.

### Children delete and tombstone

Delete without `--yes` in a non-interactive shell refused mutation:

```text
Interactive mode is unavailable. Re-run with --yes to delete without a prompt.
```

Delete with `--yes` appended a tombstone and reported:

```text
Tombstoned child 63ab7275-dabe-4164-9be7-6e9652559235 at 2026-08-06T18:16:28.522Z.
```

Ledger path under the proof XDG retained one append-only JSONL object with `reason: explicit-user-deletion` and no transcript fields. The native session file count stayed `1` for that child (no recursive deletion).

Repeated delete returned typed fail-closed:

```text
Unavailable: CacheEntryUnusable
```

List/show retained a tombstoned representation (`status: tombstoned`, `tombstoned: true`, show `entries: []`). Direct open remained unavailable.

### Controlled stale case

The orphan-src native session directory was moved aside briefly. Show returned `Unavailable: CacheEntryUnusable`. List marked `stale: true`. Doctor reported:

```text
doctor.stale: fail — scanned=2 stale=1 tombstoned=1
doctor.refs: pass — scanned=15 usable=0 malformed=0 conflict=0 originMismatch=0 unusable=2
```

Restoring the directory cleared the stale show path (`completed` again).

### Controlled orphan / origin-mismatch case

Pi `/clone` produced `Cloned to new session`. On the clone-derived parent:

```text
/weave:status children: 0
doctor.refs: fail — scanned=16 usable=0 malformed=0 conflict=0 originMismatch=2 unusable=0
doctor.orphans: pass — scanned=2 orphans=2 bound=50
doctor.cache: pass — cache mode active
doctor.stale: pass — scanned=2 stale=0 tombstoned=1
```

Workspace CLI list still returned the bounded cache rows (completed orphan-src + tombstone) without path leakage. Source-origin children were not active children of the clone.

The orphan-src child was then tombstoned with `--yes` for cleanup discipline. Tombstone ledger lines: `2`. Both native session trees remained on disk under the proof XDG.

## Repository checks

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused history/doctor/CLI/tombstone tests | `77` pass across `child-metadata-cache`, `child-doctor`, `adapter-cli-commands`, `adapter-cli-production`, `child-session-reconstruction` | PASS |
| `bun run docs:check-links` | pass | PASS |

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Residual `ChildSettlementMissing` | `0` | PASS |
| Active Runtime Store lease | `false` | PASS |
| Closed only the created pane | `w23:pAM` | PASS |
| Pre-existing panes preserved | `w23:p79 w23:p70 w23:p82` | PASS |
| Created agent after close | `agent_not_found` | PASS |
| Residual isol harness processes | `0` | PASS |
| Attempt-1 blocked pane | `w23:pAK` closed earlier after host-symlink cache failure | PASS |

## Acceptance matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Pi 0.83, trusted exact `a7b72bd` npm artifact | PASS | Version, package entry, artifact, and installed hashes verified. |
| Unsafe provenance override absent | PASS | Launcher unsets it; process env absent. |
| Ready, not health-only | PASS | Live footer and `/weave:status`. |
| Parent delegates bounded `shuttle-mini` work | PASS | One primary settled child with status/title/id in history. |
| `/weave:history` bounded row + inspect open | PASS | Completed row; settled read-only overlay. |
| `/weave:doctor` bounded counters | PASS | Usable/stale/orphan/tombstone/origin-mismatch distinguished. |
| CLI list finds child; show metadata-only | PASS | Newest-50 list; show entries without content leakage. |
| Delete confirms / `--yes`, tombstones, no recursive wipe | PASS | Non-interactive refusal; `--yes` appends ledger; session retained. |
| Repeat delete fail-closed | PASS | `CacheEntryUnusable`. |
| After delete: picker/direct open unavailable; doctor tombstone | PASS | `no matching child`; `tombstoned=1`. |
| Controlled stale + orphan/origin-mismatch | PASS | Missing-session stale; `/clone` orphans=`2`, `originMismatch=2`. |
| `childSettlementMissingCount: 0` | PASS | Runtime journal and settlement path. |
| Cleanup | PASS | Created pane closed; pre-existing panes kept; no isol process/lease. |

## Conclusion

Task 20(k) passes on exact subject `a7b72bd` when the proof harness uses a symlink-free `XDG_DATA_HOME`. Host default `~/.local` symlink layout still fails closed for the metadata cache and must not be treated as a green CLI path on this machine without that isolation. No production source changed. The plan checkbox was not marked.
