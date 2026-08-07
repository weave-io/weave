# Task 21 final-head fail-closed proof (S057, S063, S064, S067)

**Verdict: PASS**

Checklist version `3`. Rows `S057`, `S063`, `S064`, and `S067`, re-run live on
the final fail-closed head after commits `c24182f`, `50d59b4`, and `5af9f1b`.
This record supersedes the Task 20 `(j)`, `(k)`, and `(n)` records for those
four rows. Those Task 20 files stay in this directory as **historical** records
of pre-`c24182f` behaviour.

This proof is sanitized. It contains no prompt, delegated task text, transcript
body, session path, child identifier, or unsanitized diagnostic path.

## Subject and artifact

| Field | Verified value |
| --- | --- |
| Exact source subject | `43ebc1379b22042ace2cb46039017a17aeea97b4` |
| Host Pi version | `0.83.0` |
| Global Pi version (untouched) | `0.84.1` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Checklist version | `3` |
| Checklist rows | `S057`, `S063`, `S064`, `S067` |
| `childSettlementMissingCount` | `0` |

| Entry point | SHA-256 |
| --- | --- |
| Artifact tarball | `434654d274165c01bbace11d6b451de7a4026fe5540b3a4ebf4f159f67855180` |
| `dist/extension.js` | `9845ab775c0073c6df6c85bda13cfec92d817dc1cdb7c3dc7eb08bf5dc29322d` |
| `dist/index.js` | `c1c407cf07e2340267f15d7d7d4d576296e91e1363228b9af165e6dc36a8abed` |
| `dist/cli.js` | `b4710278a6e12b61255d50fe5c8665ba067a9701c8cbbba38b2d8b6789fde1d1` |

The machine's globally installed Pi `0.84.1` and its global agent directory
were untouched by every check recorded here.

## S067 — health-only mode from the missing required capability

| Observation | Verified value |
| --- | --- |
| Adapter mode | `health-only` |
| Required capability | `descriptor-relative-native-session-io` |
| Probe result | `unavailable` |
| Probe reason | `path-only-session-api` |
| Host version | `0.83.0` |

Pi `0.83.0` addresses native sessions by caller-supplied filesystem path, so
the adapter cannot prove a session write lands inside host-owned storage. The
capability probe answers `unavailable` with reason `path-only-session-api`, and
the generation enters health-only mode. The report named the capability, the
host version, the contract, the probe result, the resulting mode, and the
remediation.

## S057 — read-only surfaces in the TUI

All four surfaces stayed available in health-only mode and mutated nothing.

| Surface | Sanitized result |
| --- | --- |
| Status | Bounded state report, health-only true |
| Health | Bounded capability report naming the unavailable required capability |
| History | Bounded sanitized page |
| Doctor | Bounded counter report |
| Inspect | Read-only inspection surface opened and closed cleanly |

Precise statement about the picker: the inspect picker **opened at its root**.
Cache-only fixture labels were **not exposed** in the picker. This record makes
no claim that the picker listed fixture-backed children, and no claim about
per-status ordering or title precedence.

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

## Fail-closed mutation proof

| Route | Sanitized result |
| --- | --- |
| `weave_delegate` tool | absent in health-only mode; never registered |
| `/weave:run` | blocked; unavailable until required capabilities recover |
| `/weave:start` | blocked; unavailable until required capabilities recover |
| `children.delete` | authority returned `RequiredCapabilityUnavailable` before reaching the children port |

The `children.delete` rejection happened at the capability authority. Execution
never reached the children port, the session service, the filesystem, the
cache, or an execution lease.

| Side-effect check | Observed |
| --- | ---: |
| Child processes created | `0` |
| RPC processes created | `0` |
| Bootstrap processes created | `0` |
| Execution leases taken | `0` |
| Child refs written | `0` |
| Cache mutations | `0` |
| Native child sessions created | `0` |

Accuracy note on the parent transcript: entering the check prompt appended a
line to the parent's own Pi session transcript, as any typed input does. That
line is ordinary Pi host behaviour and is **not** a Weave mutation. No Weave
ref, cache entry, child session, or lease was written by it.

## Fixture and cache integrity

| Check | Value |
| --- | --- |
| Fixture / cache SHA-256 before | `a543820bf99bca6a6a20e699195191ec150c3592fe6fc15ffd1f8b3017e338a5` |
| Fixture / cache SHA-256 after | `a543820bf99bca6a6a20e699195191ec150c3592fe6fc15ffd1f8b3017e338a5` |

The digest is identical before and after every check in this record.

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

This record proves read availability, health-only reporting, and fail-closed
rejection only. It is not evidence that any mutation, spawn, delete, retry,
continue, steer, follow-up, or recovery path works on this host. Every row that
needs a persistent child spawn or a native session mutation remains `Pending`
in both smoke checklists, and `PI-INT`, `PI-INS`, `PI-PRI`, and `PI-RCV` remain
`pending` in the acceptance manifest.
