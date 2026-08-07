# Task 21 final-head fail-closed proof (S057, S063, S064, S067)

**Verdict: PASS**

Checklist version `3`. Rows `S057`, `S063`, `S064`, and `S067`, re-run live on
the final fail-closed head `b0997dec207de8a953078edf4a2b92206c89778a`
(`fix(pi): persist trusted child title provenance`), which carries every
remediation commit through the final head. This record supersedes the Task 20
`(j)`, `(k)`, and `(n)` records for those four rows. Those Task 20 files stay in
this directory as **historical** records of pre-`c24182f` behaviour.

This record replaces the earlier `43ebc13` binding of this file. The `43ebc13`
run is superseded history: it predates the pristine-startup, production-CLI
non-creation, title-provenance, and interrupted-ref remediations recorded below,
so its artifact digests no longer describe shipped behaviour and are not
repeated here.

This proof is sanitized. It contains no prompt, delegated task text, transcript
body, session path, child identifier, or unsanitized diagnostic path.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Exact source subject | `b0997dec207de8a953078edf4a2b92206c89778a` |
| Host Pi version | `0.83.0` |
| Global Pi version (untouched) | `0.84.1` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Checklist version | `3` |
| Checklist rows | `S057`, `S063`, `S064`, `S067` |
| `childSettlementMissingCount` | `0` |

| Entry point | SHA-256 |
| --- | --- |
| Artifact tarball | `4aed9e2f21f5262c0f5d52cd6e69b125d9512bc2ed91f4e6de97e2c9eb6f8ccf` |
| `dist/extension.js` | `b9b094fee5711f14e1cc3ca298fc342110d38772be6195193c681796d2a19362` |
| `dist/index.js` | `956ee95d5930d5f0c1fcf212ff8bb22236fd1f5ab2f92d0e59676a420b72c613` |
| `dist/cli.js` | `1b7d6e345e53cfcd5b85dedf539f4707ac8cc8e4ee4ae7932e5797dc343d5c40` |

The packed tarball digests and the installed `dist` digests matched entry point
for entry point, so the running extension is the packed artifact.

