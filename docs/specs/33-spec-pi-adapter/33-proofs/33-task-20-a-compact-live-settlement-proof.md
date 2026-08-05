# Task 20(a) compact live settlement proof

Result: **FAIL**

This record covers only Task 20 matrix item (a): compact block live fragment and settlement tail. It contains no raw prompt, child transcript, native session ID, or child session path.

## Harness identity

| Field | Value |
| --- | --- |
| Date | `2026-08-05` |
| Herdr pane | `w23:p8H` |
| Pi | `0.83.0` |
| Pi extension source | `npm:@weaveio/weave-adapter-pi` |
| Setup proof | [`33-task-20-release-setup-proof.md`](./33-task-20-release-setup-proof.md) |
| Artifact | `weaveio-weave-adapter-pi-0.0.1-0b68a775-task20-73cca4466e6c.tgz` |
| Artifact SHA-256 | `73cca4466e6cd0a82d682225509c8f4aa39c783fd9c5ded5abc1509b40f51c0a` |
| Installed extension SHA-256 | `c13eaf83ec49472ef2661da4c3a26a145eabf7b8bdb5295b31d4f49ee6b6fdfd` |

The current pane loaded the npm package entry point. Its live footer showed `Connected`, `ready`, and `WEAVE · LOOM`.

## Structured readiness

```yaml
health:
  mode: ready
  result: PASS
status:
  trust: trusted
  mode: interactive
  healthOnly: false
  result: PASS
provenanceOverrideAbsent:
  result: FAIL
  observed: WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE was present in the live Pi process
```

The trusted status follows from the active `npm:` package source. The ready footer establishes that the interactive generation was not in health-only mode. The inherited unsafe override is a release-harness setup deviation and must be removed before the scenario is rerun.

## Delegation attempt

One ordinary `shuttle-mini` delegation used the unique safe marker `TASK20A_SAFE_M7Q2`. The request was bounded and allowed no tools or file edits.

The delegation failed before child process spawn with this sanitized typed result:

```yaml
ok: false
error: ChildSpawnFailed
reason: thread-session-create-failed
retryable: true
recovery: retry
```

A direct storage-boundary diagnostic resolved the default native session layout and returned `symlink-rejected`. The current environment did not define `XDG_DATA_HOME`, and the default `$HOME/.local` component is a symlink. The no-follow native session store therefore refused the path before it created a child session.

## Assertions

| Assertion | Result | Sanitized evidence |
| --- | --- | --- |
| Current pane is ready | **PASS** | Live footer showed `Connected ready WEAVE · LOOM`. |
| Status is trusted interactive and health-only is false | **PASS** | Active npm source, interactive TUI, and ready generation. |
| Release verification has no unsafe provenance override | **FAIL** | The live Pi process inherited the unsafe override. |
| Ordinary delegation starts | **FAIL** | Typed pre-spawn failure: `thread-session-create-failed`. |
| Live compact block has exactly three sanitized lines | **FAIL — not observed** | No child run started and no compact sample was emitted. |
| Live block contains a non-whitespace assistant fragment | **FAIL — not observed** | No child run started. |
| Settled compact block has exactly three sanitized lines | **FAIL — not observed** | No settlement occurred. |
| Final tail matches the Task 8 terminal response | **FAIL — not observed** | No authoritative settlement result existed. |
| Compact block exposes no path or session ID | **FAIL — not testable** | No live or settled compact block was rendered. |
| No child process remains | **PASS** | No child process was spawned by this attempt; post-attempt process inspection found no new child-mode Pi process. |
| No Runtime Store lease remains | **PASS** | Runtime Store schema 5 reported `No active lease.` |
| No raw prompt or transcript is in this proof | **PASS** | Only the safe marker and typed, sanitized assertions are recorded. |

## Cleanup

```yaml
childProcessRemaining: false
runtimeStoreLeaseActive: false
samplerRunning: false
cleanupPending: true
cleanupPendingReason: close only pane w23:p8H after the parent verification run consumes this proof
otherPanesAltered: false
```

Pane `w23:p8H` remains open as required. No other pane was closed or altered.

## Rerun requirement

Start a fresh Pi 0.83 npm-provenance pane with an absolute, no-symlink `XDG_DATA_HOME` and without `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE`. Then rerun only matrix item (a). Do not mark Task 20(a) complete from this proof.

## Remediation (recorded after this failure)

This section records the code change made in response to the failure above. It changes nothing about the result of this run, which remains **FAIL**. Task 20(a) is still not proven.

| Field | Value |
| --- | --- |
| Remediation commit | `fix(pi): canonicalize trusted xdg data roots` — `8b9dc84215d85d87bac4644f24cc3e0dc02260cd` |
| Blocker addressed | `thread-session-create-failed` caused by the symlinked `$HOME/.local` component |
| Scope | Base-path canonicalization only; no change to no-follow behaviour below the adapter root |

The trust boundary is now explicit. The configured base — `$XDG_DATA_HOME`, or `$HOME/.local/share` when unset — is canonicalized once with libc `realpath(3)`, so a user-owned symlinked base resolves to its real target. The canonical base must be absolute, a directory, owned by the current uid, and neither group- nor world-writable; a base whose unresolved components are symlinks (dangling or looping) is refused. The adapter-owned `weave/adapters/pi/sessions` components are appended only after that check, and everything at or below them is still opened with strict `openat(O_NOFOLLOW)`. Symlinked components inside the adapter root or inside a child directory remain rejected.

Rerun conditions are therefore relaxed in one respect only: a fresh pane no longer needs a symlink-free `XDG_DATA_HOME`. Every other rerun requirement above still stands, including the removal of `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` and a rebuilt npm-provenance artifact that contains the remediation commit.
