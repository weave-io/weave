# Task 20(j) `--no-session` read-only proof

**Verdict: PASS**

Checklist rows `S056` and `S057`. Run attempt `1` against exact subject `a7b72bd` in the isolated Pi 0.83 harness.

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
| Checklist rows | `S056`, `S057` |
| Run attempt | `1` |
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
| Fresh test-created pane | `w23:pAJ` | PASS |
| Herdr agent | `task20j` (`herdr agent start --kind pi -- --no-session`) | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| Active argv | `["pi","--no-session"]` | PASS |
| Process command lines | both Bun/Pi lines end in `pi-coding-agent/dist/cli.js --no-session` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` in pane prep and process environment | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi"]` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js` | PASS |
| Status line | `ready ◆ WEAVE · LOOM` | PASS |
| `/weave:health` mode | `ready` | PASS |
| Trusted | `true` | PASS |
| Health-only | `false` | PASS |
| `child inspection` | `native-overlay` | PASS |
| Open parent `.jsonl` files for the Pi process | `0` | PASS |
| Open files under `sessions/` for the Pi process | `0` | PASS |
| Same pane retained | `true` | PASS |
| Nested Pi RPC child processes from this parent | `0` | PASS |
| Production files edited | `0` | PASS |

## Persistent-parent proof

Isolated session tree and Weave data tree were unchanged across the delegation attempt and all read-only UI checks:

| Surface | Before | After | Outcome |
| --- | ---: | ---: | --- |
| `$ISO/pi-agent/sessions` file count | `16` | `16` | PASS |
| `$ISO/pi-agent/sessions` path-manifest SHA-256 | `bdc18b51dc7941c46ee936e1f40a1f20dfffdc7a1a042df6a12907cbff23cfc7` | same | PASS |
| `$XDG_DATA_HOME/weave` path-manifest SHA-256 | `19fb6a5cdd893ccad5403ba0fff1494dbc7ee0adc459fc4fd0b1b6f596c94d8c` | same | PASS |

A child ref requires a persistent parent session entry. This parent had no persistent session file to receive one, and no child-session path was added.

## One real delegation attempt

Exactly one real `weave_delegate` call targeted `shuttle-mini`. Its task text is intentionally omitted.

The structured result was:

```text
ok: false
error: PersistentParentSessionRequired
reason: host-reports-not-persisted
retryable: false
recovery: none
```

The bounded remediation instructed the operator to start or reopen Pi with a persistent session (do not use `--no-session`). No second delegation, retry, or continue call was made. Direct slot `Alt+1` produced no child target.

## No child or lease side effects

| Check | Observed | Outcome |
| --- | ---: | --- |
| Parent-descendant `--mode rpc --no-session` processes | `0` | PASS |
| `/weave:status` children | `0` | PASS |
| Active Runtime Store lease | `false` (`No active lease.`; schema `5`) | PASS |
| Persistent parent session file created | `false` | PASS |
| Child session / child ref created | `false` | PASS |
| Residual `ChildSettlementMissing` | `0` | PASS |

## Read-only UI proof

| Command | Sanitized outcome | Result |
| --- | --- | --- |
| `/weave:history` | `No child history for this workspace.` | PASS |
| `/weave:doctor` | Bounded report: status `degraded`; capabilities `ok=12` / `unavailable=8`; optional doctor sources skipped as unwired. Remained usable; did not enter health-only. | PASS |
| `/weave:inspect` | Native `Weave child inspection` overlay with navigation help and empty execution view. Escape closed it cleanly. | PASS |
| `/weave:health` | Adapter mode `ready`. | PASS |
| `/weave:status` | `trust: trusted`; `health-only: false`; `children: 0`. | PASS |
| `/weave:clear-children` | Read-only no-op: `No terminal child history to clear.` | PASS |

Empty history and empty inspection prove there was no child target. Therefore child steering, follow-up, delete, retry, and continue routes were not exposed. The only child-creation mutation attempted was the single `weave_delegate` call, and it returned `PersistentParentSessionRequired`. No retry or continue action was possible without a thread identifier, and the failed delegation created none.

Footer remained `ready ◆ WEAVE · LOOM` after each command. No false write capability was advertised.

## Repository checks

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused no-session/capability tests | `90` pass (`primary-session`, `delegation-tool`, `failure-taxonomy`) | PASS |
| `bun run docs:check-links` | pass | PASS |

## State and cleanup

| Check | Observed | Outcome |
| --- | ---: | --- |
| Closed only the created pane | `w23:pAJ` | PASS |
| Pre-existing panes preserved | `w23:p79 w23:p70 w23:p82` | PASS |
| Created agent after close | `agent_not_found` | PASS |
| Residual harness processes | `0` | PASS |
| Global Pi 0.84 / global `~/.pi/agent` | untouched | PASS |
