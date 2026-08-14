# Spec 33 — Pi-native path/session conformance design

Status: **APPROVED**

Warp verdict: `[APPROVE]`
Exact normative plan commit: `bba14ff`

Owner: Pi adapter. Plan: `.weave/plans/pi-child-overlay-ux-feedback.md` Task 9
(plan commit `bba14ff`). Subject baselines: reviewed commit `d59edf0`; plan
expansion commit `6035fe8`; session-directory blocker plan pin `bba14ff`; working
tree HEAD at rewrite time may be dirty relative to that pin.
Pi host under inspection: `@earendil-works/pi-coding-agent@0.84.1`
(`CURRENT_SESSION_VERSION = 3`).

This document is the normative design for Tasks 10–11. It does **not** authorize
production edits. Preserve every unrelated dirty byte until ownership is settled
and Warp approves.

**Supersedes** the prior draft that required opaque descriptors,
descriptor-relative host I/O, lifetime-held descriptors, prefix-digest append
proofs, a custom tombstone protocol, or a public `contained-native-session-io`
capability. Those requirements overfit an API Pi 0.84.1 does not provide.

**Previous Warp blockers (resolved in this revision; re-review still required):**

1. Deferred first-write / header bridge after `SessionManager.create` (§5.1).
2. Closed path-free readiness-unavailable reasons (§5.6).
3. Create-time `cwd` default and trusted narrower-policy rule (§5.1.1).
4. RPC child session directory: dual `--session` / `--session-dir`, env
   stripping, and directory identity with SessionManager (§5.3 / §7.2).

## 1. Purpose

Define the Pi-native persistent-child contract:

1. The adapter calls Pi `SessionManager.create` for Pi's generated path, v3
   header, session ID, parent, and `cwd`. Because Pi defers the first write, the
   adapter exclusively creates the validated immediate-child `0600` leaf with
   that exact Pi-generated header, reopens it through `SessionManager.open`, and
   revalidates every identity field. This bridge persists Pi's identity; it does
   not fabricate a v3/fork header.
2. The child starts in the existing Pi RPC process with both
   `--session <validated-file>` and `--session-dir <validated-child-directory>`
   under the fixed Weave session root. The validated directory is the exact
   parent of the validated session file and the same directory supplied to
   `SessionManager.create` / `open`. The launch environment removes conflicting
   inherited `PI_CODING_AGENT_SESSION_DIR`; the explicit CLI directory is the authority and
   overrides Pi settings.
3. Pi v3 JSONL remains the sole transcript. The adapter does not invent a second
   history format.
4. External readiness stays `delegated-specialist-execution`. It becomes available
   when real Pi session/process APIs and the adapter-owned session root
   initialize; otherwise the adapter stays health-only before spawn. Readiness
   failures use only the four closed path-free reasons in §5.6.
5. Engine, model, log, lifecycle, and status surfaces stay path-free. Raw host
   exceptions, causes, paths, method names, and payloads never cross into public
   Results, health/status/doctor/CLI, logs, lifecycle metadata, or model/tool
   output.

Anthropic HTTP 429 rate limits are **not** a session-capability failure. Keep
provider transport errors on the child-error path (plan Tasks 12–13). Do not fold
them into session readiness probes.

## 2. Threat model

Consistent with [`33-threat-model.md`](33-threat-model.md):

| Actor / surface | Trust |
| --- | --- |
| Model output, prompt text, project/caller input, other OS users | **Untrusted** |
| Pi coding-agent code, Weave Pi adapter code, operator-configured XDG base, processes running as the Weave user | **Trusted** |
| Malicious same-user races against local files the Weave user can already rewrite | **Residual / out of scope** |

Warp may block real containment or disclosure defects. Warp must **not**
reintroduce an unavailable opaque-descriptor or lifetime-held-fd requirement to
defend against the out-of-scope same-user attacker.

Inherited `PI_CODING_AGENT_SESSION_DIR`, Pi settings session directories, and any configured
session-dir redirect are **untrusted for child launch directory selection**. They
must not override the validated CLI `--session-dir`. The adapter strips conflicting
inherited `PI_CODING_AGENT_SESSION_DIR` from the child environment so the explicit CLI
directory remains the sole authority.

