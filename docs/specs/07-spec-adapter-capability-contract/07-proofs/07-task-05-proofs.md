# Task 5.0 Proof — Documentation and Installer Migration Note

## Task Summary

Updated architecture documentation to link to the Adapter Capability Contract
spec and added a migration note to the CLI installer interface.

**Why it matters**: Future adapter maintainers and engine developers need to
discover the capability contract from existing architecture docs. The migration
note on `HarnessInstaller.supported` explains the relationship between the
legacy binary signal and the richer capability readiness model.

## What This Task Proves

1. `docs/adapter-boundary.md` links to Spec 07 and documents capability
   declaration ownership rules and Safe Adapter Init constraints.
2. `docs/product-vision.md` links to Spec 07 and documents Core Readiness
   Profile semantics (required/optional, pass/fail/warn).
3. `HarnessInstaller.supported` is documented as a legacy binary installer
   signal that capability readiness complements and may supersede.
4. Safe Adapter Init is documented as read-only and adapter-owned.
5. Conditional token-usage assumption is documented.
6. Proof-artifact redaction guidance is included in the spec.
7. Documentation links resolve (relative paths verified).

## Evidence

### Files updated

**`docs/adapter-boundary.md`**:
- Added Spec 07 link to Related section.
- Added "Adapter Capability Contract" section with ownership table and Safe
  Adapter Init constraints.

**`docs/product-vision.md`**:
- Added Spec 07 link to Related section.
- Added "Adapter Capability Contract" section with readiness level table and
  Core Readiness Profile semantics.
- Added migration note: `HarnessInstaller.supported` is a legacy binary signal
  that capability readiness complements and may supersede.

**`packages/cli/src/installers/index.ts`**:
- Added `@deprecated` JSDoc to `HarnessInstaller` interface explaining the
  migration path to `AdapterCapabilityContract` + `evaluateCoreReadinessProfile`.
- Added `@deprecated` JSDoc to `supported: boolean` field.
- No code changes — documentation only.

### Typecheck output

```
bun run typecheck

@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

### Lint output

```
bun run lint

Checked 75 files in 15ms. No fixes applied.
```

### Test output

```
bun test

 415 pass
 0 fail
 1280 expect() calls
Ran 415 tests across 28 files. [252.00ms]
```

## Core Readiness Profile Semantics (documented in product-vision.md)

| Condition                              | Outcome                    |
| -------------------------------------- | -------------------------- |
| Required + `native` or `emulated`      | **pass**                   |
| Required + `degraded` or `unsupported` | **fail** (blocks readiness) |
| Optional + `degraded` or `unsupported` | **warning** (non-blocking) |
| Missing required capability            | **fail**                   |
| Missing optional capability            | **warning**                |

## Conditional Token-Usage Assumption (documented in adapter-boundary.md)

`token-usage-reporting` is conditionally required:
- If the adapter declares `unsupported` with a documented reason (notes field),
  the evaluator downgrades to a warning.
- If the adapter declares `unsupported` without a documented reason, it fails.

## Safe Adapter Init (documented in adapter-boundary.md)

Safe Adapter Init MUST NOT:
- Materialize agents
- Register lifecycle hooks
- Launch workflows or workflow steps
- Mutate harness configuration or state
- Write generated config files
- Start harness runtimes or processes

Safe Adapter Init MAY:
- Perform read-only harness environment checks (file existence, env vars,
  version queries) and report results as `CapabilityProbeResult` entries.

## Proof-Artifact Redaction Guidance

When sharing health reports, JSON output, or TOON output in issue comments or
proof artifacts:

- Replace local file paths with `<redacted>` or `<workspace-relative-path>`.
- Remove API keys, tokens, credentials, and `.env` values.
- Remove harness configuration contents that may contain secrets.
- Replace real harness names with `synthetic-adapter` in test fixtures.
- Prefix synthetic notes with `"Synthetic:"` to distinguish from real data.

## Migration Note: HarnessInstaller.supported

`HarnessInstaller.supported: boolean` in `packages/cli/src/installers/index.ts`
is a legacy binary installer-support signal. It was introduced before the
Adapter Capability Contract existed.

Future adapter work should:
1. Implement `AdapterCapabilityContract` from `@weaveio/weave-engine`.
2. Call `evaluateCoreReadinessProfile(contract)` to get `ProfileEvaluationResult`.
3. Derive `supported` from `profileResult.ready` if a boolean is still needed
   for backward compatibility.

The capability contract provides richer information: which specific capabilities
are missing, whether they are required or optional, and what remediation hints
are available.

## Reviewer Conclusion

All acceptance criteria for Task 5.0 are met:
- [x] `docs/adapter-boundary.md` links to Spec 07
- [x] `docs/product-vision.md` links to Spec 07
- [x] Core Readiness Profile semantics documented
- [x] Conditional token-usage assumption documented
- [x] Safe Adapter Init documented as read-only and adapter-owned
- [x] `HarnessInstaller.supported` migration note added
- [x] Proof-artifact redaction guidance included
- [x] Typecheck clean
- [x] Lint clean
- [x] 415 tests pass, 0 fail
