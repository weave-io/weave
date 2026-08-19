# Pi child-streaming remediation proof

Date of preserved live run: 2026-08-18

Evidence type: post-build Herdr RED reproduction

This record preserves the full live run for Task 10 as historical RED evidence.
Task 11 phase A records a separate exact-identity fresh-parent result below.
Weft and Warp remain separate required phases.

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

This historical section remains a bounded RED reproduction. It does not claim
that its four live lanes passed or that its loaded artifact was exactly matched.

## Task 11 phase A: exact-identity fresh-parent result

Date of fresh phase-A run: 2026-08-19

Evidence type: fresh Herdr Pi 0.84.2 run from the exact isolated subject.
The record is path-free and content-free. It contains no reasoning prose,
assistant text, tool command, tool result, credential, capture, transcript,
scrollback export, screenshot, raw event, or child payload.

### Exact identity

| Fact | Value |
| --- | --- |
| Git subject | `03f81a67a42d273a7b2be77482d9acd5ebb6eccb` |
| Git subject line | `chore: restore generated codesight metadata` |
| Git dirty | `false` |
| Source-input count | `143` |
| Source-input SHA-256 | `1c3ec920d11f2f09847dfacc1d349055c13da414a218039f2d02c11f3c07ce2c` |
| Build completion | `2026-08-19T06:23:20.408Z` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Build-manifest SHA-256 | `96ac5cb60d32a84428e2983040d703ac6678626c98296a942714a051c2b946b3` |
| Symlink target during proof | isolated worktree adapter for this subject |
| Symlink target after proof | original main-worktree adapter |
| Pi | `0.84.2`; package SHA-256 `820f4adc6d61f2cefbc29ce17e9dfd9aa482248d54be5d0dfa2a868ca000c7b0`; CLI SHA-256 `840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521` |
| pi-ai | `0.84.2`; package SHA-256 `9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9`; entry SHA-256 `2317a3ec8d3b0474e45d6c5cca04c71d3795c21bf83c08008c5a0869f9f33d95` |
| pi-tui | `0.84.2`; package SHA-256 `2c19fb7e3d1e83a461b6f020b2ffc118b435dcd78a07af8c8def72864cd09e6e`; entry SHA-256 `538865edfcda57a05a1886255700088458f03d47ab079e2dc4c66b6a65473fff` |
| Verifier source | SHA-256 `ce6dba2e59c2bdd54252119236f9ee385054b95786be806d3d7af52bc94b3cf5`; subject `c77389ed75e3b282543ccba0df4d164d8fde6b0a` |

Built adapter output digests:

| Output | SHA-256 |
| --- | --- |
| `cli` | `9d39ca336f49291f24964e5de2a3890d9c0410cc9ca48736de00fcecac1a418a` |
| `cli-declarations` | `5984be53878a216ed0a054094be409679635219c00519c70e86b6c853369b9e8` |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| `extension-build-identity` | `cdae357c6587a31da95e39f94aa8ab57dfafc7af8ea37799dfec4a9d27c6feb5` |
| `extension-declarations` | `3373de113af5f106448d6adc21b21632a7995da0db9b2af6fb641cac942fe009` |
| `extension-impl` | `1d974e3dc9d9163612c5907045758b7aca5a5f2ca8fe40e0a55e29d027d0e09d` |
| `extension-impl-declarations` | `c28e0fb53ecc84db00c9bed4a041e9d939ed8288ab564c561ac9917b3ea4a768` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |
| `index` | `309ef88db8045507237db8175380f605f663d45db4b7956620d15e2986fcf02b` |
| `index-declarations` | `09fc2c4f8efee717238eb0c855384d340ffe56822e607c9c49a32f1fb07bf44d` |

### Identity controls and fresh-parent gate

| Control | Result | Bounded observation |
| --- | --- | --- |
| Build A loaded | PASS | Initial extension digest was recorded before replacement. |
| Build B on disk | PASS | Loaded state classified `stale-on-disk`; disk and manifest digests differed from A. |
| Corrupt manifest | PASS | State classified `unverifiable`; reason was `manifest-malformed`. |
| Corrupt output | PASS | State classified `stale-on-disk`; output digest changed. |
| `/reload` adoption | PASS | Restored B was classified `current` after reload. |
| Control process exit | PASS | No control Pi process remained before the fresh parent. |
| Fresh-parent verifier gate | PASS | Independent verifier reported `current`; no UI conclusion was made before that gate. |
| Fresh parent after build | PASS | Parent started after the final build and loaded the isolated subject. |

### Fresh live lanes

