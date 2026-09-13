# OpenCode 2 start-command verification

Date: 2026-09-11. Non-normative diagnostic evidence for the
[start-command behavior](../adapters/opencode2-core.md#foreground-plan-command).

## Verified

- `bun scripts/opencode2/verify-runtime.ts` passed all 20 existing verdicts
  against an isolated OpenCode `0.0.0-beta-19151` service and a deterministic
  local provider. This includes package activation, named plan execution,
  plan-state RPC, wrong-Location rejection, and cleanup.
- A separate disposable diagnostic used the packed adapter's `plans` and
  `start` RPCs against the same host version. The catalog included the fixture
  plan. A mismatched directory was rejected without an agent switch. A valid
  start selected Tapestry and stored the active plan.
- A missing-plan RPC request was rejected without an agent switch or provider
  request, rather than being reported as successful admission.
- Catalog diagnostics accepted a regular plan directory, distinguished a
  missing directory from an error, and rejected a linked `.weave` parent, a
  dangling `plans` link, and a non-directory `plans` entry.
- Parser diagnostics covered missing arguments, basenames, plan paths,
  multiple arguments, traversal, and overlong names.
- Inspection of the distributed beta-19151 binary confirmed that its CLI
  consumes a matching `slash.arguments` command through `run(arguments)` and
  returns before native server-command fallback.
- The TUI bundle contains no `Bun.spawn`, `Bun.Glob`, or pino code.

No shared service was restarted. No repository tests were added or modified.

Final packaged runtime proof: adapter `0.1.2`, host `0.0.0-beta-19151`.

- Tarball SHA-256: `fa50075aae51d19e36eccb5daed2f05c7864457467bd48d095096823262e08fb`
- Installed server-entry SHA-256: `d3a4e84f56bcd90049bd4c33d80a4f5bff88f52b7e1cfbb3a3fb82b3bc8722ce`

The final focused review found no introduced correctness blockers after the
executor/RPC failure contract and stale-session reporting fixes.

## Limits

The native interactive picker was not driven in a live CLI. Picker rendering,
keyboard selection, and cancellation during a live session move still need the
[interactive verification procedure](../testing/opencode2-verification.md#run-the-interactive-ui-proof).
Server RPC checks and CLI dispatch inspection do not replace that procedure.

The full test run reported 5,817 passes, 12 skips, and one failure in
`composeAgentSnapshots — integration with builtin config`: the Pattern prompt
does not contain the expected planning-structure text. This change does not edit
that prompt or its test. Adapter tests, typecheck, lint, public-package build,
and documentation links passed; repository lint reports existing warnings.
