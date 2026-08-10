# Pi adapter proof records — current status index

Every file in this directory is a sanitized record of one live Pi run: digests,
counts, and outcomes, never prompts or transcripts. Each record stays valid for
the subject, artifact, and host recorded inside it.

## Why most records are historical

Pi `0.83.0` addresses native sessions by caller-supplied filesystem path, so
the adapter cannot prove that a session write lands inside host-owned storage.
The required capability `descriptor-relative-native-session-io` therefore
probes `unavailable` with reason `path-only-session-api`.

Commits `c24182f`, `50d59b4`, and `5af9f1b` make the adapter fail closed on
that gap. Every generation on this host enters health-only mode, and every
persistent session mutation and child spawn is rejected before any controller,
session service, filesystem, cache, execution lease, or child process call.

The Task 20 runs recorded here happened before those commits. A record that
needed a spawned child or a session mutation therefore documents behaviour that
the current head blocks. Those records are **historical**. They are not
evidence for the fail-closed head, and the rows they proved are `Pending` in
both smoke checklists.

## Index

| Proof record | Rows | Status at the fail-closed head |
| --- | --- | --- |
| `33-task-20-a-compact-live-settlement-proof.md` | S040, S041 | Historical — needs a spawned child |
| `33-task20-b-overlay-live-steer-followup.md` | S043, S044, S046 | Historical — needs a running child and steer/follow-up mutation |
| `33-task20-c-historical-restart-pagination-search-proof.md` | S045 | Historical — needs a previously spawned child |
| `33-task20-d-picker-navigation-proof.md` | S048, S049 | Historical — needs children of every status |
| `33-task20-e-double-escape-cancel-proof.md` | S051 | Historical — cancellation is a blocked route |
| `33-task20-f-retry-continue-frozen-block-proof.md` | S052, S053 | Historical — retry and continue are blocked routes |
| `33-task20-g-child-response-missing-retryable-proof.md` | S055 | Historical — needs a settled child |
| `33-task20-h-transition-stay-cancel-switch-proof.md` | S058 | Historical — needs descendant cancellation and settlement writes |
| `33-task20-i-fork-clone-origin-exclusion-proof.md` | S059 | Historical — needs prior-session child data |
| `33-task20-j-no-session-readonly-proof.md` | S056, S057 | Historical — pre-`c24182f` behaviour, including its then-passing mutation and delegation rows; S057 is now recorded by the Task 21 record |
| `33-task20-k-history-doctor-cli-proof.md` | S063, S064, S065, S066 | Historical — pre-`c24182f` behaviour, including its then-passing `children delete` mutation rows; S063 and S064 are now recorded by the Task 21 record |
| `33-task20-l-resume-exclusion-proof.md` | S061 | Historical — needs a created child session |
| `33-task20-m-pi-vim-coexistence-proof.md` | S047, S049, S050 | S050 current (keybinding conflict reporting); S047 and S049 historical — need a child overlay |
| `33-task20-n-health-only-readonly-proof.md` | S057, S067 | Historical — pre-`c24182f` behaviour under a reversible injected capability failure, including its then-passing mutation-rejection rows; S057 and S067 are now recorded by the Task 21 record |
| `33-task21-final-head-fail-closed-proof.md` | S057, S063, S064, S067 | **Current** — the only record bound to the final fail-closed head `9a8c646` |
| `33-true-overlay-owned-editor-proof.md` | S043, S044, S046, S047 | **Current local-development proof** — Task 10 passed; S044 and S046 pass, while S043 and S047 retain noted gaps |

## What still holds at the fail-closed head

The descriptor-safe read-only surfaces stay available and are still recorded as
passing: status, health, plan, inspect, `/weave:history`, `/weave:doctor`, and
`weave adapter pi children list` / `show`. Rows `S050`, `S057`, `S063`, `S064`,
and `S067` record read availability and health reporting only. None of them is
evidence that any mutation or spawn path works on this host.

`33-task21-final-head-fail-closed-proof.md` is the current record for `S057`,
`S063`, `S064`, and `S067`. It re-ran those four rows live against exact source
`9a8c64683f3e159a587119ee045dc60ae5a62e86` on Pi `0.83.0` and also recorded the
fail-closed rejection of `weave_delegate`, `/weave:run`, `/weave:start`, and
`children.delete`, plus pristine non-creating startup, non-creating production
CLI reads, bounded and fail-closed native-session reads, explicit title
provenance, and an inert interrupted legacy ref. It supersedes its own earlier
`43ebc13` and `b0997de` bindings and every intermediate artifact run between
them. `S050` is still recorded by
`33-task20-m-pi-vim-coexistence-proof.md`.

## Supporting records

`33-child-inspection-proofs.md`, `33-task-20-isolated-pi-083-harness-setup.md`,
and `33-task-20-release-setup-proof.md` record harness setup and packaging
provenance rather than checklist rows. They remain accurate for the subjects
they name.

Re-running any historical row requires a host that proves
`descriptor-relative-native-session-io`.
