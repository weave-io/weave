# Task 20 proof records — current status index

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
| `33-task20-j-no-session-readonly-proof.md` | S056, S057 | S056 historical (delegation now fails closed earlier); S057 current for read-only surfaces |
| `33-task20-k-history-doctor-cli-proof.md` | S063, S064, S065, S066 | S063 and S064 current (read-only); S065 and S066 historical — `children delete` is a blocked route |
| `33-task20-l-resume-exclusion-proof.md` | S061 | Historical — needs a created child session |
| `33-task20-m-pi-vim-coexistence-proof.md` | S047, S049, S050 | S050 current (keybinding conflict reporting); S047 and S049 historical — need a child overlay |
| `33-task20-n-health-only-readonly-proof.md` | S057, S067 | Current — health-only reporting and descriptor-safe read-only surfaces |

## What still holds at the fail-closed head

The descriptor-safe read-only surfaces stay available and are still recorded as
passing: status, health, plan, inspect, `/weave:history`, `/weave:doctor`, and
`weave adapter pi children list` / `show`. Rows `S050`, `S057`, `S063`, `S064`,
and `S067` record read availability and health reporting only. None of them is
evidence that any mutation or spawn path works on this host.

## Supporting records

`33-child-inspection-proofs.md`, `33-task-20-isolated-pi-083-harness-setup.md`,
and `33-task-20-release-setup-proof.md` record harness setup and packaging
provenance rather than checklist rows. They remain accurate for the subjects
they name.

Re-running any historical row requires a host that proves
`descriptor-relative-native-session-io`.