## 3. Reference audit

Official Pi is normative for ephemeral JSON spawn and for the public session
format/API. Third-party extensions are evidence only.

| Source | Pin | Role |
| --- | --- | --- |
| Pi 0.84.1 `examples/extensions/subagent/index.ts` | installed package | Normative ephemeral child: `--mode json -p --no-session`, `shell: false`, piped stdout/stderr, `message_end` → `stopReason`/`errorMessage`, abort SIGTERM then SIGKILL after 5s, failure text `errorMessage \|\| stderr \|\| assistant` |
| Pi 0.84.1 `docs/session-format.md` | installed package | Canonical v3 JSONL; sessions are path-addressed `.jsonl` files |
| Pi 0.84.1 `docs/extensions.md` | installed package | Public path-based `SessionManager.list` / session switch/create surfaces |
| `mjakl/pi-subagent` | `/tmp/weave-pi-ref-mjakl` @ `70248dcf` | RPC child; `--session` / `--session-dir` / `--fork` / `--session-id` / `--no-session`; `SessionManager.list` for create/resume; process-group cleanup; semantic/exit normalization |
| `nicobailon/pi-subagents` | `/tmp/weave-pi-ref-nico` @ `c386b258` | JSON process mode; pre-created `--session` or `--no-session`/`--session-dir`; `SessionManager.open` / `createBranchedSession` for forks; assistant `errorMessage` before signal/stderr; **reject** its prefix-only `pathWithin` |
| `baochunli/pi-collaborating-agents` | `/tmp/weave-pi-ref-collab` @ `acd50d0` | Process JSON discovers session/registry; cmux uses explicit `--session`; bounded session tail; assistant error before stderr/exit; no first-class resume. Mux-specific behavior is different-by-design |
| `hazat/pi-interactive-subagents` | `/tmp/weave-pi-ref-hazat` @ `c100577` | Explicit `--session` across standalone/lineage/fork; hand-written v3/fork bytes and model-visible `Resume: pi --session …` must be **rejected** for Weave; mux-specific behavior different-by-design |

### 3.1 Parity matrix

Statuses: present / partial / missing / different-by-design.

| Feature | Official subagent | mjakl `70248dcf` | nico `c386b258` | collab `acd50d0` | hazat `c100577` | Weave target |
| --- | --- | --- | --- | --- | --- | --- |
| Spawn mode | JSON ephemeral | RPC | JSON process | JSON process; cmux pane | interactive / mux | **RPC** (existing Weave child) |
| `--session` path | missing (`--no-session`) | present (parent resume/fork paths) | present (pre-created file) | partial (cmux only; process discovers) | present | **present** — Pi-generated path, validated then persisted by the deferred-header bridge |
| `--session-dir` / `--session-id` / `--fork` | missing | present | partial (`--session-dir` without file) | missing / mux-specific | partial (hand-rolled fork file) | **present** dual RPC `--session` + `--session-dir` (exact parent of file; same dir as SessionManager create/open); other flags only if Weave already needs them |
| `--no-session` | present | present (non-persistent) | present | n/a for durable Weave children | n/a | not for persistent Weave children |
| `SessionManager` create/open/list/fork | docs public path API | list for create/resume | open + `createBranchedSession` | discovery/registry | hand-written JSONL instead | **create/open** as sole mint authority; deferred-header bridge persists exact Pi-generated header; list/fork only through Pi APIs |
| Persistence / resume | ephemeral | present | present | partial (tail/inspect; no first-class resume) | model-visible resume path | present via Pi session file + Weave opaque refs; no model-visible path |
| Path ownership | temp prompt files only | extension-owned dirs | project/`--session` file | `~/.pi/agent/sessions/...` for cmux | extension-owned files | **fixed** `$XDG_DATA_HOME/weave/adapters/pi/sessions` |
| Launch env / settings session dir | n/a | evidence for `--session-dir` | evidence for `--session-dir` | n/a | n/a | strip conflicting inherited `PI_CODING_AGENT_SESSION_DIR`; CLI `--session-dir` overrides Pi settings; no settings redirect |
| Cancellation | SIGTERM→SIGKILL | process-group SIGTERM/SIGKILL | stop/timeout paths | process close | mux/process specific | keep existing Weave generation/lease/settlement/cancel cleanup |
| Error precedence | `errorMessage` → stderr → assistant text | semantic/exit normalization | assistantError before signal/stderr | assistantError before stderr/exit | varies | **assistant stopReason/errorMessage → bounded stderr → exit/signal** |
| Prefix-only path check | n/a | n/a | present (`pathWithin` startsWith) | n/a | n/a | **reject** — use immediate-child equality |
| Hand-written v3/fork bytes | n/a | n/a | uses SessionManager branch API | n/a | present | **reject** — bridge writes only exact Pi-generated header bytes |
| Mux / pane orchestration | n/a | n/a | partial Herdr helpers | cmux-pane mode | cmux/tmux/zellij | **different-by-design** — out of Weave child contract |

