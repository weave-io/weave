# Task 12 Proof Artifact — Complete the acceptance manifest

- Spec: [`33-spec-pi-adapter.md`](../33-spec-pi-adapter.md) §22, §25
- Issue: weave-io/weave#21, Task 12
- Status: ✅ Automated machinery complete, including exhaustive closed-set wiring for all 9 categories Spec 33 §25 names — ✅ a real completion-channel policy bug found during live exact-host smoke is fixed and regression-tested (see "Addendum" below) — ⏳ live TUI smoke execution and result recording still outstanding (see "What remains" below)

## Summary

This change completes the machinery Spec 33 §25 requires for the acceptance
manifest, without fabricating the one thing that can only come from a real
interactive Pi TUI session: live smoke *results*. A prior pass (audited and
extended by this change) added the manifest, validator, host-compatibility
matrix, smoke-checklist parser, and generator; this pass closes the gaps an
audit against §22–§25 found:

1. A checked-in, schema-valid acceptance manifest
   (`docs/specs/33-spec-pi-adapter/acceptance-manifest.json`) tracing every
   one of the 20 mandatory `PI-*` requirement IDs to real named automated
   tests, real packed-proof evidence, and real live-smoke checklist items.
2. A validator (`scripts/release/acceptance-manifest.ts`) that parses the
   manifest against a Zod mirror of `acceptance-manifest.schema.json`
   (the checked-in JSON schema stays normative; the Zod schema mirrors it
   field-for-field), rejects duplicate/missing/orphan requirement IDs, and —
   given an injected file reader — proves every named test and packed-proof
   entry actually exists in the named file, that every live-smoke checklist
   ID names a real checklist row, **and now also rejects orphan canonical
   evidence in the other direction**: any `PACKED_PROOF_REGISTRY` entry or
   checklist item that exists but is never cited by any requirement row
   (`EvidenceVerificationReport.orphanEvidence`). This caught a real bug:
   checklist item `S022` ("Cleanup") existed but no row referenced it; fixed
   by adding it to `PI-ACT`'s `liveSmoke.checklistIds`.
3. **`CLOSED_SET_REQUIREMENTS` now wires all nine closed-set categories
   Spec 33 §25's closing sentence names**, not just three:
   - `PI-CAP` → `ALL_CAPABILITY_IDS` (19 capabilities)
   - `PI-CMD` → `WEAVE_COMMAND_NAMES` (9) **+ `WEAVE_COMMAND_CLASSIFICATIONS`**
     (3: `mutating`/`read-only`/`idempotent-cleanup` — the invalid-state
     gating dimension exercised by health-only mode)
   - `PI-LIF` → 10 named lifecycle operations
   - `PI-DEL` → **`PI_CONTROL_KINDS`** (11 private control envelope/reply
     kinds, `child-envelope.ts`)
   - `PI-POL` → **`PERMISSION_OUTCOME_KINDS`** (3: `allow-unmanaged`,
     `allow`, `block` — the permission bridge's real closed outcome type;
     `block`'s free-form `reason: string` is not a closed literal union in
     code today, documented as an honest limitation in the row's `notes`
     rather than fabricated as closed)
   - `PI-PLN` → **`PLAN_TASK_STATES`** (3: `pending`/`in_progress`/
     `completed`, new export added to `@weaveio/weave-engine`'s
     `plan-state-provider.ts`, matching the `[ ]`/`[~]`/`[x]` markers
     `plan-render.ts` emits)
   - `PI-ART` → **`ARTIFACT_APPROVAL_ACTOR_KINDS`** (2: `user`/`agent`) +
     **`RECONCILIATION_AUTHORIZATION_SOURCES`** (existing engine export, 4:
     `user`/`runtime`/`review-gate`/`security-gate`)
   - `PI-PKG` → **`HOST_BOUNDARY_TOKENS`** (3: `HOST_PACKAGE_NAME`,
     `HOST_VERSION_FLOOR`, `HOST_VERSION_CEILING`)
   - `PI-ERR` → **every `PiAdapterFailureCode`, impact, and recovery value**
     (`PiAdapterFailureCodeSchema.options` etc., ~47 codes + 3 impacts + 7
     recoveries), locked exhaustive by a new dedicated schema-lock test file
     (`packages/adapters/pi/src/__tests__/failure-taxonomy.test.ts`) since
     21 of the 47 codes had zero references anywhere in the existing test
     suite — a real gap the prior pass's own "What remains" section
     flagged and left open.

   Every new source array is either an existing engine/adapter export
   reused as-is, or a small new export added next to the type it closes
   (`WEAVE_COMMAND_CLASSIFICATIONS` in `commands.ts`,
   `PLAN_TASK_STATES` in `plan-state-provider.ts`) — no duplicated
   literal lists were invented where a real source already existed.
