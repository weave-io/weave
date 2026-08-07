# Task 21 final-head fail-closed proof (S057, S063, S064, S067)

**Verdict: PASS**

Checklist version `3`. Rows `S057`, `S063`, `S064`, and `S067`, re-run live on
the final fail-closed head `9a8c64683f3e159a587119ee045dc60ae5a62e86`
(`fix(pi): retry guarded short session reads`), which carries every remediation
commit through the final head. This record supersedes the Task 20 `(j)`, `(k)`,
and `(n)` records for those four rows. Those Task 20 files stay in this
directory as **historical** records of pre-`c24182f` behaviour.

This record replaces the earlier `43ebc13` and `b0997de` bindings of this file,
and every intermediate artifact run between them. Those runs are superseded
history: they predate the guarded bounded-read remediations recorded below, so
their artifact digests no longer describe shipped behaviour and are not repeated
here.

This proof is sanitized. It contains no prompt, delegated task text, transcript
body, session path, child identifier, or unsanitized diagnostic path. Every full
digest below was copied from the run's sanitized summary, never from a raw
transcript.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Exact source subject | `9a8c64683f3e159a587119ee045dc60ae5a62e86` |
| Host Pi version | `0.83.0` |
| Global Pi version (untouched) | `0.84.1` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Checklist version | `3` |
| Checklist rows | `S057`, `S063`, `S064`, `S067` |
| `childSettlementMissingCount` | `0` |

| Entry point | SHA-256 |
| --- | --- |
| Artifact tarball | `2647e8b19cb49b5796edfb188fd1af739827d6e3098b1a9d7ab259ced536e566` |
| `dist/extension.js` | `55b297dbd4c1be9025730868d97f34ef1c812dc977acc9999fe5aa541f374f79` |
| `dist/index.js` | `72234af6eec11719e10de4d87bd3cb53c3553d329454dd0c0dbcfd24846604f2` |
| `dist/cli.js` | `1dbb9bf5fe9a27fad82c6096b58f45f5a291367ba7d61c236b29d033690f015e` |

The packed tarball digests and the installed `dist` digests matched entry point
for entry point, so the running extension is the packed artifact.