### 3.2 Adopt / reject

| Decision | Confidence | Evidence |
| --- | --- | --- |
| **Adopt** Pi public path `SessionManager` + v3 JSONL as session authority | high | `docs/session-format.md`, `docs/extensions.md`, Pi `SessionManager` |
| **Adopt** deferred-header bridge: exclusive `0600` leaf with exact Pi-generated header + newline, then `SessionManager.open` revalidation | high | Pi defers first write; plan commit `bba14ff`; persists Pi identity, not fabricated v3/fork writing |
| **Adopt** validated dual `--session <file>` and `--session-dir <dir>` on existing RPC child | high | Warp session-directory blocker; mjakl RPC both flags; nico/hazat explicit `--session`; directory must be exact parent of file and same as SessionManager create/open |
| **Adopt** strip conflicting inherited `PI_CODING_AGENT_SESSION_DIR`; CLI `--session-dir` overrides Pi settings | high | Warp session-directory blocker; untrusted env/settings must not redirect child storage |
| **Adopt** `shell: false` + bounded piped protocol/stderr | high | official subagent; mjakl `shell: false`; nico runners |
| **Adopt** error precedence assistant semantic → stderr → exit/signal | high | official `getResultOutput`; nico `assistantError`; collab finalize; mjakl normalization |
| **Adopt** SIGTERM then escalated SIGKILL / bounded process-group cleanup | high | official 5s SIGKILL; mjakl process-group; existing Weave cancel path |
| **Adopt** fixed XDG Weave session root + immediate-child equality | high | Spec 33 / ADR 0014 / `PI_NATIVE_SESSION_LAYOUT`; reject nico prefix-only |
| **Adopt** closed readiness reasons `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, `pi-process-unavailable` | high | plan commit `bba14ff`; path-free public surfaces |
| **Adopt** default `cwd` = canonical parent workspace cwd; narrower cwd only by trusted adapter/operator policy with exact post create/open equality; not a filesystem sandbox | high | plan commit `bba14ff` |
| **Reject** opaque descriptors / descriptor-relative host session I/O / lifetime-held descriptors as readiness requirements | high | Pi 0.84.1 has path APIs only; threat model residual same-user races |
| **Reject** public capability `contained-native-session-io` or `descriptor-relative-native-session-io` | high | plan Task 9 §3; readiness is `delegated-specialist-execution` |
| **Reject** blanket `path-only-session-api` as permanent health-only reason | high | path API is the real Pi surface; replace with the four closed reasons |
| **Reject** prefix-digest append proofs and custom Pi tombstone protocol | high | Pi does not provide them; not required under §2 |
| **Reject** hazat hand-written v3/fork writers and model-visible resume paths | high | `pi-extension/subagents/session.ts`, resume presentation strings |
| **Reject** nico `pathWithin` startsWith containment | high | `subagent-executor.ts` `pathWithin` |
| **Reject** relying on inherited `PI_CODING_AGENT_SESSION_DIR` or Pi settings session dir to select child storage | high | Warp session-directory blocker; CLI directory is sole authority |
| **Different-by-design** mux/cmux/zellij pane managers | high | collab/hazat; Weave uses in-process RPC child + overlay |
| **Different-by-design** official ephemeral `--no-session` JSON mode | high | Weave needs durable native children under its root |

## 4. Dirty-session inventory and ownership

Audit method: `git diff d59edf0` on the path-session surface. Bytes must be
preserved; do not stage mixed ownership. Unknown gate-removal hunks must be
**reconstructed and tested** in Tasks 10–11, not staged wholesale.

### 4.1 Untrusted gate-removal / path-session surface

| Path | Dirty delta (vs `d59edf0`) | What changed | Ownership |
| --- | --- | --- | --- |
| `packages/adapters/pi/src/native-session-host.ts` | +6 / −39 | Removed path-only refusal; create/open call live `SessionManager` | **Untrusted** |
| `packages/adapters/pi/src/child-native-sessions.ts` | +3 / −57 | Removed descriptor-safe preflight; collapsed storage-unavailable diagnostics | **Untrusted** |
| `packages/adapters/pi/src/child-session-storage-authority.ts` | +5 / −39 | Production authority returns unconditional `ok` | **Untrusted — reject as-is** |
| `packages/adapters/pi/src/required-capability-gate.ts` | deleted (−201) | Gate module removed | **Untrusted** |
| `packages/adapters/pi/src/capability-declarations.ts` | −11 | Descriptor capability surface dropped/altered | **Untrusted** |
| `packages/adapters/pi/src/capability-prober.ts` | −24 | Stopped probing descriptor-relative I/O as unavailable | **Untrusted** |
| `packages/adapters/pi/src/extension.ts` | mixed | Gate/health-only mutation refusal removed among unrelated UX wiring | **Gate hunks untrusted**; other bytes other-owned |
| Related tests under `__tests__/` for the above | dirty / deleted | Expectations loosened or gate tests removed | **Untrusted with owning module** |
| Spec §16 / smoke checklist prose claiming path I/O is ready | dirty | Premature until Tasks 11/14 | **Untrusted until Task 14** |

Committed baseline semantics (`d59edf0`): host/authority refuse with
`path-only-session-api`; store preflight requires descriptor-safe I/O; required
capability `descriptor-relative-native-session-io` forces health-only.

### 4.2 Other-session ownership (preserve; do not edit here)

| Path | Ownership |
| --- | --- |
| `packages/adapters/pi/src/rpc-child.ts` | **Other session** |
| `packages/adapters/pi/src/child-session-events.ts` | **Other session** |
| RPC / child-session-events tests | **Other session** |
| Lifecycle / parser tests (`thread-lifecycle`, `session-transition*`) | **Other session** |
| Narrow docs/proofs for concurrent runtime work | **Other session** |

Task 9 writes only this design file. Task 10 may add tests. Task 11 may edit the
§4.1 surface only after Warp approval, using exact-hunk staging or a clean
worktree.

## 5. Normative Pi-native contract

### 5.1 Session authority (deferred-header bridge)

1. Call Pi `SessionManager.create(cwd, sessionDir, options?)` as the native
   mint for path, v3 header, session id, parent link, and `cwd`.
2. Wrap every called Pi static method and handle getter/mutator with
   `Result` / `ResultAsync` (`Result.fromThrowable` /
   `ResultAsync.fromThrowable`). Expected failures never throw across the adapter
   seam.
3. Immediately after `SessionManager.create`, validate Pi's generated
   immediate-child path and the exact generated v3 header / session ID / parent /
   `cwd` against §5.2 containment and §5.1.1 cwd rules **before** any leaf write
   or spawn.
4. Because Pi defers the first write, exclusively create the **absent** regular
   `0600` leaf with that **exact** Pi-generated header plus a trailing newline.
   This step persists Pi's identity. It is **not** fabricated v3/fork writing:
   the adapter must not invent, alter, or synthesize header bytes.
5. Call `SessionManager.open` on that leaf and revalidate path, header, session
   ID, parent, `cwd`, and persistence before any spawn or trusted record mint:
   - header `type === "session"` and `version === 3`;
   - `parentSession`, `cwd`, session id match the create-time Pi-generated
     values and adapter-owned expectations;
   - handle reports persisted with the concrete session file path;
   - returned path still passes §5.2 containment.
6. Pi v3 JSONL is the sole child transcript. No second adapter history store.
7. Existing-leaf collision, exclusive-create failure, altered/fabricated header
   bytes, create/open/getter throws, or reopened identity/persistence mismatch
   fail closed with typed path-free errors and zero later Pi/process effects when
   validation can reject first.

The `sessionDir` passed to `SessionManager.create` / `open` is the same validated
child directory later supplied as `--session-dir` on RPC launch. After
validation, `dirname(sessionFile) === sessionDir` (canonical immediate-child
parent equality).

#### 5.1.1 Cwd

1. Default create-time `cwd` is exactly the canonical parent workspace cwd.
2. A narrower `cwd` is permitted only by trusted adapter/operator policy. It must
   be canonical and must equal the value Pi reports after create and after open.
3. Narrower `cwd` is explicitly **not** a filesystem sandbox. Path containment
   remains §5.2 (session root / immediate-child equality), not cwd narrowing.
4. Untrusted or mismatched `cwd` (including post-open inequality) fails closed.

### 5.2 Adapter-owned path boundary

Practical containment — **not** a public capability and **not** a descriptor API:

1. Resolve the trusted data base (`$XDG_DATA_HOME` if absolute, else
   `$HOME/.local/share`). Reject foreign uid and group/world-writable bases.
2. Append only the fixed suffix from `PI_NATIVE_SESSION_LAYOUT.segments`:
   `weave/adapters/pi/sessions`. Caller, model, and engine never supply a root or
   path.
3. Create private directories `0700` and regular session leaves `0600`.
4. Child directory component: exactly one bounded safe segment from the child id
   (`safeNativeSessionComponent`; max 64 / sha256 hex fallback). Reject `.`,
   `..`, and separators.
5. Leaf basename: one safe segment only.
6. Containment is **canonical immediate-child equality**, not prefix:
   `dirname(sessionFile) === childDir` and `basename(sessionFile) === expectedLeaf`.
   Reject `startsWith(childDir + "/")` alone.
7. Reject symlink, wrong kind, permissive mode, and any returned path that escapes
   the held child directory.
8. Opaque refs remain root-relative `<component>/<basename>` only. Absolute or
   traversal refs fail closed with zero Pi/process effects when validation can
   reject first.

Existing Weave deletion-ledger / tombstone files under the adapter root, if kept
for product reasons, are adapter metadata — not a Pi-required protocol and not
part of session authority.

### 5.3 Child process

1. Spawn through the existing Pi RPC child path only after the deferred-header
   bridge succeeds, with **both**:
   - `--session <validated-file>`
   - `--session-dir <validated-child-directory>`
2. The validated directory MUST be:
   - the exact canonical parent of the validated session file
     (`dirname(sessionFile) === sessionDir`);
   - the same directory supplied to `SessionManager.create` / `open`.
3. Launch environment MUST remove conflicting inherited `PI_CODING_AGENT_SESSION_DIR`. The
   explicit CLI `--session-dir` is the authority and MUST override Pi settings or
   any configured/settings session directory. Settings or env MUST NOT redirect
   child session storage away from the validated directory.
4. Missing either arg, mismatched file/dir pair, or directory that is not the
   exact parent of the validated file denies **before spawn** with a typed
   path-free error. Validated filesystem paths MUST NOT appear in failure
   output on public surfaces (§5.5).
5. `shell: false`; bounded piped protocol/stdout and stderr.
6. Keep existing generation, lease, settlement, and cancel cleanup. Abort remains
   bounded (SIGTERM with escalated SIGKILL / process-group cleanup as the RPC
   owner already implements).
7. Do not adopt mux/pane managers, hand-written fork writers, or model-visible
   filesystem resume instructions.

### 5.4 Error precedence (informs Tasks 12–13)

When classifying child failure for diagnostics and settlement:

1. Pi assistant semantic terminal state (`stopReason` / `errorMessage`) from
   parser-approved session/RPC events.
2. Else bounded stderr.
3. Else exit code / signal.

Provider HTTP 429 bodies stay on the sanitized child-error path; they do not
flip session-capability readiness.

### 5.5 Path non-exposure and raw-detail prohibition

Filesystem paths exist only inside Pi-adapter modules that already own session
I/O and argv construction. Engine APIs, model/tool content, structured logs,
health/status/doctor/CLI output, Runtime Store / lifecycle metadata, and proof
fixtures receive opaque ids/refs and typed path-free reasons only.

Raw host exceptions, causes, paths, method names, and payloads **never** cross
into public Results, health/status/doctor/CLI, logs, lifecycle metadata, or
model/tool output. Internal private capture for adapter debugging is allowed only
when it cannot reach those surfaces.

Failure paths for missing/mismatched `--session` / `--session-dir` validation
likewise MUST NOT leak validated filesystem paths.

### 5.6 Readiness / capabilities

| Item | Rule |
| --- | --- |
| External capability | `delegated-specialist-execution` (emulated) |
| Available when | Pi `SessionManager` create/open present; adapter session root initializes with required permissions; RPC/process launch surface is ready |
| Otherwise | health-only **before spawn**; typed unavailable reasons from the closed enum below |
| Closed unavailable reasons (exact) | `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, `pi-process-unavailable` |
| Remove | `requireDescriptorSafeSessionIo`, `descriptor-relative-native-session-io`, blanket `path-only-session-api`, any public `contained-native-session-io` |
| Overrides | None. No env/config flag may fake readiness |
| Storage authority | Must not return unconditional `ok`, and must not accept an asserted fact. The session API is checked on the host object; the root is proven by a real no-follow open plus a descriptor-relative probe and delivered as an opaque proof no caller can forge or read a path from; the process surface is checked for a callable `spawn`. Mint only after those checks; re-check before spawn/mutation. The authority is mandatory in readiness probing, thread sources, the store, controllers, and transports: an absent verdict reads as unavailable. Test-only doubles stay under `__tests__/` |
| Launch grants | Mint only from a session record the store itself validated and returned (provenance by object identity), after reopening the proven ref and revalidating the complete header and identity. A store declares `read-only` or `authorized` explicitly; there is no default |
| Header validation | One strict, complete Pi v3 validator guards create, reopen, restore, descriptor reads, paging, and grant mint |
| Disclosure | Map probe failures only to the four closed path-free reasons. Raw host messages, causes, paths, method names, and payloads stay private (§5.5) |

