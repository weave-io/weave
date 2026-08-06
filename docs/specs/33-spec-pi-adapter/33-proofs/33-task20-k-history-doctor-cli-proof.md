# Task 20(k)/21 history, doctor, and CLI proof — FAIL

## Verdict

**FAIL.** On 2026-08-06, the owned pane ran Pi 0.83.0 with the exact installed trusted npm artifact. Weave remained ready and not health-only, and pi-vim remained active. The initial empty-workspace CLI result and both doctor surfaces were bounded and sanitized.

The disposable child did not appear in `/weave:history` or `weave adapter pi children list`. The CLI reported `CacheUnavailable` for `children show` and `children delete`, including when given the persisted parent scope. Delete failed before its confirmation prompt and appended no tombstone. The child therefore could not prove the newest-100 cursor, tombstone, representation, or non-resurrection contracts. The proof contains no raw prompt, delegated task text, or transcript content.

## Scope and starting state

- Owned pane: `w23:p9R`; no pane was created or closed.
- Pre-proof repository parent: `c10004a506918a502c2ee5c387ec2f58b6d0e937`.
- The working tree was clean before the proof.
- No production source file changed.
- The pane remains open.

## Host, trust, provenance, and editor

| Check | Sanitized evidence | Result |
| --- | --- | --- |
| Pi version | `pi --version` returned `0.83.0`. | PASS |
| npm provenance | Settings contained exactly one `npm:@weaveio/weave-adapter-pi` entry. No local adapter shadow existed. | PASS |
| Project trust | The applicable trust entry was `true`, and the adapter reached `ready`. | PASS |
| Unsafe override | `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from the active environment, launcher, settings, and shell configuration. | PASS |
| Weave mode | The live footer showed `Connected  ready  ◆ WEAVE · LOOM`; it did not show health-only mode. | PASS |
| pi-vim coexistence | The live footer showed `INSERT` before and after the extension commands. | PASS |

### Exact installed artifact

- Package: `@weaveio/weave-adapter-pi@0.0.1`
- Artifact: `weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz`
- Artifact SHA-256: `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6`
- Installed `dist/extension.js`: `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84`
- Installed `dist/index.js`: `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e`
- Installed `dist/cli.js`: `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd`
- The installed extension hash matched the extension extracted from the artifact.

## Sanitized baseline

The baseline was recorded before the one disposable child was created.

| Surface | Baseline |
| --- | --- |
| Runtime Store | Schema 5; no active lease. |
| Pi RPC children | `0` processes matching private RPC child mode. |
| Adapter session files | `115`. |
| Session path-manifest SHA-256 | `a274ec15c96098d7307832fcbd4701cf2114cf126778ffd004fcad35f6238936` |
| Session content-manifest SHA-256 | `6df2d3c54cd3de3e43abc2c7521958a11e1a585d36f0e190b2fd897c924e2ba2` |
| Tombstones | `0`; ledger absent. |
| Metadata rows | `0`; cache absent. |
| Workspace panes | `6`. |

The initial human CLI output was exactly:

```text
No children found for this workspace.
```

The initial `children list --json` result contained `kind: children.list`, `workspaceKey: [path omitted]`, and an empty `children` array. Two runs were byte-identical with SHA-256 `1274da0132bb1435cf86548e5e9769ca7ea366fd0511349a60240bf333ce361e`.

## Disposable child

Exactly one disposable child was created. It settled successfully with no intervention and left the repository clean. No second child was created.

The new native session was one mode-`0600` file. Its sanitized structure was:

- 11 JSONL entries total;
- 1 session entry;
- 3 custom entries;
- 2 model-change entries;
- 1 thinking-level-change entry;
- 4 message entries.

This was insufficient to create a 100-entry page boundary. The child id and parent session id are omitted from this proof.

## Live TUI checks

### `/weave:history`

The command returned this bounded response after the disposable child settled, and returned the same response after the delete attempts:

```text
No child history for this workspace.
```

The command surface was responsive and bounded, but it omitted the existing disposable child. This requirement fails.

### `/weave:doctor`

The command returned a bounded report and left the adapter ready:

```text
Doctor status: degraded
doctor.capabilities: fail — ok=12 degraded=0 unavailable=8
doctor.permissions: pass — session root resolved
doctor.sessions: pass — available=1 missing=0 corrupt=0 unavailable=0
doctor.refs: pass — scanned=37 usable=1 malformed=0 conflict=0 originMismatch=0 unusable=0
doctor.cache: fail — cache mode degraded
doctor.stale: pass — scanned=0 stale=0 tombstoned=0
doctor.orphans: pass — scanned=0 orphans=0 bound=50
```

The report contained only bounded counters and status text. It included no paths, prompts, or transcript data. The command remained usable despite the reported degraded state.

## Real CLI checks

### Doctor JSON

Two `weave adapter pi doctor --json` runs were byte-identical with SHA-256 `75d0ae123e914da2fb0fee43bc107df4399ab3cf2b47bbf9798d39bc3d7a9297`. Both exited `0` and returned seven bounded checks:

- overall status: `degraded`;
- permissions: `pass`;
- stale scan: `pass`, with zero scanned, stale, and tombstoned rows;
- cache: `fail`, `cache mode degraded`;
- capabilities, sessions, refs, and orphans: `skip`, `doctor source not wired`.

### Children list

After the disposable child settled, human and JSON list output still reported no children. The JSON remained byte-identical to the pre-child result and included no `sessionPath` field. Therefore the command did not prove newest-50 metadata behavior against the disposable child.

### Children show

Unscoped and persisted-parent-scoped show attempts both exited `1` with this exact sanitized error:

```text
Unavailable: child metadata cache degraded: CacheUnavailable
```

Two `--json` attempts were stable but emitted no JSON; they wrote the same error to standard error. A final reopen attempt produced the same result. No valid page or cursor was available. Therefore the newest-100, cursor, default-path omission on a successful show, and reopen checks could not run.

### Children delete and tombstone

A real PTY invocation supplied an affirmative response, but the command failed before it displayed the required confirmation prompt:

```text
Unavailable: child metadata cache degraded: CacheUnavailable
```

Two `delete --yes --json` attempts also exited `1`, emitted no JSON, and returned the same stable error. The tombstone ledger remained absent with zero lines. Therefore confirmation, append-only tombstone creation, retained tombstoned representation, and non-resurrection all fail or remain blocked.

No manual file deletion or tombstone append was attempted. Such an action would bypass the contract under test.

## Acceptance matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Pi 0.83, trusted exact npm artifact | PASS | Version, package entry, artifact, and installed hashes verified. |
| Unsafe provenance override absent | PASS | Active and configured surfaces were clear. |
| Ready, not health-only | PASS | Live footer remained `ready`. |
| pi-vim coexistence | PASS | Live footer remained in `INSERT`. |
| Sanitized pre-test baseline | PASS | Lease, process, session, cache, metadata, tombstone, and pane baselines recorded. |
| Initial empty CLI behavior | PASS | Exact text: `No children found for this workspace.` |
| One disposable child only | PASS | One new native session file; no second child. |
| `/weave:history` bounded and usable | FAIL | It returned a bounded empty result while the disposable child existed. |
| `/weave:doctor` bounded and sanitized | PASS | Seven bounded checks; no path or transcript data. |
| CLI newest-50 metadata-only list | FAIL | The post-child list remained empty. |
| CLI newest-100 show | BLOCKED | `CacheUnavailable`; native fixture also had only 11 entries. |
| CLI cursor behavior | BLOCKED | No successful first page or cursor existed. |
| No path by default | PARTIAL | List used `[path omitted]` and omitted `sessionPath`; successful show output was unavailable. |
| Stable JSON where supported | PARTIAL | List and doctor were byte-stable; show and delete failed before emitting JSON. |
| Explicit delete confirmation | FAIL | Delete failed before the prompt. |
| Appended tombstone | FAIL | Tombstone count remained zero. |
| Deleted child cannot reopen or resurrect | BLOCKED | No deletion or tombstone occurred; show remained unavailable. |
| Tombstoned child remains represented | BLOCKED | No tombstone occurred and list remained empty. |
| No test child process or active lease | PASS | Final process count was zero and Runtime Store reported no active lease. |
| Preserve pre-existing child history | PASS | Every pre-existing adapter session file retained its baseline content hash. |
| No unintended pane residue | PASS | Pane count and pane-id set were unchanged; `w23:p9R` remained open. |
| Tombstone-only cleanup discipline | PASS | No manual removal or ledger mutation occurred. |

## Final cleanup and residue

- Pi RPC child processes: `0`.
- Active Runtime Store lease: none.
- Workspace pane count: `6`; pane-id set unchanged.
- Owned pane `w23:p9R`: open.
- Pre-existing adapter session files: unchanged by content hash.
- Final adapter session files: `116`, exactly one more than baseline.
- Test-created native session files remaining: `1`.
- Tombstones: `0`.
- Metadata cache: absent.

The one test-created native session remains because the only permitted cleanup path, CLI tombstoning, failed with `CacheUnavailable`. Removing it directly would invalidate the deletion contract and risk bypassing the parent reference model.

## Blockers

1. The production CLI metadata cache was absent and degraded. `children show` and `children delete` failed with `CacheUnavailable`, with or without persisted parent scope.
2. The live TUI history and CLI list omitted the disposable child even though its native session and parent child reference existed.
3. The sole allowed disposable fixture contained only 11 native entries, so the 100-entry page boundary could not be reached. The continuation instruction prohibited creating another child.
4. Because delete never reached confirmation and appended no tombstone, the tombstoned representation and non-resurrection contracts could not be proved.

## Conclusion

Task 20(k)/21 fails on the exact installed Pi 0.83 artifact. Host readiness, provenance, pi-vim coexistence, bounded doctors, stable list/doctor JSON, and environmental cleanup pass. Real child history, list, show, delete, tombstone, cursor, and resurrection requirements do not pass. No production source changed, no pre-existing child history changed, and the pane remains open.