The machine's globally installed Pi `0.84.1` and its global agent directory were
untouched by every check recorded here. Every run used a disposable
`XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `PI_CODING_AGENT_DIR`. The global Pi
settings digest was identical before and after the whole run.

## Run A — pristine startup and read-only surfaces

Run A started from empty disposable data roots and exercised startup, then
`/weave:status`, `/weave:health`, `/weave:history`, and `/weave:doctor`.

### Weave data roots stayed absent

| Stage | `$XDG_DATA_HOME/weave` | project `.weave/runtime` |
| --- | --- | --- |
| Before startup | absent | absent |
| After startup | absent | absent |
| After status / health / history / doctor | absent | absent |

No Weave data root was ever created. No runtime lease and no bootstrap record
existed under the disposable roots at any stage.

| Marker | Observed |
| --- | ---: |
| `weave.db`, WAL, or SHM files | `0` |
| Child ref files | `0` |
| Bootstrap files | `0` |
| Native child session files | `0` |
| Lease-like entries | `0` |
| Child-like harness processes | `0` |

## S067 — health-only mode from the missing required capability

| Observation | Verified value |
| --- | --- |
| Adapter mode | `health-only` |
| Required capability | `descriptor-relative-native-session-io` |
| Capability state | `unsupported` (declared native) |
| Probe result | `unavailable` |
| Probe reason | `path-only-session-api` |
| Host version | `0.83.0` |

Pi `0.83.0` addresses native sessions by caller-supplied filesystem path, so the
adapter cannot prove a session write lands inside host-owned storage. The
capability probe answers `unavailable` with reason `path-only-session-api`, and
the generation enters health-only mode. The report named the capability, the
contract, the probe result, the resulting mode, and the remediation.

## S057 — read-only surfaces in the TUI

All surfaces stayed available in health-only mode and mutated nothing.

| Surface | Sanitized result |
| --- | --- |
| Status | `health-only: true`, `children: 0` |
| Health | Health-only report naming the unavailable capability and the `path-only-session-api` gap |
| History | Bounded sanitized page |
| Doctor | Bounded counters, no paths |

## Delegation probe — no child, no lease

| Check | Observed |
| --- | ---: |
| `weave_delegate` tool | unavailable; never registered in health-only mode |
| Children reported by `/weave:status` | `0` |
| Child processes spawned | `0` |
| Execution leases taken | `0` |
| Residual owned processes after cleanup | `0` |

## S063 — `/weave:history` and `/weave:doctor` bounds

| Check | Verified value |
| --- | --- |
| `/weave:history` page | bounded; sanitized rows only |
| `/weave:history` row content | no path, prompt, or transcript |
| `/weave:doctor` output | bounded counters only |
| `/weave:doctor` content | no path, prompt, or transcript |

## S064 — bounded native-session reads through `children show`

### Normal bounded JSONL session (250 entries)

| Check | Verified value |
| --- | --- |
| Newest page entries | `100` (`entry-150` … `entry-249`) |
| Older cursor page entries | `100`, last `entry-149` |
| Overlap between pages | none |
| Next cursor | present |
| Paths printed by default | none |

### Exact and forced-short paging

Newest and older paging were driven under a forced short-read filesystem port
so that every content read returned fewer bytes than requested. Both directions
returned exact ranges in the correct order.

| Case | Result |
| --- | --- |
| `forced-short-newest-order` | pass — limit 1 returned `entry-1`; limit 2 returned `entry-0`, `entry-1` |
| `forced-short-older-order` | pass — `entry-1`, then `entry-0`, `entry-1`; order preserved |
| `premature-zero-body-read` | pass — typed failure, no partial page |
| `mutation-before-retry-growth` | pass — typed failure, no partial page |
| `mutation-before-retry-rewrite` | pass — typed failure, no partial page |
| `mutation-before-retry-swap` | pass — typed failure, no partial page |

All six cases passed. A premature zero-length body read and any file growth,
rewrite, or swap observed between the short read and its retry produced a typed
`SessionCorrupt` / `unreadable` failure. No case emitted a partial page.

Scope label: this evidence ran through `PiNativeSessionStore` over
`MemoryPiNativeSessionFs` (`focused-memory-fs-port`), paired with a focused unit
suite of `96` passing tests that includes `5` forced-short paging tests.

### Empty and short-read guards on the production filesystem port

These cases ran through `createBunPiNativeSessionFs` with
`PiNativeSessionStore` (`production-fs-port`). All passed.

| Case | Result |
| --- | --- |
| `zero-size-guarded-eof-probe-then-growth` | pass — empty returned only after the guarded EOF probe; concurrent growth rejected `identity-changed` |
| `zero-size-swap-before-eof-probe` | pass — swap rejected `identity-changed` |
| `forced-short-pread-then-rewrite` | pass — second content read rejected `identity-changed` |
| `forced-short-pread-then-swap` | pass — second content read rejected `identity-changed` |
| `store-empty-guarded-eof-probe` | pass — typed `SessionCorrupt` / `missing-header` after one guarded probe |

The guarded empty-file probe opened exactly one file (`session.jsonl`) and
issued exactly one read request, of `65536` bytes, before answering. A zero-size
file is reported empty only after that probe confirms end of file, and any
identity change observed during the probe fails closed.

### Oversize session fails closed with zero body bytes

| Check | Verified value |
| --- | --- |
| Logical session size | `8388609` bytes |
| Bounded maximum | `8388608` bytes |
| Store `readSessionEntries` | `SessionCorrupt` / `file-too-large` |
| Production `children show` port | `Unavailable: SessionCorrupt` |
| Output rows emitted | `0` |
| Body bytes requested on the whole-session path | `0` |
| Fixture DB and session files | unchanged |

The whole-session read checks metadata before any body read, so the oversize
session was rejected without reading a single body byte and without emitting a
row.

### Fixture integrity across every read

| Fixture | SHA-256 (unchanged before and after) |
| --- | --- |
| Fixture DB | `8eb765962875a58d56f28eeeb4fa1ec9ee672be66f75f9763f21b7a1f16dadec` |
| Normal session | `3557298e2e85b46f58641631e90b3b9e002246c772f21a7ac5e7fee1a4996d9f` |
| Oversize session | `4459f957d031a8b782dfee09d2c7070a4b5e6c33130a8f20ac35393fd97fc57a` |

## Run B — production CLI non-creation, title provenance, interrupted ref

Run B drove the **production** CLI wiring against the same installed artifact.

### Production CLI stays non-creating

| Check | Observed |
| --- | --- |
| `children delete` gate | `RequiredCapabilityUnavailable` |
| Gate capability | `descriptor-relative-native-session-io` |
| Gate reason | `path-only-session-api` |
| Gate position | before any port construction |
| Roots after `list`, `show`, `doctor`, `delete` | empty |

The delete rejection happened at the capability authority, before the children
port, the session service, the filesystem, the cache, or an execution lease was
reached. The read commands `list`, `show`, and `doctor` all answered while
leaving the data roots empty, so no production CLI read creates storage.

### Explicit title provenance

A legacy database row was frozen with a raw, unmarked title and no provenance
marker, then read through the production projections. This behaviour is
unchanged from the previous binding of this record.

| Check | Observed |
| --- | --- |
| Stored `title_provenance` | `null` (unmarked legacy) |
| Projected title in `show` | `child-12345678` |
| Projected title in list, history, doctor, picker | `child-12345678` |
| Unknown provenance marker | fell back to `child-12345678` |
| Raw legacy sentinel exposed anywhere | never |

Only an explicitly trusted provenance marker allows a stored title to surface.
The unmarked legacy row and an unrecognized marker both fell back to the derived
`child-<id>` form. The fixture tree and side-file set were unchanged.

### Interrupted legacy ref stays inert

An interrupted legacy child ref recorded as `running` was placed where a
recovery path would find it. This behaviour is unchanged from the previous
binding of this record.

| Check | Observed |
| --- | --- |
| Recovery prompt or "Recover now" affordance | absent |
| "Interrupted" affordance | absent |
| Legacy sentinel surfaced in the UI | never |
| Reported mode | `health-only` |
| Children reported | `0` |
| Reconstruction, ref upsert, or child spawn | none |
| Ref record SHA-256 before and after | `96d005c91c8b68c54b4a7ca59a115ca0de4710e8dcc8b26db27c5cb890c16e1b` |
| Ref status after | `running` (unchanged) |
| Recovery files under `$XDG_DATA_HOME` | none |
| Child-like processes | `0` |

Focused unit coverage for the same behaviour passed: `2` tests, covering the
path-only skip of recovery and the gate running before the factory opens
storage.

## Fail-closed mutation summary

| Route | Sanitized result |
| --- | --- |
| `weave_delegate` tool | absent in health-only mode; never registered |
| `/weave:run` | blocked; unavailable until required capabilities recover |
| `/weave:start` | blocked; unavailable until required capabilities recover |
| `children.delete` | `RequiredCapabilityUnavailable` before reaching the children port |
| Interrupted-ref recovery | skipped without prompt, reconstruction, upsert, or spawn |

| Side-effect check | Observed |
| --- | ---: |
| Child processes created | `0` |
| RPC processes created | `0` |
| Bootstrap processes created | `0` |
| Execution leases taken | `0` |
| Child refs written | `0` |
| Cache mutations | `0` |
| Native child sessions created | `0` |
| Weave databases, WAL, or SHM files created | `0` |

## Cleanup

| Check | Observed |
| --- | ---: |
| Residual owned Pi processes | `0` |
| Residual execution lease | none |
| Residual owned pane | none |
| Pre-existing panes | preserved |
| Global Pi `0.84.1` and global agent directory | untouched |

## Row mapping

| Row | Claim recorded here | Result |
| --- | --- | --- |
| `S057` | Read-only history, picker, doctor, status, and health stay available in health-only mode without mutation | PASS |
| `S063` | `/weave:history` bounded sanitized page; `/weave:doctor` bounded sanitized counters | PASS |
| `S064` | `children show` bounded newest and older paging with no overlap and no paths, exact under forced short reads, and fail-closed on premature zero reads, mutation, and oversize sessions | PASS |
| `S067` | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | PASS |

## Caveats

- Public package `buildAll` fails on `@weaveio/weave-cli` declarations in this
  checkout, so the proof built only `@weaveio/weave-adapter-pi`.
- `children show` through the production CLI registry on a sparse oversize
  fixture answered `Unavailable: CacheEntryUnusable` with zero entries. The
  direct production children port answered `Unavailable: SessionCorrupt`, and
  the whole-session store read answered `SessionCorrupt` / `file-too-large`
  with zero body bytes. That whole-session path is the recorded zero-body proof.
- The page path on the sparse oversize fixture fails as `SessionCorrupt` /
  `missing-header` after a range read rather than as `file-too-large`.
- The health report text named host version `0.84.1` in the capability
  remediation line while the isolated `pi --version` and the package `VERSION`
  were both `0.83.0`.
- The interrupted session file's own bytes changed on open, which is an ordinary
  Pi host append. The child-ref entry bytes stayed identical.
- Forced-short newest and older paging evidence is labeled
  `focused-memory-fs-port`; empty and short-read evidence is labeled
  `production-fs-port`.

## Scope limits

This record proves read availability, bounded and fail-closed native-session
reads, health-only reporting, pristine non-creation, sanitized title projection,
and fail-closed rejection only. It is not evidence that any mutation, spawn,
delete, retry, continue, steer, follow-up, or recovery path works on this host.
It is **not** evidence of descriptor-safe persistent mutation support, because
Pi `0.83.0` cannot supply the required capability at all.

Every row that needs a persistent child spawn or a native session mutation
remains `Pending` in both smoke checklists, and `PI-INS`, `PI-INT`, `PI-PRI`,
and `PI-RCV` remain `pending` in the acceptance manifest.