## 6. Module seam (Task 11 target)

Deep module behind a small interface (names indicative):

- prove real Pi session/process + root readiness → private authority token
- create via `SessionManager.create`, run the deferred-header bridge
  (exclusive exact Pi-generated header leaf), open/revalidate through
  `SessionManager.open` with §5 validation
- hand validated file path and validated child directory only to the existing
  RPC argv/env builder (`--session` + `--session-dir`; strip `PI_CODING_AGENT_SESSION_DIR`)

Callers outside the seam see opaque refs and typed path-free errors only.
Implementation stays in the §4.1 Pi adapter files.

## 7. Exact Task 10 RED tests

Write the smallest failing tests against **committed** production semantics
(`d59edf0`), not against unknown dirty hunks. Expected pre-fix failure: committed
code refuses with `path-only-session-api` / descriptor gate, or lacks the new
assertions. Do **not** add malicious same-user race tests.

### 7.1 Host and store

| ID | Assertion |
| --- | --- |
| H1 | Valid create reaches `SessionManager.create` with adapter-supplied `sessionDir` under the trusted child root |
| H2 | Valid open reaches `SessionManager.open` with the exact leaf path + matching `sessionDir` |
| H3 | Host wraps create/open/getter throws as typed Result errors |
| B1 | After create, exclusive create of the absent immediate-child `0600` leaf writes the exact Pi-generated header bytes plus newline (byte-identical; no fabricated/altered header) |
| B2 | Existing-leaf / exclusive-create collision fails closed; zero later open/spawn effects |
| B3 | Fabricated or altered header bytes (vs the create-time Pi-generated header) fail closed |
| B4 | Create, open, or accessed handle getter throw maps to typed path-free Result failure |
| B5 | Reopened session preserves persistence and identity (path, header, session ID, parent, cwd) equal to create-time Pi-generated values |
| N1 | Happy-path create+bridge+open validates Pi header/id/parent/cwd/persistence and returns an opaque ref |
| N2 | Caller/model cannot supply a filesystem path; absolute/traversal refs rejected with zero Pi calls |
| N3 | Symlink leaf or symlink child-dir rejected; zero Pi calls |
| N4 | Wrong kind (directory-as-leaf) rejected |
| N5 | Permissive file/dir mode rejected |
| N6 | Root escape / non-immediate-child returned path rejected |
| N7 | Malformed v3 header, wrong parent, wrong cwd, wrong session id, or non-persisted handle → typed failure |
| N8 | Permissions: directories `0700`, leaves `0600` |
| N9 | Immediate-child equality (not prefix) for returned paths |
| N10 | Engine-facing records/APIs contain no filesystem path strings |
| C1 | Default create/open `cwd` equals the canonical parent workspace cwd |
| C2 | Trusted adapter/operator narrower-policy `cwd` is canonical and equal after create and open |
| C3 | Untrusted or mismatched `cwd` (including post-open inequality) fails closed |