4. A single source-controlled exact-host compatibility record
   (`packages/adapters/pi/src/host-compatibility-matrix.ts`, Spec 33 §22)
   that derives its range from `host-compatibility.ts`'s own floor/ceiling
   constants, so the two can never drift apart.
5. A digest-bound stable TUI smoke checklist
   (`docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`, 23 items,
   `S001`–`S023`), now with every item referenced by at least one
   requirement row (previously `S022` was orphaned — fixed).
6. A generator (`scripts/release/generate-acceptance-manifest.ts`) that
   **no longer throws**. Every step (package.json read, pack, tarball
   digest, git HEAD resolution, checklist read/parse, structural
   validation) now returns an explicit `Result`/`ResultAsync`, and the
   exported `generateAcceptanceManifest()` returns
   `ResultAsync<GeneratedAcceptanceManifestResult, GenerateAcceptanceManifestError>`
   — a typed discriminated-union error, never a rejected promise from an
   uncaught throw. The CLI entrypoint (`if (import.meta.main)`) is the one
   legitimate framework boundary and uses `.match()` to convert the Result
   into `process.exitCode`. `BunSmokeChecklistReader.read()`
   (`scripts/release/smoke-checklist.ts`) was the same class of bug
   (`Bun.file(...).text()` unwrapped, `Promise<string>` in the public
   interface) and is fixed the same way:
   `read(): ResultAsync<string, SmokeChecklistReadError>`.
   `BunEvidenceFileReader.read()` already returned a `Result` but wrapped
   `file.exists()`/`file.text()` without `ResultAsync.fromPromise`
   (a TOCTOU throw risk); both calls are now individually wrapped.

## Acceptance criteria evidence

### ✅ Every mandatory PI-* requirement is traced to real named tests and packed proof

`scripts/release/acceptance-manifest-data.ts` declares all 20 rows
(`PI-ACT` … `PI-MODE`). Each row's `tests` object names an existing test
file plus the exact `it(...)` string in that file; each row's `packedProof`
references `PACKED_PROOF_REGISTRY` entries. `PI-PLN` gained a fourth test
(`plan-render.test.ts`) and `PI-ERR` a seventh
(`failure-taxonomy.test.ts`) so their closed-set members are genuinely
present in the referenced tests' text, not just claimed.

### ✅ Validation that named evidence exists — and that nothing is orphaned

`verifyAcceptanceManifestEvidence()` confirms every named test/proof string
is literally present, every `packedProof.evidenceIds` entry resolves, and
every `liveSmoke.checklistIds` entry names a real row — **and now also**
computes the reverse direction: any `PACKED_PROOF_REGISTRY` key or
checklist item ID never cited by any requirement is reported in
`orphanEvidence`, and `ok` is `false` if that list is non-empty.
`scripts/release/__tests__/acceptance-manifest.test.ts` covers both
directions (`"flags a packedProof registry entry that no requirement
references"`, `"flags a checklist item ID that no requirement
references"`), plus a regression test against the real committed data
(`"has no checklist item that every requirement row collectively fails to
reference"`) that would have caught the `S022` gap.

### ✅ Closed sets are exhaustive for all nine categories Spec 33 §25 names

See the `CLOSED_SET_REQUIREMENTS` list above. Every wired closed set is
checked against the real, already-existing test files it's attached to
(no new production behavior was added solely to satisfy this proof); the
one exception, `PI-ERR`, needed a new dedicated schema-lock test because
no existing test suite exhaustively referenced all ~47 codes by name.

### ✅ Exact-host compatibility matrix implemented

Unchanged from the prior pass: `PI_HOST_COMPATIBILITY_MATRIX` derives from
`host-compatibility.ts`'s floor/ceiling constants; `validateHostCompatibilityMatrix()`
rejects drift. `PI-PKG`'s closed set now also asserts the three boundary
tokens (`HOST_PACKAGE_NAME`, `HOST_VERSION_FLOOR`, `HOST_VERSION_CEILING`)
are present in the tests that exercise that matrix.

### ✅ Digest-bound stable TUI smoke checklist/evidence machinery prepared, not executed

`docs/specs/33-spec-pi-adapter/33-smoke-checklist.md` is unchanged (23
rows, all `Pending`). Every row is now referenced by at least one
requirement (`S022` fix).

### ✅ Fallible file/pack/generation APIs use Result/ResultAsync, never throw

