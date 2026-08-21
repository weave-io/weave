# Task 14 Pi 0.84.1 overlay and child-error live proof

Status: **PASS**

Date: 2026-08-13

This record closes Task 14 of
[the Pi child overlay UX feedback plan](../../../../.weave/plans/pi-child-overlay-ux-feedback.md).
It supersedes the preliminary `e991b1b` proof binding while retaining that
run's unaffected full overlay and provider-error matrix.

## Exact subject and artifact

| Field | Value |
| --- | --- |
| Subject | `4082fe81ea11cbf9a7c89dc34a4279064c6462e2` |
| Pi host | `@earendil-works/pi-coding-agent` `0.84.1` |
| Adapter | `@weaveio/weave-adapter-pi` `0.0.1` |
| Artifact | `/private/tmp/weave-task14-artifacts-4082fe8/weaveio-weave-adapter-pi-0.0.1-4082fe8-task14.tgz` |
| Artifact SHA-256 | `309fa5f876b5d39fd59897935b7b91dcfd6494ec8d9f6e25748f60b980b03ebc` |
| `dist/extension.js` SHA-256 | `5a205dd8cebc881f81fadd309144096e5049beb94f19d374160c8e7676ac2c6d` |
| `dist/index.js` SHA-256 | `7a90296d4dc01a2d8655cfaf8407cec9e1d2aefcc891ff0146699f66bed7fada` |
| Checklist | `33-smoke-checklist.md`, Version 6 |
| Attempt | 1 |