### 7.2 Authority, RPC argv, capabilities

| ID | Assertion |
| --- | --- |
| A1 | Production storage authority is not unconditional `ok` without real readiness checks |
| A2 | Failed root permission / foreign ownership / missing SessionManager → unavailable via the closed enum |
| R1 | Spawned RPC child receives both `--session <validated-file>` and `--session-dir <validated-child-directory>` with exact validated values; `shell: false` and bounded stdio handling only after the deferred-header bridge succeeds |
| R2 | Validated session-dir equals `dirname(validated-file)` (canonical immediate parent) and equals the directory supplied to `SessionManager.create` / `open` |
| R3 | Conflicting/malicious inherited `PI_CODING_AGENT_SESSION_DIR` is removed from the child launch environment; it cannot redirect storage |
| R4 | Configured/settings session directory cannot redirect the child away from the validated `--session-dir`; CLI directory overrides Pi settings |
| R5 | Missing either `--session` or `--session-dir`, or a mismatched file/dir pair, denies before spawn with zero process launch |
| R6 | Denial/failure output for R5 (and related argv validation) contains no validated filesystem path strings |
| E1 | Old `descriptor-relative-native-session-io` absent from required set; no public `contained-native-session-io` |
| E2 | `delegated-specialist-execution` ready only when real Pi API/root/process probes pass; else health-only before spawn |
| E3 | No path leak across Results, health/status/doctor/CLI, logs, Runtime Store/lifecycle metadata, model/tool content, or proof fixtures |
| E4 | Exactly the four closed readiness reasons are used: `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, `pi-process-unavailable` (one coverage assertion per enum value) |
| E5 | Raw-detail leak sentinels (host exception text, causes, paths, method names, payloads) never appear on public Results, health/status/doctor/CLI, logs, lifecycle metadata, or model/tool output |
| S1 | Semantic error precedence: assistant `stopReason`/`errorMessage`, then bounded stderr, then exit/signal |
| S2 | Process-group abort/cleanup remains bounded |
| X1 | Anthropic 429 is classified on the child-error path, not as session-capability failure |

### 7.3 Explicit non-goals for Task 10

- No malicious same-user TOCTOU / identity-swap race suite.
- No dependence on dirty gate-removal sources as the subject under test.
- No edits to other-session `rpc-child.ts` / `child-session-events.ts`
  production files; argv/precedence tests may use existing seams or narrowly
  owned test files handed off by that owner.

## 8. Attack cases in scope

Traversal; absolute ref; unsafe basename; symlink dir/leaf; wrong kind;
permissive mode; root escape via host-returned path; prefix confusion;
header/parent/cwd/session-id mismatch; fabricated/altered deferred header;
existing-leaf exclusive-create collision; non-persisted reopen handle; host
create/open/getter throw; foreign/world-writable XDG base; relative
`XDG_DATA_HOME`; probe side effects that create sessions; unconditional
authority `ok`; path leakage; raw host exception/cause/method/payload leakage;
unsafe readiness override; caller-supplied path; untrusted or mismatched cwd;
missing or mismatched `--session` / `--session-dir`; conflicting inherited
`PI_CODING_AGENT_SESSION_DIR`; Pi settings/configured session-dir redirect away from the
validated directory; validated path leakage in spawn-denial failure output.

Out of scope: malicious same-user replacement races against files the Weave user
can already rewrite (`33-threat-model.md` residual risks).

## 9. Warp blocker resolution and remaining questions

### 9.1 Previous Warp blockers — resolved in this revision

| # | Prior blocker | Resolution |
| --- | --- | --- |
| 1 | Deferred first write / how to persist identity without fabricating v3/fork bytes | §5.1 deferred-header bridge: validate Pi-generated path/header/id/parent/cwd after create; exclusively create absent regular `0600` leaf with exact Pi-generated header + newline; `SessionManager.open` and revalidate. Persists Pi's identity; not fabricated v3/fork writing. |
| 2 | Exact closed readiness-unavailable enum after retiring blanket `path-only-session-api` | §5.6 / E4: exactly `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, `pi-process-unavailable`. Raw host exceptions, causes, paths, method names, and payloads never cross public surfaces (§5.5 / E5). |
| 3 | Create-time `cwd`: parent workspace vs narrower sandbox | §5.1.1: default exactly canonical parent workspace cwd; narrower cwd only by trusted adapter/operator policy; must be canonical and equal after create/open; explicitly not a filesystem sandbox. |
| 4 | RPC child session directory / env authority (final Warp blocker at plan commit `bba14ff`) | §5.3 / R1–R6: RPC launch passes both `--session <validated-file>` and `--session-dir <validated-child-directory>`; directory is exact parent of the file and the same directory supplied to SessionManager create/open; strip conflicting inherited `PI_CODING_AGENT_SESSION_DIR`; CLI directory overrides Pi settings; missing/mismatched args deny before spawn; no validated paths in failure output. **Resolved for re-review.** |