`generate-acceptance-manifest.ts` and `smoke-checklist.ts`'s
`BunSmokeChecklistReader` no longer throw; `acceptance-manifest.ts`'s
`BunEvidenceFileReader` wraps both filesystem calls. All three are covered
by tests exercising both the happy path and a genuine error path (the new
`"returns a typed PackageJsonReadFailed error instead of throwing for a
root with no such package"` test calls `generateAcceptanceManifest` with a
nonexistent root and asserts `isErr()` with the correct discriminant,
rather than expecting a throw).

### ✅ Readiness docs updated without claiming false readiness

`docs/adapter-readiness-status.md`, `docs/pi-adapter.md`, and
`docs/adapters/pi.md` (already updated by the prior pass) now also name
the full nine-category closed-set list and the orphan-rejection behavior
instead of the narrower "capability/command/lifecycle" description; the
live-TUI-smoke-pending / `result: "pending"` framing is unchanged and still
accurate.

## Test run

```
$ bun test packages/adapters/pi/src scripts/release
...
 822 pass
 0 fail
 2557 expect() calls
Ran 822 tests across 75 files. [58.63s]

$ bun test packages/engine/src/__tests__/
 1990 pass, 0 fail, 8146 expect() calls across 54 files

$ bun run typecheck   # exit 0
$ bun run build       # exit 0
```

New/changed test files in this pass:

| File | Purpose |
| --- | --- |
| `packages/adapters/pi/src/__tests__/failure-taxonomy.test.ts` (new) | Schema-lock: `PiAdapterFailureCodeSchema`/impact/recovery match a frozen list exactly, in both directions |
| `packages/engine/src/__tests__/plan-state-provider.test.ts` | +1 test: `PLAN_TASK_STATES` exhaustiveness |
| `scripts/release/__tests__/acceptance-manifest.test.ts` | +4 tests: orphan packed-proof entry, orphan checklist item, no-orphan-for-real-data, expanded closed-set fixture injection for all 9 categories |
| `scripts/release/__tests__/generate-acceptance-manifest.test.ts` | +1 test: typed error path (no throw) for a nonexistent root; existing happy-path test updated to unwrap the new `ResultAsync` |
| `scripts/release/__tests__/smoke-checklist.test.ts` | Updated real-checklist test to unwrap the new `ResultAsync`-based `read()` |

## Addendum: live exact-host smoke found and fixed a real completion-channel policy bug

