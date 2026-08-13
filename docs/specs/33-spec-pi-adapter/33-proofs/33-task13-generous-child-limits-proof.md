# Task 13 generous child limits live proof

Status: **PASS**

Date: 2026-08-13

This record closes Task 13 of
[the Pi generous child limits plan](../../../../.weave/plans/pi-generous-child-limits.md).
It supersedes the earlier Task 13 completion record, which was written against
the pre-restoration baseline and explicitly waived every live case.

Everything below is a sanitized observation: digests, counts, byte totals, and
typed outcomes. No prompt text, transcript, or credential is reproduced.

## Exact subject and artifact

| Field | Value |
| --- | --- |
| Subject | `fd1192e0a9d6f6f7dfc8ad08a6352522f0133779` |
| Pi host | `@earendil-works/pi-coding-agent` `0.84.1` |
| Adapter | `@weaveio/weave-adapter-pi` `0.0.1` |
| Artifact | `/private/tmp/weave-task13-artifacts-fd1192e/weaveio-weave-adapter-pi-0.0.1-fd1192e-task13.tgz` |
| Artifact SHA-256 | `f89eb4962dbfdd4670eeb60c3124675e43eba0de7faf667d32c1a2d41aac6654` |
| Built `dist/extension.js` SHA-256 | `c5f2da0289a1b5f9443b5cfba680927b5b38d79b4792e4f0f38a8ded6cc5f23f` |
| Built `dist/index.js` SHA-256 | `132c0e5bff39e32760c1e283d642c1ed4da8ba9587ebe3a039d7e5d0941992ef` |
| Built `dist/cli.js` SHA-256 | `530109e3aba8cb51a2f5487f703377c9606eb898144214216e60f39a918ad69b` |
| Attempt | 3 (attempts 1 and 2 each found a defect; see **Defects found live**) |

The package was built from a detached worktree at the exact subject
(`/private/tmp/weave-task13-build-fd1192e`). The installed entry-point digests
were re-hashed after installation and match the built artifact byte for byte:

```text
c5f2da0289a1b5f9443b5cfba680927b5b38d79b4792e4f0f38a8ded6cc5f23f  .../npm/node_modules/@weaveio/weave-adapter-pi/dist/extension.js
132c0e5bff39e32760c1e283d642c1ed4da8ba9587ebe3a039d7e5d0941992ef  .../npm/node_modules/@weaveio/weave-adapter-pi/dist/index.js
530109e3aba8cb51a2f5487f703377c9606eb898144214216e60f39a918ad69b  .../npm/node_modules/@weaveio/weave-adapter-pi/dist/cli.js
```

Provenance is the strict npm registration `npm:@weaveio/weave-adapter-pi`.
`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` is unset in the harness launcher,
and the adapter package contains no nested copy of a Pi host package.

## Isolated harness

Harness root: `/private/tmp/weave-task13-pi0841-fd1192e`

Isolated `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`. `PI_OFFLINE=1`. The launcher strips the
inherited parent-only `PI_SESSION_FILE`, `PI_SESSION_ID`,
`PI_INTERCOM_SESSION_ID`, `PI_MODEL`, `PI_PROVIDER`, `PI_REASONING_LEVEL`, and
`PI_CODING_AGENT`.

> Pitfall worth keeping: the launcher must **not** strip `WEAVE_CHILD_*`. The
> same launcher script is what a delegated child is spawned with, so unsetting
> those in it makes every child fail `ChildHandshakeMissing`. Parent-only
> sanitization belongs in the shell that starts the top-level Pi.

The model provider is a deterministic local OpenAI-compatible fixture on
`127.0.0.1:18443` with no credential and no egress
(`/private/tmp/weave-task13-pi0841-fd1192e/fixture-server.ts`). It also records
one sanitized JSONL observation per request, which is the independent side of
every claim below.

The proof project declares 14 extra subagents, one workflow with a direct step,
and `max_children 32`, `max_concurrency 1`, `max_depth 8`, `max_processes 3`.
The low concurrency is deliberate: it makes queueing observable.

`pi list` reported the expected npm identity, the installed path, and no load
error.

## Readiness

From a fresh interactive TUI (`/private/tmp/weave-task13-evidence/s1-clean.txt`):

```text
[Extensions]
  @weaveio/weave-adapter-pi:dist/extension.js
ready ◆ WEAVE · LOOM     Weave adapter mode: ready
 generation: 6a7667e0-5e5e-4629-a939-1f7bb53282bd
 trust: trusted
 mode: tui
 health-only: false
 children: 0
```

`/weave:health` reported `ready` with every required capability at its declared
readiness. `/weave:status` reported trusted interactive mode and
`health-only: false`.

## Observed live matrix

All rows come from one fresh TUI session per script, with the fixture log as the
independent record. Times are seconds from the first request of the session.

### Ordinary delegation — PASS