The package was built from a detached worktree at the exact subject. The final
isolated harness loaded it through strict `npm:@weaveio/weave-adapter-pi`
provenance. `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was unset.

## Gates

Final gate logs are under `/private/tmp/weave-task14-final-gates-3b38fa2/`.
The compatibility-only delta from `3b38fa2` to the exact subject `4082fe8`
changed the tested Pi version constant and its focused tests.

- `bun test`: 8,308 pass, 11 skip, 0 fail.
- `bun run typecheck`: pass.
- `bun run lint`: pass; Biome reported warnings and no errors.
- `bun run build` / `bun scripts/build-public-packages.ts`: pass.
- `bun run docs:check-links`: pass.
- Final compatibility and acceptance tests: 41 pass, 0 fail.
- Final affected Pi integration tests: 228 pass, 0 fail.
- Final deletion and native filesystem tests: 123 pass, 0 fail.

The affected integration set includes the regression that keeps an in-flight
workflow abortable after a typed review projection failure and releases its
lease, single-Escape overlay close without cancellation, and all non-confirm
`q` resolutions leaving the child running.

## Isolated harness

Final harness root:

```text
/private/tmp/weave-task14-pi0841-4082fe8
```

The harness used isolated Pi, XDG, session, and Runtime Store roots. It loaded
Pi 0.84.1, pi-vim, the exact packed adapter, and a deterministic local
OpenAI-compatible fixture. The launcher removed inherited parent-only
`PI_SESSION_FILE`, `PI_SESSION_ID`, `PI_INTERCOM_SESSION_ID`, `PI_MODEL`,
`PI_PROVIDER`, `PI_REASONING_LEVEL`, and `PI_CODING_AGENT`. Without this
sanitization, the nested proof Pi inherited the parent agent's session identity
and its child never became inspectable.

## Observed matrix

### Readiness and Pi-native sessions — PASS

The exact artifact reached `ready ◆ WEAVE · LOOM`. A final live child launch
used both host-native arguments:

```text
--session-dir /private/tmp/weave-task14-pi0841-4082fe8/data/weave/adapters/pi/sessions/<thread>
--session /private/tmp/weave-task14-pi0841-4082fe8/data/weave/adapters/pi/sessions/<thread>/<session>.jsonl
```

The Pi v3 JSONL contained the exact parent session ID and
`weave.child.thread` metadata. The child metadata database recorded the child
as running, run 1, not stale, and not tombstoned. Earlier Phase C evidence also
proved stream, settlement, same-thread continue, historical reopen, and
path-free closed readiness reasons.

### Overlay scrolling and editor coexistence — PASS

The Phase C real-PTY matrix observed all six scroll controls in legacy, Kitty
press/release, and SS3 forms. Release events did not repeat scrolling. The same
matrix proved pi-vim remained active, conflicting host keys remained host-owned,
and the mounted overlay did not replace Pi's editor component.

Evidence: `/private/tmp/weave-task14-phaseC-evidence/`.

### Escape and `q` cancellation — PASS

The exact-subject S073 rerun used:

```text
/private/tmp/weave-task14-final-evidence-4082fe8/q-escape-poll.exp
/private/tmp/weave-task14-final-evidence-4082fe8/q-escape-poll-raw.log
/private/tmp/weave-task14-final-evidence-4082fe8/q-escape-poll-text.txt
```

The picker showed a running Shuttle. The mounted overlay showed
`shuttle-668dfad9 · LIVE`, continued streamed output, and
`q cancels this child (confirm required) · Esc exits`. Empty-draft `q` opened
the confirmation. Expect matched `Keep running`. Escape dismissed the modal
and returned to the same live overlay. The overlay continued streaming, and the
metadata row remained `running`, run 1, not stale, and not tombstoned. Reopening
`q` showed the confirmation again. Raw evidence SHA-256:
`31ae248327643e102437634d3b9db0b0bcac1c6801fa72c9c0420d04fd1f7fa6`.

The earlier Phase C exact live matrix proved **Keep running**, explicit
**Cancel subtree**, non-empty draft `q`, and settled-child no-target behavior.
The final affected integration set independently proves every non-confirm
resolution, including modal dismissal, leaves the child running and explicit
cancellation uses the subtree cancellation authority.

One Escape also closed inspection without cancellation and did not fall through
to Pi. No double-Escape behavior remains.

### Telemetry, compact mode, and search — PASS

The live matrix showed authoritative provider, model, context, and token values.
Fields not reported by the host rendered as `—`; no value was guessed. Compact
and full views preserved viewport, draft, and search state. Host-owned
`Ctrl+O` remained host-owned and produced one bounded conflict notice.

### Sanitized provider errors — PASS

The live matrix exercised HTTP 429, 500, 504, and 418 failures. Full, compact,
historical, fallback, and same-thread surfaces showed bounded provider class,
status, and sanitized detail. Sentinel credentials and unsafe payload fields did
not appear. A later successful run cleared stale error state.

General transcript DLP for secret-shaped `toolCallId` values and credentials in
ordinary tool output was explicitly outside this plan's scope.

### Workflow abort and lease cleanup — PASS

Final-subject integration coverage proves the active workflow tracker is
published immediately after durable lease acquisition, before dispatch can
block. A typed `review_verdict` projection failure leaves the workflow visible
to `/weave:abort`; confirmed abort cancels it and releases the lease. Focused
workflow and extension tests passed 228/228.

### Production deletion — PASS

The live Phase C matrix proved confirmation, terminal-only deletion, tombstone
listing, and missing-session behavior. Final-subject security fixes add an
append-only `intent → completed` protocol, root-scoped cross-process advisory
locking, parent-directory sync before every unlink, partial-tail rejection, and
safe retry after a failed directory sync. Native deletion/filesystem tests
passed 123/123.

## Review verdicts

- Task 11 Pi-native session audit: Warp **APPROVE**, Weft **APPROVE**.
- Task 13 rendering review: Weft **APPROVE**.
- Final cumulative security review through `cedd1c1`: Warp **APPROVE**.
- Final deletion sync retry review through `3b38fa2`: Weft **APPROVE**.
- Task 14 evidence review initially rejected the missing exact-subject S073
  observation. The live `q-escape-poll` rerun above resolves that sole blocker.

## Cleanup

- `childSettlementMissingCount`: `0`. No `ChildSettlementMissing` event appeared
  in the exact-subject live evidence or final affected integration run.
- This proof did not create a Herdr pane. Therefore there was no created pane
  to close and no residual proof pane.
- No process whose command contained
  `/private/tmp/weave-task14-pi0841-4082fe8` remained after the final run.
- The project Runtime Store had no active execution lease from the RPC overlay
  scenario.
- Temporary resets affected only the isolated proof worktree and harness.
- Tracked `.weave/runtime/sessions` fixtures were restored before commit.
- The main checkout was not modified.

## Limitations

Historical evidence under `/private/tmp` is machine-local. It is sufficient for
this release record but is not a durable CI artifact. The final q-modal labels
were split by terminal redraw sequences in cleaned text; the state-driven Expect
script matched the complete `Keep running` label before sending Escape, and the
subsequent live overlay plus running metadata row provide the stable dismissal
observation.
