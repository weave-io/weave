# Pi child-streaming remediation proof

Date of preserved live run: 2026-08-18

Evidence type: post-build Herdr RED reproduction

This record preserves the full live run for Task 10. It is not a final green
proof. Task 11 must replace the four live lane results after the exact-identity
fresh-parent proof.

## Contract under test

The user-approved Pi `0.84.2` contract uses generic
`thinking_start` / `thinking_delta` / `thinking_end` events as the live raw
reasoning source. Both surfaces render the exact format
`↪ reasoning • <text>`.

The parent `weave_delegate` card has one live child-activity row: the bounded
raw-reasoning row. It hides child assistant output, tool names and status,
arguments, results, stdout, stderr, and inspector payload. The settled tool API
still returns authoritative child output, but the custom card does not render
that output as activity.

The focused inspector shows the same raw-reasoning row, bounded sanitized
correlated tool rows, and the live assistant reply. One tool call updates one
row. Raw reasoning uses at most one 4 KiB UTF-8 buffer per active surface. The
parent view is one line of at most 240 code points with 100 ms repaint
coalescing. The inspector view is at most three rows with 50 ms repaint
coalescing. Terminal-control normalization is the only reasoning-text filter.
Non-empty omitted text ends with `… [truncated]`; non-printable non-empty input
uses `[unprintable reasoning]`; a blank reasoning row is never valid.

Raw reasoning exists only in bounded process-memory UI projections. It never
enters parent messages or model input, tool-result `content`, persisted card
`details`, Runtime Store records, checkpoints, transcript/replay/search state,
logs, diagnostics, artifacts, reports, or files. Pi's host-managed native child
session may persist it under Pi's rules. That host behavior is outside the
Weave persistence boundary; Weave does not duplicate it. Both buffers release
at settlement, disposal, inspector close, focus change, generation replacement,
component disposal, and session shutdown. A historical reopen starts empty.

## Identity gate

A final live assertion requires independent agreement among:

- source-input SHA-256 and Git subject/dirty state;
- every built adapter output SHA-256;
- the path-free sidecar build manifest and its output digests;
- the loaded extension artifact digest and load time;
- the on-disk artifact digest; and
- the parent process start time.

The verifier reports only the closed identity states `current`,
`stale-on-disk`, `manifest-mismatch`, and `unverifiable`. Modification time is
ordering evidence, not identity. The required controls are build A loaded with
build B on disk, a corrupt sidecar or output, `/reload` adopting B, and a new
parent after the final artifact exists.

The preserved 2026-08-18 run started after the adapter build, but this record
does not contain an independently matched source-input digest, built-output
digest, loaded-output digest, load time, and process start time. Startup order
alone cannot establish exact identity. Therefore this run cannot support a
final live UI conclusion.

## Pi 0.84.2 fixture and diagnostics

The authoritative fixture is captured through real Pi `0.84.2`
session/RPC/extension machinery at the public event boundary. It preserves
generic thinking lifecycle shape, own enumerable field names, value kinds,
ordering, lifecycle phases, tool correlation, bounded sanitized tool data, and
incremental assistant ordering. Thinking text is omitted online before any
fixture or manifest write. The fixture keeps only content-free structure,
saturated byte/line counts, and truncation state. In-memory replay may inject a
controlled reasoning string for UI assertions.

No fixture, manifest, report, snapshot, failure output, screenshot, terminal
capture, or proof field contains observed reasoning prose, a reasoning prefix or
suffix, a hash or encoding derived from it, credentials, uncontrolled child
output, or an absolute path. Diagnostics are content-free aggregates: closed
stage/reason codes, saturated counts, and bounded times. They contain no
reasoning, assistant text, tool payload, prompt, credential, path, exception
text, or content-derived digest.

Deterministic Task 9 parser, projector, controller, card, inspector,
sink-isolation, lifecycle-release, and red-control test gates pass. Those test
gates are separate evidence. They are not fresh Herdr lane results and do not
change the live run below.

