# Task 20(n) health-only read-only proof

**Verdict: PASS**

Checklist version `3`. Matrix item `(n)` (health-only read-only history/doctor with one artificially failed required capability), covering related smoke rows `S057` (read-only history/picker/doctor in health-only) and `S067` (missing required capability enters health-only with capability, version, contract, probe, mode, and remediation). Run attempt `2` against exact subject `a7b72bd` in the isolated Pi 0.83 harness. This replaces the earlier proof bound to artifact `1f69937` / `636b8fac98ce…`.

This proof contains no raw prompt, delegated task text, transcript body, session path beyond harness roots, child identifier, or unsanitized diagnostic path.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Subject HEAD | `a7b72bd7e6eb84de6bd8f71bdd52b4fe411f6903` |
| Subject HEAD subject line | `fix(pi): reconstruct child status and history after a source return` |
| Host Pi version in the pane | `0.83.0` |
| Global Pi version (untouched) | `0.84.0` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |
| pi-vim identity | `npm:pi-vim` (isolated settings package list) |
| Checklist version | `3` |
| Checklist rows | `S057`, `S067` (matrix item `(n)`) |
| Run attempt | `2` |
| `childSettlementMissingCount` | `0` |

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
| Fresh test-created pane | `w23:pAS` | PASS |
| Herdr agents | `task20n` (injected), then `task20n2` (restored) via `herdr agent start --kind pi` | PASS |
| Resolved `pi` executable | `$ISO/shim/pi` | PASS |
| Pi version reported in the pane | `0.83.0` | PASS |
| `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` | `unset` | PASS |
| Isolated `settings.json` packages | `["npm:@weaveio/weave-adapter-pi", "npm:pi-vim"]` | PASS |
| Local extension shadow directory | absent | PASS |
| Startup `[Extensions]` line | `@weaveio/weave-adapter-pi:dist/extension.js, pi-vim, task20n-inspect.ts` | PASS |
| Proof `XDG_DATA_HOME` | `/tmp/weave-task20n-a7b72bd.*/xdg` (process-local) | PASS |
| Proof session dirs | `/tmp/weave-task20n-a7b72bd.*/sessions` and `sessions-restored` | PASS |
| Injected generation | `59e59c46-93b4-47e6-a2b5-aecfe6c07f08` | PASS |
| Restored generation | `d045dc22-d585-40ce-ba3a-a48df5161f70` | PASS |
| Production source edited by this proof | `0` | PASS |
| Host | `joses-Apple-MacBook-Pro` / Darwin `25.5.0` arm64 | PASS |

Startup also reported the bounded Pi-owned sibling-key conflict diagnostics and a missing `rose-pine` theme fallback to `dark`. Those notices do not affect this item.

## Reversible failure injection

The supported process-local `pi -e <path>` mechanism loaded one temporary helper at `/tmp/weave-task20n-a7b72bd.*/task20n-inspect.ts`. That helper always registers a bounded inspector command. It registers a duplicate `weave:run` only when this process variable is set:

```text
WEAVE_TASK20N_FAIL_COMMAND_ENTRYPOINTS=1
```

No production source file and no installed artifact byte changed. After injection, Pi exposed `weave:run:1` with temporary provenance and `weave:run:2` with npm-package provenance. The proof invoked only the npm-owned `weave:run:2`. It never invoked the temporary collision handler.

Injected `/weave:status` and status line:

```text
trust: trusted
mode: tui
health-only: true
children: 0
health-only - run /weave:health for details
```

Injected `/weave:health`:

```text
Weave adapter mode: health-only
command-entrypoints: unsupported (declared native)
```

A failed-versus-restored capability comparison had exactly one changed row:

```text
failed:   command-entrypoints | unsupported (declared native)
restored: command-entrypoints | native (declared native)
```

All other reported capability rows were identical. Thus the process had exactly one artificial required-capability failure.

## Read-only surfaces

Fingerprints of the proof `XDG_DATA_HOME` tree, proof session dirs, and installed artifact digests were unchanged across the read-only command sequence and the later mutation attempts (label-only fingerprint differences).

| Surface | Sanitized result | Bound and read-only evidence | Result |
| --- | --- | --- | --- |
| `/weave:history` | `No child history for this workspace.` | One line; no path, prompt, transcript, child identifier, or mutation. | PASS |
| `/weave:doctor` | `Doctor status: degraded` | Bounded rows: capabilities and cache failed; permissions, sessions, refs, stale, and orphans passed. No raw path or identifier retained. | PASS |
| `/weave:health` | Health-only with `command-entrypoints` unsupported. | Bounded capability report; no mutation. | PASS |
| `/weave:status` | Trusted TUI mode with `health-only: true`. | Bounded state report; no mutation. | PASS |
| `/task20n-inspect` | `weave:run:1|temporary`, `weave:run:2|npm-package`; `delegate_registered=false`; `active=none`; `fail_flag=1` | Process-local inspector only; no write path. | PASS |

History was empty, so no child detail, steering, follow-up, delete, retry, or continue control was exposed through child state.

## Mutation and fail-closed checks