Document status is **APPROVED**. Warp verdict: `[APPROVE]`. Exact normative plan
commit: `bba14ff`.

### 9.2 Remaining non-blocker question

1. How much of dirty `extension.ts` non-gate UX work is already approved under
   earlier plan tasks versus still needing exact-hunk separation at Task 11
   staging. (Ownership/staging question; not a path-session contract blocker.)

## 10. Conditions for Warp approval

Warp may mark this design approved only when all are true:

1. Warp accepts §2, including same-user malicious races as residual/out of scope,
   and does not reintroduce opaque-descriptor requirements.
2. Warp accepts §5 as the Pi-native contract: SessionManager authority with the
   deferred-header bridge, adapter path boundary, cwd rules, RPC dual
   `--session` / `--session-dir` with env stripping and settings override, error
   precedence, path-free / raw-detail-free diagnostics, closed readiness
   reasons, and `delegated-specialist-execution` readiness.
3. Warp accepts §3 adopt/reject and parity matrix (or returns a numbered delta).
4. Warp accepts §7 as the Task 10 RED matrix including R1–R6 (or returns a
   numbered delta).
5. Every item in §9.1 is accepted on re-review; §9.2 is answered or explicitly
   deferred with owner + follow-up task.
6. No production/test merge of §4.1 untrusted hunks proceeds before Tasks 10–11
   reconstruct the behavior on a clean subject.