The final fresh parent delegated one `shuttle-mini` task. The child produced
real generic Pi thinking, one bash tool call, and a settled assistant reply.
The live TUI was the only reasoning observation surface. The verifier and proof
record retained only counts and closed statuses.

| Lane | Status | Bounded live observation |
| --- | --- | --- |
| Parent raw reasoning live | **FAIL** | Required `↪ reasoning • <bounded nonblank text>` activity was not observed; the settled card showed assistant activity instead. |
| Inspector raw reasoning live | **FAIL** | Required exact prefix was observed zero times in the live inspector sample; no live bounded reasoning row was established. |
| Inspector tool details | **PASS** | One correlated bash start row and one bounded result row were observed; duplicate terminal rows: `0`. Command and result were present but are intentionally omitted. |
| Inspector assistant reply live | **FAIL** | Required `shuttle · streaming reply` with growing indented text was not observed before settlement; only the settled reply was observed. |

Live counts were content-free: reasoning-prefix maximum `0`, bash start rows
`1`, bash result rows `1`, duplicate terminal rows `0`, streaming-header
observations `0`, and pre-settlement assistant-growth observations `0`.
The four lanes are independent. The one passing tool lane does not waive the
three failed UI lanes.

### Persistence, sink isolation, and host boundary

| Surface | Result | Structural observation |
| --- | --- | --- |
| Parent Pi session | PASS | `11` entries; `2` Weave child-ref custom entries; no forbidden raw-reasoning key. |
| Pi native child session | HOST BOUNDARY | `10` entries, including one thinking block and content-free thread/result custom records. Weave did not copy this host-managed content into evidence. |
| Runtime Store | PASS | `10` tables; `0` active leases; `0` workflow instances; no reasoning/thinking/raw/payload columns. |
| Logs | PASS | TUI write log disabled with `/dev/null`; no proof log was written. |
| Fixtures and proof report | PASS | Capture/replay were content-free; proof absolute-path count is `0`. |
| Settled result | PASS | Parent session contains one authoritative `toolResult`; no second settled result was created. |
| Card isolation | **FAIL** | The settled parent card visibly rendered the child answer, so the strict reasoning-only activity contract was not established. |
| Transient registry release | NOT PROVEN | The proof pane closed cleanly, but the live registry and inspector buffer do not expose an external post-process count. |

The native child session is the host persistence boundary. Its native thinking
block is not Weave-owned durable reasoning. No raw reasoning was copied into a
Weave Runtime Store record, checkpoint, diagnostic, log, fixture, parent model
input, parent message, card detail, or proof field.

### Validation matrix

| Gate | Result |
| --- | --- |
| Focused Task 9 tests | PASS — `872` tests, `0` failures, `27645` expectations, `19` files |
| Script tests | PASS — `34` tests, `0` failures, `178` expectations, `3` files |
| Full Pi suite | PASS — `4196` tests, `0` failures, `879716` expectations, `178` files |
| `bun run typecheck` | PASS — `0` errors; existing docs deprecation hints only |
| `bun run lint` | PASS — exit `0`; `350` warnings and `67` infos; declaration validation passed |
| `bun run build` | PASS — packages and docs completed; existing Astro deprecation warning only |
| `bun run validate-config` | PASS — project config valid |
| `bun run docs:check-links` | PASS |
| `weave runtime status` | PASS — no active lease; `0` workflow instances; schema `6` |
| Content-free capture | PASS — `47` events; independent manifest |
| Content-free replay and red controls | PASS — `5` red controls; `4` lanes |

### Cleanup and restoration

| Resource | Result | Evidence |
| --- | --- | --- |
| Child process | PASS | No process matched the proof temp root after close. |
| Temporary provider/workspace | PASS | Temporary proof root was removed; no temp child session remained. |
| Proof Herdr pane | PASS | Every proof pane was closed; no proof pane remained in the workspace. |
| Runtime lease | PASS | Final runtime status reported no active lease. |
| Adapter symlink | PASS | Restored to the original main-worktree adapter target. |
| Pi launcher | PASS | Restored SHA-256 `c7649907a34aea371063932324a613a6fb2add4cd1ed01d50c7b54807d596d6a`. |
| Global config | **FAIL** | Recorded pre-proof SHA-256 was `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; reconstructed post-proof SHA-256 is `ce6959f1c87bc2303ae17f95131c26ba4295bb71d683840ba05ba05bfdeab670`. Exact-byte restoration could not be re-proven after the temporary backup was removed during failed proof retries. |

Task 11 is not marked complete. Weft and Warp are pending. The live proof has
an identity-green subject and a passing tool-detail lane, but it is not a
four-lane green proof.