| Route | Sanitized result | Result |
| --- | --- | --- |
| `/weave:start` | Rejected: unavailable until required capabilities recover. | PASS |
| npm-owned `/weave:run:2` | Rejected: `weave:run` unavailable until required capabilities recover. | PASS |
| `/weave:advance` | Rejected: unavailable until required capabilities recover. | PASS |
| `/weave:resume` | Rejected: unavailable until required capabilities recover. | PASS |
| `/weave:artifact` | Rejected: unavailable until required capabilities recover. | PASS |
| `/weave:recover-children` | Failed closed: child recovery unavailable in this session. | PASS |
| `/weave:abort` | Read-only no-op: no active Weave execution. | PASS |
| `/weave:clear-children` | Read-only no-op: no terminal child history. | PASS |
| Bare `/weave` palette | Start Plan / Run Workflow carried the health-only disabled reason and did not start work. | PASS |
| Primary-agent cycle | Alt+A reported primary-agent cycling unavailable in this session. | PASS |
| `weave_delegate` start/retry/continue | Tool absent (`delegate_registered=false`); no thread identifier existed. | PASS |

No child RPC process appeared. `weave runtime status` reported Runtime Store schema 5 and no active lease. Status line never advertised ready/write capability while injected.

pi-vim remained usable in health-only: `INSERT`, delayed Escape to `NORMAL`, then `i` back to `INSERT`.

## Restoration and cleanup

The injected process exited. `WEAVE_TASK20N_FAIL_COMMAND_ENTRYPOINTS` was unset. A fresh TUI in the same owned pane with the same temporary helper (no duplicate command) reported:

```text
ready ◆ WEAVE · LOOM
health-only: false
Weave adapter mode: ready
command-entrypoints: native (declared native)
```

Restored `/task20n-inspect` reported unsuffixed npm-owned `weave:run`, `delegate_registered=true`, and `fail_flag=0`. Restored pi-vim again passed `INSERT → NORMAL → INSERT`.

Final checks:

| Check | Observed | Outcome |
| --- | ---: | --- |
| Closed only the created pane | `w23:pAS` | PASS |
| Pre-existing panes preserved | `w23:p70 w23:p79 w23:p82 w23:pAR` | PASS |
| Created agents after close | `agent_not_found` | PASS |
| Residual proof Pi processes | `0` | PASS |
| Isolated session inventory | unchanged (`21`) | PASS |
| Global Pi session inventory | unchanged (`956`) | PASS |
| Runtime Store active lease | `false` (schema `5`) | PASS |
| `childSettlementMissingCount` | `0` | PASS |
| Global Pi version after cleanup | `0.84.0` | PASS |
| Temporary helper / observations / proof dirs | removed after commit prep | PASS |
| Plan checkbox marked | `false` (not marked) | PASS |

## Repository checks

Focused health-only/capability suites and docs links were run from a detached temporary worktree at exact subject `a7b72bd` (main working-tree WIP left unstaged):

| Check | Observed | Outcome |
| --- | ---: | --- |
| Focused capability / safe-initializer / host-compat / host-probe tests | `101` pass / `0` fail | PASS |
| Filtered extension health-only / command-collision tests | `10` pass / `0` fail (`148` filtered) | PASS |
| `bun run docs:check-links` | pass | PASS |

Unrelated dirty WIP in `child-overlay-component.ts`, `extension.ts`, and `render-width.ts` was verified to match the pre-run SHA-256 digests and remained unstaged. Concurrent unrelated edits outside those three files were not staged by this proof.

## Acceptance mapping

| Acceptance criterion | Result |
| --- | --- |
| Fresh Herdr pane runs Pi 0.83.0 with exact `a7b72bd` npm-provenance artifact; unsafe override absent; installed digests match | PASS |
| Artificially fail one documented required capability without corrupting source/artifact bytes; health reports that failed capability and health-only mode | PASS |
| Delegation, retry/continue, delete, steering/follow-up, and other write-capable actions fail closed or remain unavailable with typed bounded diagnostics | PASS |
| Read-only `/weave:history`, `/weave:doctor`, status, and allowed inspection remain available and do not mutate refs/cache/native sessions | PASS |
| No false ready/write capability is advertised; recovery after restoring the capability requires/reaches a clean restart | PASS |
| `childSettlementMissingCount: 0`; proof records checklist v3, subject/artifact/digests, host, run attempt, sanitized observations, and cleanup | PASS |
| Close only created pane; no created process, lease, or pane remains; pre-existing panes preserved | PASS |
| Focused health-only/capability tests and docs links from clean committed source; proof committed; three unrelated dirty files keep pre/post SHA-256 and stay unstaged; plan checkbox not marked | PASS |

## Conclusion

Task 20(n) passes on exact subject `a7b72bd`. A single reversible command-ownership failure forced a trusted Pi 0.83 TUI into health-only mode. Read-only diagnostics remained usable, every exposed mutation path was disabled or failed closed, pi-vim continued to work, and normal ready mode returned after a clean restart with no child process, lease, persistent session change, pane loss, or production-source change.