Warp re-review complete. Status: **APPROVED**. Verdict: `[APPROVE]`. Exact
normative plan commit: `bba14ff`.

## 11. Source index

| Symbol / path | Role |
| --- | --- |
| Pi 0.84.1 `SessionManager.create` / `open` / `list` | Path API and v3 JSONL authority |
| Pi 0.84.1 `examples/extensions/subagent/index.ts` | Ephemeral spawn + error/cancel reference |
| Pi 0.84.1 `docs/session-format.md`, `docs/extensions.md` | Format and public session APIs |
| `/tmp/weave-pi-ref-{mjakl,nico,collab,hazat}` at pinned SHAs | Third-party evidence |
| `resolvePiNativeSessionRoot`, `PI_NATIVE_SESSION_LAYOUT`, `safeNativeSessionComponent` | Adapter root/ref policy |
| `createPiNativeSessionHost`, `PiNativeSessionStore`, `createPiChildSessionStorageAuthority` | Host/store/authority seams |
| RPC argv `--session` + `--session-dir`; strip `PI_CODING_AGENT_SESSION_DIR` | Child launch path/dir authority |
| `delegated-specialist-execution` | External readiness capability |
| Closed readiness reasons | `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, `pi-process-unavailable` |
| Spec 33; `33-threat-model.md`; ADR 0014 | Contract parents |
| Plan Tasks 9–11 in `pi-child-overlay-ux-feedback.md` (commit `bba14ff`) | Execution sequence |