Running the live exact-host smoke against a direct-step child descriptor
with `execute: deny` surfaced a real defect this proof's automated
machinery could not catch on its own (it proves evidence *exists*, not
that the adapter's runtime behavior is correct): the child's
`composedPrompt` contained the workflow step instructions as expected, but
`latestAssistantOutput` ended as plain prose (`SMOKE_FLOW_COMPLETE`) with
`stopReason: "stop"` and no completion candidate — the workflow failed with
a missing candidate instead of completing structurally.

**Root cause.** `buildWeaveCompleteStepToolRegistration`
(`structured-completion.ts`) documented `weave_complete_step` as a private
controller-reporting channel that "never requests approval," but its
resolver unconditionally mapped every call to capability `execute`. The
valid smoke descriptor denies `execute`, so `PiPermissionBridge.intercept()`
blocked the completion call before the recorder ever saw it — the doc
comment's claim and the actual policy evaluation had silently diverged.
The model, unable to report completion structurally, fell back to prose,
which is never a valid settlement per Spec 33 §15.

**Fix.** A narrow, adapter-owned control-channel authorization path in
`PiPermissionBridge.intercept()` (documented in full in
[`docs/adapter-boundary.md`'s "Control-channel Tools"
section](../../adapter-boundary.md#control-channel-tools)): a
registration opts in with `controlChannel: true`; the caller (`extension.ts`)
attests a live, freshly-derived `directStepActive: state.directStep !== undefined`
for every call; `intercept()` still unconditionally re-verifies live tool
provenance first; only when the registered identity is both
`controlChannel`-eligible in the sealed plan and the live attestation is
true does `intercept()` skip the engine's ordinary capability-policy gate
and allow the call directly. Every other tool, and every ordinary/nested
child, is unaffected — `execute: deny` still blocks `bash` on the very same
descriptor. This is not a change to engine capability semantics; it is
entirely adapter-owned per `docs/adapter-boundary.md`'s ownership matrix
("Concrete tool discovery, identities, resolvers, interception, and
approval UI" is adapter-owned).

**Regression coverage added** (see `docs/adapter-boundary.md`'s
Control-channel Tools section for the exact file/test list):
unit-level bypass-eligibility tests in `permission-bridge.test.ts`
(execute-deny blocks bash but allows completion only with attestation;
no bypass without plan membership; displaced/colliding provenance still
blocks even with attestation); end-to-end tests in `child-mode.test.ts`
against the real compiled extension (same four properties, plus proof that
an ordinary/nested child never registers `weave_complete_step` and gains
no completion authority even when it names the exact tool, and that the
recorded candidate reaches the settlement envelope); and
`structured-completion.test.ts` proves the registration itself carries
`controlChannel: true` and that its `execute()` still records into the
recorder (the fail-closed fallback resolver still maps to `execute`).

```
$ bun test packages/adapters/pi/src/__tests__/permission-bridge.test.ts \
    packages/adapters/pi/src/__tests__/structured-completion.test.ts \
    packages/adapters/pi/src/__tests__/child-mode.test.ts
 79 pass, 0 fail

$ bun test packages/adapters/pi   # full adapter package
 673 pass, 0 fail, 1866 expect() calls across 48 files

$ bun run typecheck   # exit 0, 0 errors across every workspace package
```

This fix does not itself flip any `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`
row to `Pass`, nor `scripts/release/acceptance-manifest-data.ts`'s `pending`
results — live TUI smoke execution and result recording remain outstanding
per "What remains" below; the smoke run that found this bug must be
repeated end-to-end against the fixed adapter before any row is marked
`Pass`.

**Second live finding: control-call aliasing bug (issue #21 Task 12).**
Continuing exact-host diagnostics after the completion-channel policy fix,
the direct-step child emitted a valid tool input
`{outcome:"success",method:"agent_signal",message:"SMOKE_FLOW_COMPLETE"}`
but the recorder saw a malformed empty shape `{}` — the completion candidate
reached settlement with no `outcome` field, failing closed per Spec 33 §15.

**Root cause.** The control-channel bypass in
`PiPermissionBridge.intercept()` returns `{kind:"allow",call:input.call}`
with the SAME object reference as `toolCallEvent.input` when the call is
eligible and already normalized. `extension.ts`'s `tool_call` handler then
destructively replaces `toolCallEvent.input`: it deletes every key from
`toolCallEvent.input`, then `Object.assign`s from `decision.call` — but
these are aliases to the exact same object, so the delete loop empties both
before the assign runs, leaving the recorder (and the real Pi host's tool
execution path) with `{}`.

The existing `child-mode.test.ts` missed this because the test passed
`{...completionInput}` (a spread copy) to `host.fire("tool_call", ...)`
while `registration.execute` received the separate original
`completionInput` — two distinct objects, so the destructive replacement
had no cross-talk.

**Fix.** Minimal safe identity guard in `extension.ts`'s child-mode
`tool_call` handler: only perform the destructive key deletion and
`Object.assign` when `decision.call !== toolCallEvent.input`. When they are
the same reference, the input is already correct and requires no mutation.
This preserves policy normalization (the engine may still return a distinct
normalized `call` object), provenance (unchanged), and the closed schema (no
new fields, no type widening).

**Regression coverage.** Modified the existing "a direct-step child's own
weave_complete_step call bypasses the descriptor's execute:deny policy"
test in `child-mode.test.ts` to pass the exact same `completionInput`
object reference to both `host.fire("tool_call", ...)` and
`registration.execute(...)`, proving the bug red (settlement outcome:
`"failed"` instead of `"completed"`), then green after the identity guard.
No additional focused same-reference/distinct-reference tests added — the
existing test now exercises the same-reference path (the regression), and
the numerous other tool-call tests throughout the suite implicitly cover
the distinct-reference path (unchanged behavior).

```
$ bun test packages/adapters/pi/src/__tests__/child-mode.test.ts
 26 pass, 0 fail, 78 expect() calls
```

## What remains (live execution — for the parent agent)

This task deliberately stops short of claiming stable readiness. The prior
pass's item 4 ("optionally extend `CLOSED_SET_REQUIREMENTS`") is now done;
only the live-execution items remain:

1. **Run the digest-bound live TUI smoke checklist.** Install the exact
   packed tarball (regenerate via
   `bun scripts/release/generate-acceptance-manifest.ts` for a fresh local
   binding, or use the real CI-produced artifact at actual release time)
   inside a real interactive Pi TUI session against the exact tested host
   version, and work through all 23 rows of
   `docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`.
2. **Record the outcome.** Update the checklist rows from `Pending` to
   `Pass`/`Fail`, and once all 23 are `Pass` against the same binding, flip
   every requirement's `result` in `scripts/release/acceptance-manifest-data.ts`
   (and regenerate `acceptance-manifest.json`) from `"pending"` to `"pass"`.
3. **Bind to the real release artifact.** At actual stable-release time,
   replace the generator's local `payloadArtifactId`/`runAttempt` with the
   real GitHub Actions artifact identity per Spec 33 §25's `pi-stable-smoke`
   gate, and re-run the smoke checklist against that exact binding — any
   rebuild invalidates the previous pass.
