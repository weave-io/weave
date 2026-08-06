# Task 20(j)/21 `--no-session` read-only proof — PASS

## Verdict

**PASS.** On 2026-08-06, the owned pane ran Pi 0.83.0 with `--no-session` and the exact installed npm artifact. Weave was trusted, ready, and not health-only. The one real `weave_delegate` attempt failed closed with `PersistentParentSessionRequired` before it created a child. Read-only child UI remained available. No child process, Runtime Store lease, child session, child ref, or persistent parent session file resulted from the attempt.

This proof contains no raw user prompt, delegated task text, or transcript content.

## Scope and starting state

- Owned pane: `w23:p9Q`; no other pane was used or created.
- Pre-proof repository parent: `548bc414901975247a836b3768a12571a82acbdc`.
- The working tree was clean before this proof.
- No production source file was changed.
- The pane remains open.

## Host, trust, provenance, and editor

| Check | Sanitized evidence | Result |
| --- | --- | --- |
| Pi version | `pi --version` returned `0.83.0`. | PASS |
| Process mode | Both active Bun/Pi command lines ended in `pi-coding-agent/dist/cli.js --no-session`. | PASS |
| Project trust | `~/.pi/agent/trust.json` records `/Users/jose: true`, which applies to this project. The live adapter reached `ready`; withheld trust fails closed to health-only. | PASS |
| Weave health | `/weave:health` reported `Weave adapter mode: ready`; the footer remained `Connected  ready  ◆ WEAVE · LOOM`. | PASS |
| Not health-only | The health report and footer both reported `ready`, not `health-only`. | PASS |
| npm provenance | `~/.pi/agent/settings.json` contains exactly one `npm:@weaveio/weave-adapter-pi` entry. No local `~/.pi/agent/extensions/weave-adapter-pi` shadow exists. | PASS |
| Unsafe override | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from the active environment, active process environment, launcher, settings, and `~/.zshrc`. | PASS |
| pi-vim coexistence | The footer showed `INSERT` before and after the inspector and palette overlays. Weave remained ready. | PASS |

### Exact installed artifact

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Artifact: `~/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz`
- Artifact SHA-256: `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6`
- Installed `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`
- Installed `dist/index.js`: `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e`
- Installed `dist/cli.js`: `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd`
- Extracting `package/dist/extension.js` from that artifact produced the installed `dist/extension.js` hash.

## Persistent-parent proof

The active parent had no persistent session file before or after the attempt:

- Active command line included `--no-session`.
- Open `.jsonl` files for the Pi process: `0`.
- Open files below `~/.pi/agent/sessions/` for the Pi process: `0`.
- Session filenames matching the active ephemeral session identifier: `0`.

The private child-session file manifest was unchanged across the delegation attempt:

- Before: 115 files; path-manifest SHA-256 `a274ec15c96098d7307832fcbd4701cf2114cf126778ffd004fcad35f6238936`.
- After the attempt and all read-only UI checks: 115 files; the same path-manifest SHA-256.

A child ref requires a persistent parent session entry. This parent had no persistent session file to receive one, and no child-session path was added. Therefore the attempt created neither a child session nor a child ref.

## One real delegation attempt

Exactly one real `weave_delegate` call was made. Its task text is intentionally omitted.

The structured result was:

```text
ok: false
error: PersistentParentSessionRequired
reason: host-reports-not-persisted
retryable: false
recovery: none
```

The remediation instructed the operator to start or reopen Pi with a persistent session. No second delegation, retry, or continue call was made.

## No child or lease side effects

Immediately after the attempt and again after the UI checks:

- Pi RPC child processes matching `--mode rpc --no-session`: `0`.
- `weave runtime status`: Runtime Store schema `5`; `No active lease.`
- Private child-session file count and path manifest: unchanged.
- Persistent parent session file: absent.
- Parent child ref: absent because no persistent parent file existed and no child-session path appeared.

The Runtime Store contains old workflow records, but none holds an active lease. Those records predate this proof and are not child processes or child-session refs from this attempt.

## Read-only UI proof

The commands were entered in the active owned TUI while the agent was running. Pi executes extension commands immediately rather than queueing them as prompts.

| Command | Sanitized outcome | Result |
| --- | --- | --- |
| `/weave:history` | Returned `No child history for this workspace.` | PASS |
| `/weave:doctor` | Opened and returned a bounded report: status `degraded`, 12 capability checks passed, 8 were unavailable, and unwired optional sources were skipped. The command remained usable and did not put Weave in health-only mode. | PASS |
| `/weave:inspect` | Opened the native `Weave child inspection` overlay with navigation help and an empty execution view. Escape closed it cleanly. | PASS |
| `/weave:health` | Reported adapter mode `ready`. | PASS |

The empty history and inspector prove that there was no child target. Therefore child steering, follow-up, delete, retry, and continue routes were not exposed. The exposed child-creation mutation was the single `weave_delegate` call, and it returned `PersistentParentSessionRequired`. `/weave:clear-children` also performed a read-only no-op and reported `No terminal child history to clear.` It created no state. No retry or continue action was possible without a thread identifier, and the failed delegation created none.

After each overlay closed, pi-vim returned to `INSERT`; the footer remained `Connected  ready  ◆ WEAVE · LOOM`.

## Commands and results

The verification used these command classes. Dynamic IDs and transcript data are omitted.

```bash
pi --version
ps -p <pi-pid> -o pid=,ppid=,command=
lsof -p <pi-pid>
jq <bounded provenance/trust queries> ~/.pi/agent/settings.json ~/.pi/agent/trust.json
shasum -a 256 <installed files and matching artifact>
find "$XDG_DATA_HOME/weave" -type f | LC_ALL=C sort | shasum -a 256
ps -axo command= | awk <bounded rpc-child predicate>
weave runtime status
herdr pane send-text <owned-pane> '/weave:history'
herdr pane send-text <owned-pane> '/weave:doctor'
herdr pane send-text <owned-pane> '/weave:inspect'
herdr pane send-text <owned-pane> '/weave:health'
bun run docs:check-links
```

Expected results:

- Pi `0.83.0`; active parent command line includes `--no-session`.
- Exact npm artifact and installed hashes match.
- Adapter mode `ready`; no health-only state.
- Zero open parent session files, child RPC processes, active leases, new child-session paths, and child refs.
- Documentation link check passes.

## Conclusion

Task 20(j)/21 passes. The Pi adapter fails closed at the persistent-parent boundary, preserves read-only child surfaces, creates no unattached child state, retains trusted npm provenance, and coexists with pi-vim in the owned `--no-session` pane.