The machine's globally installed Pi `0.84.1` and its global agent directory were
untouched by every check recorded here. Every run used a disposable
`XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `PI_CODING_AGENT_DIR`.

## Run A — pristine startup and read-only surfaces

Run A started from empty disposable data roots and exercised startup, then
`/weave:status`, `/weave:health`, `/weave:history`, `/weave:doctor`, and the
inspect picker.

### Weave data roots stayed absent

| Stage | `$XDG_DATA_HOME/weave` | project `.weave/runtime` |
| --- | --- | --- |
| Before startup | absent | absent |
| After startup | absent | absent |
| After status / health / history / doctor / inspect | absent | absent |
| After the delegation probe | absent | absent |

No Weave data root was ever created. The marker scan was zero at every stage.

| Marker | Before | After startup | After read-only | After probe |
| --- | ---: | ---: | ---: | ---: |
| `weave.db` files | `0` | `0` | `0` | `0` |
| WAL / SHM files | `0` | `0` | `0` | `0` |
| Child ref files | `0` | `0` | `0` | `0` |
| Bootstrap files | `0` | `0` | `0` | `0` |
| Native child session files | `0` | `0` | `0` | `0` |
| Lease-like entries | `0` | `0` | `0` | `0` |
| Reconstruction-like entries | `0` | `0` | `0` | `0` |
| Upsert-like entries | `0` | `0` | `0` | `0` |
| Child-like harness processes | `0` | `0` | `0` | `0` |

### Filesystem fingerprints

A content fingerprint over the disposable roots was taken at each stage.

| Stage | Files | Dirs | Fingerprint SHA-256 |
| --- | ---: | ---: | --- |
| Before | `0` | `0` | `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b` |
| After startup | `18` | `3` | `078df863905e2efeedc6bd50bb51aa9ea508d332a9bcf83764f76d2c72731751` |
| After read-only surfaces | `18` | `3` | `078df863905e2efeedc6bd50bb51aa9ea508d332a9bcf83764f76d2c72731751` |
| After the delegation probe | `20` | `3` | `4496d10a4a428230ff2f2b77405a2e51ea934715ad5591d35e5f22b0b7c6b656` |

The fingerprint is byte-identical before and after the whole read-only sweep.
Running status, health, history, doctor, and inspect changed nothing at all.

### Host noise identification

The non-zero file counts are **host** artifacts, not adapter mutation. Every
file was attributed:

| Source | Count | Owner |
| --- | ---: | --- |
| Bun transpiler cache (`xdg-cache/bun/@t@/*.pile`) | `16` | Bun runtime |
| Shell prompt cache (`xdg-cache/oh-my-posh/*`) | `2` | shell prompt, unrelated to Pi |
| Pi parent session transcript (`pi-agent/sessions/*.jsonl`) | `1` | Pi host |

The two extra files after the delegation probe are one further Bun cache entry
and the parent's own Pi session transcript. Typed input appends to the parent
transcript as it does in any Pi session; that is ordinary Pi host behaviour and
is **not** a Weave mutation. Zero files appeared under any Weave-owned path, and
`session_file_count` inside Weave-owned storage stayed `0` throughout.

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
host version, the contract, the probe result, the resulting mode, and the
remediation.

## S057 — read-only surfaces in the TUI

All surfaces stayed available in health-only mode and mutated nothing.

| Surface | Sanitized result |
| --- | --- |
| Status | `health-only: true`, `children: 0` |
| Health | Health-only report naming the unavailable capability and the `path-only-session-api` gap |
| History | Bounded sanitized page; `No child history for this workspace.` |
| Doctor | Bounded counters; `degraded`, with `doctor.cache` reporting degraded cache mode |
| Inspect | Read-only picker opened at its root and closed cleanly with escape |

Precise statement about the picker: the inspect picker **opened at its root**.
Cache-only fixture labels were **not exposed** in the picker. This record makes
no claim that the picker listed fixture-backed children, and no claim about
per-status ordering or title precedence.

## Delegation probe — `shuttle-mini` unavailable

| Check | Observed |
| --- | --- |
| `weave_delegate` tool | unavailable; never registered in health-only mode |
| `shuttle-mini` delegation | unavailable |
| Children reported by `/weave:status` | `0` |
| Child processes spawned | `0` |
| Execution leases taken | `0` |
| Residual owned processes after cleanup | `0` |

The delegation attempt reported the required tool as unavailable and produced no
child. Harness process counts stayed at the parent-only baseline.

## S063 — `/weave:history` and `/weave:doctor` bounds

| Check | Verified value |
| --- | --- |
| `/weave:history` rows returned | exactly `50` |
| `/weave:history` next cursor | present |
| `/weave:history` row content | sanitized; no path, prompt, or transcript |
| `/weave:doctor` output | bounded counters only |
| `/weave:doctor` content | no path, prompt, or transcript |

## S064 — `weave adapter pi children list` / `show` bounds

| Check | Verified value |
| --- | --- |
| `list` page bound | `50` |
| `show` first page bound | `100` |
| `show` cursor page | `17` further entries |
| Overlap between `show` pages | none |
| Paths printed by default | none |

Scope note: `list` cursor page 2 was verified **through the production ports**,
not through the CLI command, because the `children list` CLI command does not
wire a `--cursor` flag. The `show` cursor page was exercised through the CLI.

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
marker, then read through the production projections.

| Check | Observed |
| --- | --- |
| Raw legacy title in the database | `LEGACY_TASK_SENTINEL-12345678` |
| Stored `title_provenance` | `null` (unmarked legacy) |
| Projected title in `list` | `child-12345678` |
| Projected title in `show` | `child-12345678` |
| Projected title in history, doctor, picker | `child-12345678` |
| Unknown provenance marker | fell back to `child-12345678` |
| Raw sentinel exposed anywhere | never |

Only an explicitly trusted provenance marker allows a stored title to surface.
The unmarked legacy row and an unrecognized marker both fell back to the derived
`child-<id>` form.

| Fixture integrity | Value |
| --- | --- |
| Fixture DB SHA-256 before | `ebe782097c98509dacdf09c06484814441d828aca7cd0d7ff832234fb58f9808` |
| Fixture DB SHA-256 after | `ebe782097c98509dacdf09c06484814441d828aca7cd0d7ff832234fb58f9808` |
| Side-file set | unchanged (`1` before, `1` after) |
| Fixture tree | unchanged |

The digest is identical before and after every projection read.

### Interrupted legacy ref stays inert

An interrupted legacy child ref recorded as `running` was placed where a
recovery path would find it.

| Check | Observed |
| --- | --- |
| Recovery prompt or "Recover now" affordance | absent |
| "Interrupted" affordance | absent |
| Legacy sentinel surfaced in the UI | never |
| Reported mode | `health-only` with `path-only-session-api` |
| Children reported | `0` |
| Reconstruction performed | none |
| Ref upsert performed | none |
| Child spawn performed | none |
| Ref record SHA-256 before and after | `e4344538e5685049b2d27193f7bfe2c15fbeacf1ff7086d445127cd232bd1b92` |
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
| `S057` | Read-only history, picker, doctor, status, health, and inspect stay available in health-only mode without mutation | PASS |
| `S063` | `/weave:history` bounded first page of 50 plus a next cursor; `/weave:doctor` bounded sanitized counters | PASS |
| `S064` | `children list` bound 50; `children show` bound 100 plus 17 on the cursor page, no overlap, no paths by default | PASS |
| `S067` | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | PASS |

## Scope limits

This record proves read availability, health-only reporting, pristine
non-creation, sanitized title projection, and fail-closed rejection only. It is
not evidence that any mutation, spawn, delete, retry, continue, steer,
follow-up, or recovery path works on this host. It is **not** evidence of
descriptor-safe persistent mutation support, because Pi `0.83.0` cannot supply
the required capability at all.

Every row that needs a persistent child spawn or a native session mutation
remains `Pending` in both smoke checklists, and `PI-INS`, `PI-INT`, `PI-PRI`,
and `PI-RCV` remain `pending` in the acceptance manifest.