The Task 9 context anchors are identity `845557f8`, capture `c77389ed`,
diagnostics `d2b2d50a` / `d8c446ca`, reasoning `f0a4a10d` / `a066752d`, parent
card `ea87a49e` / `0e5ebb38`, assistant `1aff1989`, and tools `09fb0dfa`.
These anchors identify deterministic work only; they do not establish a fresh
Herdr result.

## Preserved Herdr sequence

The run used a new Pi parent in a Herdr pane and delegated exactly one
`shuttle-mini` task after the artifact build.

1. The parent card showed `▸ shuttle-mini is writing`, then `⏵ bash · running`.
   It did not show live raw reasoning.
2. `Alt+I` opened the picker. Enter selected the active child.
3. The live inspector showed an empty `✻ reasoning` row and
   `⚙ bash(timeout: 55)` with `⎿ running`; the command was absent.
4. Completion added separate bash `running` and `done` rows. The command and
   stdout/result detail remained absent.
5. At `live streaming reply`, the inspector showed
   `● shuttle-mini · streaming reply` with only a cursor. About two seconds
   later it changed to a final response. No incremental assistant body was
   visible before settlement.
6. The final parent card rendered the child assistant answer. This is not the
   required parent child-activity projection.
7. Cleanup succeeded: `weave runtime status` reported no active lease, and the
   Herdr pane created for the run was closed.

No observed reasoning prose was copied from the live TUI into this record.
TUI write logs, pane captures, screenshots, terminal transcripts, and scrollback
exports are not proof inputs.

The product reversal explains the empty `✻ reasoning` row only. It does not
explain the missing bash command/result detail or the blank incremental
assistant body. Those remain separate event-projection, correlation, and
reducer defects.

## Four live proof lanes

Each lane is evaluated independently. These are the only live lane statuses in
this record.

| Lane | Status | Observation |
| --- | --- | --- |
| Parent raw reasoning live | **FAIL** | The card showed legacy activity and never showed the required live raw-reasoning row. |
| Inspector raw reasoning live | **FAIL** | The focused inspector showed an empty reasoning row, not bounded live text. |
| Inspector tool details | **FAIL** | The bash call had a timeout-only start row, then duplicate running/done rows without command or result detail. |
| Inspector assistant reply live | **FAIL** | The streaming assistant row had only a cursor; text appeared only as a final response after the live interval. |

The four lanes are independent. The product reversal does not waive the tool or
assistant lanes, and the tool or assistant defects do not justify putting raw
reasoning in a durable or model-visible sink.

## Persistence and lifecycle controls

The required negative boundary is explicit:

- only the live parent-card and focused-inspector process-memory projections may
  contain a controlled reasoning sentinel while their registries are live;
- parent card facts, partial tool updates, `content`, `details`, parent
  messages, Runtime Store, checkpoints, transcript/replay/search state,
  diagnostics, logs, fixtures, reports, artifacts, and files must remain
  content-free;
- the settled `weave_delegate` result may carry authoritative child output, but
  the custom card must not display it as child activity;
- settlement, close, focus change, generation replacement, disposal, and session
  shutdown must clear the corresponding buffer and registry; and
- a late update after any lifecycle edge must be a bounded content-free drop and
  must not recreate the buffer.

Task 11 must rerun these controls after the exact-identity gate and record the
registry sizes, retained-byte counts, lease/process cleanup, and closed Herdr
pane without recording raw reasoning.

## Historical context and limitation

The completed plan
[`.weave/plans/pi-child-overlay-ux-feedback.md`](../../../../.weave/plans/pi-child-overlay-ux-feedback.md)
is historical context only and was not edited for this remediation. The
normative reversal is recorded in [the UI design
record](../33-weave-ui-design.md), [Spec 33](../33-spec-pi-adapter.md), and the
adapter verification guide. The current contract needs no separate provenance
predicate, derived-summary UI, additional planning document, host change, or
lane hold.

This record is complete only as a bounded RED reproduction. It does not claim
that the four live lanes passed, that the loaded artifact was exactly matched,
or that the current implementation has repaired the missing tool and assistant
projections.