`weave_delegate · shuttle · completed`. The fixture saw one child turn and the
parent's follow-up turn. No typed failure appeared anywhere in the session.

### Authoritative task above 8,192 characters — PASS

The parent dispatched a deterministic multibyte task and the child received it
**unchanged**:

| Field | Value |
| --- | --- |
| Characters | 36,123 |
| UTF-8 bytes | 46,923 |
| SHA-256 | `ecb27e197feb79d2672a5aed4892f216ea217a1944d55f603572a29e8c3f29af` |

The child-side fixture rebuilt the exact expected task and asserted it was
present verbatim in what it was asked to do: `containsExactTask: true`. The
child then reported `T13_TASK_INTACT sha256=ecb27e19… bytes=46923`, which the
parent rendered. The old 8,192-character rejection is gone and nothing on the
path truncated or re-encoded the task.

### Authoritative result above the inline projection — PASS

The child emitted a deterministic result of **178,927 UTF-8 bytes**, SHA-256
`8c27b852575aeb34c4fe3fffbce17fbd5e16c5f4a96b34519d2a7e8cbce99dfa` — well past
both the removed 4 KiB settlement cap and the 64 KiB inline projection. The
delegation settled `completed`.

### Bounded retrieval after restart — PASS

Pi was exited. With no live adapter process, the result was retrieved through
bounded CLI pages only:

```text
weave adapter pi children result 820a81e3-bd3d-424d-bd45-80a102e11ba5 --json
weave adapter pi children result 820a81e3-bd3d-424d-bd45-80a102e11ba5 --json --cursor <continuation>
```

| Field | Value |
| --- | --- |
| Pages | 2 |
| Page decoded bytes | 98,304 then 80,623 |
| `exact` | `true` on every page |
| `contentEncoding` | `base64` on every page |
| `status` | `complete` |
| Declared chunk count | 4 |
| Declared byte length | 178,927 |
| Reconstructed bytes | 178,927 |
| Reconstructed SHA-256 | `8c27b852575aeb34c4fe3fffbce17fbd5e16c5f4a96b34519d2a7e8cbce99dfa` |
| Continuation after last page | absent |

Each page's `contentByteOffset` equalled the bytes already reconstructed, so the
window is explicit and gap-free. The reconstruction matches the digest the child
itself emitted, so the retrieved bytes are the authoritative result, not a
projection.

### More than nine discoverable targets — PASS

Every parent turn recorded a `weave_delegate` eligible-target set of **21**
entries — `shuttle`, `pattern`, `thread`, `weft`, `warp`, `ui-designer`,
`probe-01` … `probe-14`, `shuttle-tests` — against the old 9-entry catalog
ceiling. Selection past the old ceiling was exercised, not merely listed: a
delegation to `probe-12` (the twelfth project target) completed.

### Queued concurrency waits and resumes — PASS

Three children were requested at once against `max_concurrency 1`, each doing
about 12.4 s of streamed work. The fixture saw them start strictly one after
another:

```text
409.17  child slow-start
422.33  child slow-start   (+13.16 s)
435.51  child slow-start   (+13.18 s)
448.38  parent follow-up turn — all three settled
```

Sampling the process table every 0.5 s during the run never observed two live
children. Six distinct child pids appeared across the run and at most two
matching process lines at any instant, which is exactly one logical child: the
Volta `bun` shim plus the real `bun` it forks. Excess work waited, then resumed,
and nothing was rejected.

### Direct workflow-step settlement — PASS

`/weave:run t13-direct`, confirmed interactively:

```text
Workflow t13-direct-1786665057728 is now completed at step work.
```

The step child called `weave_complete_step` and the step's authoritative result
was persisted: its native session contains `weave.child.result-chunk` followed
by `weave.child.result-commit`.

### Retained hard ceilings — PASS (focused proof for the dangerous ones)

Allocating the retained ceilings live is not appropriate: 128 concurrent
model-backed children, an 8 MiB frame, and a 64 MiB aggregate transfer are
unsafe live allocations on a developer machine. They are proven by focused
executable tests at their exact UTF-8 byte boundaries — exact-minus-one, exact,
and plus-one — in `child-framing.test.ts`, `child-envelope.test.ts`,
`child-transfer.test.ts`, and `child-result-integrity.test.ts`, all of which
pass at this subject. The live run additionally observed the queue ceiling
failing closed with a typed `ChildCapacityExceeded` /`queue_capacity` result in
the resource measurement below.

## Resource measurement

Command: `bun run limit-measure.ts` from the built worktree. The script is
preserved at `/private/tmp/weave-task13-evidence/limit-measure.ts` and drives the
real `PiDelegationController` against the repository's fake child process port,
so the figures are Weave's own bookkeeping cost, not OS process cost.

| | Approved defaults | Approved hard maxima |
| --- | --- | --- |
| `max_children` / `max_concurrency` / `max_depth` / `max_processes` | 32 / 8 / 8 / 32 | 256 / 64 / 32 / 128 |
| Task size per request | 8,192 UTF-8 bytes | 65,536 UTF-8 bytes |
| Requests issued | 32 | 256 |
| Concurrent spawns observed | 8 | 64 |
| Queued observed | 24 | 128 |
| Rejected | 0 | 64, all `queue_capacity` |
| Children drained to completion | 32 | 192 |
| Live processes after `disposeAll` | 0 | 0 |
| RSS before | 82.3 MiB | 96.3 MiB |
| Peak sampled RSS | 96.3 MiB | 134.7 MiB |
| Peak over baseline | 14.0 MiB | 38.4 MiB |

Both queues are finite and bound by `max_processes`: at the hard maxima, 64 ran,
128 queued, and the remaining 64 requests failed closed with a typed
`ChildCapacityExceeded` carrying `queue_capacity`. Nothing was silently dropped
and no queue grew without bound.

Real per-child process cost was measured separately during the live queue run:
**one live child peaked at 204.0 MiB RSS** (Volta shim plus `bun`).

> **No hard-maximum viability claim.** 128 concurrent real Pi children were not
> run. At the measured ~204 MiB per live child, that configuration would need
> roughly 25 GiB of resident memory, which was neither attempted nor observed.
> The hard maxima are proven to *parse, normalize, queue, and fail closed*
> correctly; they are not proven to be operable on this host.

## Defects found live

The live proof is the reason these were found; every one of them passes every
isolated test written before it.

1. **`SequenceMismatch` on large authoritative results** — fixed in `cba7070`.
   The parent verified each control envelope asynchronously and admitted it from
   the completion callback, while `admitIncoming` enforces a strict per-child
   sequence. One envelope at a time hid it; a multi-chunk output transfer emits
   several at once, so the larger the result, the likelier the parent rejected a
   blameless child with `ChildEnvelopeMalformed` / `SequenceMismatch`.
   Verification is now serialized per child, so admission order is arrival
   order. The regression test releases held verifications newest-first and fails
   without the fix.

2. **Direct workflow steps could never persist a result** — fixed in `fd1192e`.
   `createChildSession` maps a child id onto one safe path component and hashes
   anything unsafe or longer than 64 characters. A direct step's child id is
   `direct-<instance>-<step>-<uuid>`, which always hashes, but the result guards
   compared the ref component and the reopened record's child id against the
   *raw* child id. Every direct step therefore failed with `ChildRecordCorrupt`
   and could never retrieve its own authoritative result. Both guards now
   compare the component the store derives from the expected child id; the
   commit record still binds the raw id, so acceptance is unchanged for ids that
   need no hashing.

3. **Three racing assertions in the delegation controller proof** — fixed in
   `0a6d7fc`. They raced asynchronous controller work with a single event-loop
   turn and failed roughly one run in six under CPU load. Each now waits a
   bounded number of turns for the observable it asserts.

4. **A focused verification command named a file that does not exist** — fixed
   in `0a6d7fc`. The plan listed
   `packages/adapters/pi/src/__tests__/child-session-event-bounds.test.ts`, so
   `bun test` silently ran four files where the plan claimed five. The real file
   is `child-session-events.test.ts`.

## Gates at the exact subject

- `bun test`: 8,420 pass, 11 skip, 0 fail, across 297 files.
- `bun run typecheck`: pass, 0 errors.
- `bun run lint`: pass; Biome reported 356 warnings and no errors.
- `bun run build`: pass.
- `bun run docs:check-links`: pass.
- Focused Pi package suite: 2,473 pass, 0 fail across 123 files.
- Plan focused group 1 (task, transport, settlement, projection, recovery):
  183 pass, 0 fail.
- Plan focused group 2 (framing, envelope, session events, bounded reads,
  paging): 101 pass, 0 fail.
- Plan focused group 3 (schema, parser, validator, pipeline, engine limits):
  421 pass, 0 fail.
- Plan focused group 4 (runtime contract, memory, SQLite, CLI): 351 pass,
  0 fail.

## Cleanup

- No process referencing the harness root remained after the final run.
- `weave runtime status` reported **no active lease**, with the single workflow
  instance `t13-direct-1786665057728` in status `completed`.
- The only proof-owned process left running during evidence collection was the
  local fixture server, which was stopped afterwards.
- The main checkout was not modified by the harness; the build worktrees and the
  harness live entirely under `/private/tmp`.

## Limitations

- Evidence under `/private/tmp` is machine-local. It is sufficient for this
  record but is not a durable CI artifact.
- The proof project inherits the developer's user-scope `~/.weave` config in
  addition to its own project config, because `HOME` was not isolated. Project
  settings override user settings, and every value this proof depends on is
  declared in the project config.
- The child metadata row for a child whose parent exits immediately after
  settlement can still read `running`; the durable result is unaffected and was
  retrieved in full. This was observed, is out of Task 13's scope, and is
  recorded here rather than claimed as fixed.
