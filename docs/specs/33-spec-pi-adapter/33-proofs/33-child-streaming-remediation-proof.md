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

## Task 11 remediation: exact-identity fresh green lanes

Date of remediation run: 2026-08-19

Evidence type: fresh Herdr Pi `0.84.2` run after the remediation build. This
append-only section does not revise either earlier RED record. It contains only
bounded counts, statuses, and digests. It contains no reasoning text, assistant
text, tool payload, prompt, credential, screenshot, scrollback, transcript, or
config contents.

### Exact identity and controls

| Fact | Bounded value |
| --- | --- |
| Git subject | `ed0986889b18dd43e8c38248254981f9a34dec07` |
| Git dirty | `false` |
| Source-input count | `143` |
| Build completion | `2026-08-19T13:20:21.969Z` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Build-manifest SHA-256 | `6b4ad65ff5ae459f31b7b2cf7eddd4a04092089af0ef8a10fdfc504cee6a4e96` |
| Pi | `0.84.2`; package SHA-256 `820f4adc6d61f2cefbc29ce17e9dfd9aa482248d54be5d0dfa2a868ca000c7b0` |
| pi-ai | `0.84.2`; package SHA-256 `9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9` |
| pi-tui | `0.84.2`; package SHA-256 `2c19fb7e3d1e83a461b6f020b2ffc118b435dcd78a07af8c8def72864cd09e6e` |
| Independent verifier | **PASS** — `current`; child streaming permitted |

Built adapter output digests:

| Output | SHA-256 |
| --- | --- |
| `cli` | `9d39ca336f49291f24964e5de2a3890d9c0410cc9ca48736de00fcecac1a418a` |
| `cli-declarations` | `5984be53878a216ed0a054094be409679635219c00519c70e86b6c853369b9e8` |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| `extension-build-identity` | `cdae357c6587a31da95e39f94aa8ab57dfafc7af8ea37799dfec4a9d27c6feb5` |
| `extension-declarations` | `3373de113af5f106448d6adc21b21632a7995da0db9b2af6fb641cac942fe009` |
| `extension-impl` | `bfa80249dddb5bd61caab3efdba8314de4a60e5687a127cd1b3fb91cf6298a5c` |
| `extension-impl-declarations` | `a621a0bb2212fcd1b57ac8d4ce78350bea5017920812a6431c8adf11ff3c4c9c` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |
| `index` | `58fd868f3944805c4ce2bf8e018b5c7e66610e2104ed856bab5b2b69237ea41b` |
| `index-declarations` | `f92b2bf8b4eb0bfa8cf7991ed31b2a6cf6d8bfc77846ee513dc1d02cef4c2cf7` |

The proof loaded build A, replaced only ignored on-disk adapter outputs with a
second digest, and observed **PASS** for `stale-on-disk`. `/reload` adopted the
second digest and observed **PASS** for `current`. The control process exited
before the fresh parent started. The final parent started after build A was
restored and the independent identity gate was current.

The recovered global configuration was validated before the proof and restored
after it to SHA-256
`734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75` with mode
`0644`. A mode-`0600` exact backup remained available through the proof and
matched the same digest. The adapter symlink and launcher were restored to their
pre-proof identities.

### Fresh live lanes

The fresh parent delegated exactly one bounded `shuttle-mini` child. The child
ran one bounded tool call and then streamed a long response so the pre-settlement
assistant projection could be sampled twice. The live TUI was the only reasoning
observation surface.

| Lane | Status | Content-free observation |
| --- | --- | --- |
| Parent raw reasoning live | **PASS** | Exact reasoning-prefix observations: `1`; parent card live activity remained reasoning-only. |
| Inspector raw reasoning live | **PASS** | Exact reasoning-prefix observations: `3`; one bounded live reasoning buffer. |
| Inspector tool details | **PASS** | Correlated tool starts: `1`; terminal results: `1`; duplicate terminal rows: `0`. |
| Inspector assistant reply live | **PASS** | Streaming-header observations: `1`; pre-settlement indented body samples: `2`; body growth: `1`. |

The settled parent card answer-leak predicate was **false**. The card contained
no child assistant or tool activity. The inspector remained read-only after
settlement and retained no live reasoning row.

### Sink isolation and cleanup counts

| Check | Status | Bounded result |
| --- | --- | --- |
| Parent card registry after settlement/close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Inspector reasoning registry after settlement/close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Parent card live activity | **PASS** | Reasoning-only; no child assistant/tool payload |
| Tool-result semantics | **PASS** | One authoritative settled result; no duplicate terminal result |
| Content-free capture | **PASS** | `47` events; independent manifest |
| Content-free replay and red controls | **PASS** | `5` red controls; `4` lanes |
| Durable Weave reasoning sinks | **PASS** | No parent input, message, card details, Runtime Store, checkpoint, replay, search, log, diagnostic, fixture, or proof content |
| Runtime Store after cleanup | **PASS** | No active lease; `0` workflow instances; schema `6` |
| Herdr proof pane/process | **PASS** | Fresh pane closed; no child or provider process remained |

The zero counts come from the bounded production-extension integration seam
that reads only registry sizes and retained byte totals. It does not expose
reasoning text, keys, IDs, or payloads. The host-managed native child session
remains the Pi persistence boundary; Weave did not duplicate its content.

### Remediation validation

| Gate | Result |
| --- | --- |
| Focused remediation suite | PASS — `477` tests, `0` failures, `23403` expectations, `8` files |
| Full Pi suite | PASS — `4198` tests, `0` failures, `879726` expectations, `178` files |
| Script tests | PASS — `52` tests, `0` failures, `205` expectations, `3` files |
| `bun run typecheck` | PASS — `0` errors; existing docs hints only |
| `bun run lint` | PASS — exit `0`; existing `350` warnings and `67` infos; declaration validation passed |
| `bun run build` | PASS — packages and docs completed; existing Astro warning only |
| Global and project config validation | PASS |
| `bun run docs:check-links` | PASS |
| Runtime status | PASS — no active lease and `0` workflow instances |

### Focused commits

The production wiring and deterministic evidence are split into these focused
Conventional Commits:

- `4ba81ed0` — `fix(pi): fan out structural reasoning starts`
- `6063e490` — `fix(pi): wire live reasoning cleanup state`
- `50aab65e` — `test(pi): prove exact-identity child streaming lanes`
- `ed098688` — `test(pi): update structural reasoning fanout bound`

The earlier exact-identity RED remains recorded under `695e15a2`, and the
historical 2026-08-18 RED remains unchanged above. Task 11 remains unchecked in
`.weave/plans/pi-child-streaming-remediation.md`. Weft and Warp were not run.

## Task 11 final exact-isolated proof

Date of final fresh run: 2026-08-19

The preceding remediation section is retained as an append-only historical
record. The run below is the authoritative final isolated proof. It does not
rewrite the 2026-08-18 RED or the first exact-identity RED under `695e15a2`.
This section contains only bounded identity values, counts, statuses, and
hashes. It contains no config contents, reasoning text, assistant text, tool
payload, prompt, credential, screenshot, scrollback, or transcript.

### Exact identity and controls

| Fact | Bounded value |
| --- | --- |
| Git subject used for the fresh parent | `450d1a6f0be10ec475e6e198ed7227b7933fbd89` |
| Git dirty | `false` |
| Source-input count | `143` |
| Build completion | `2026-08-19T14:12:18.899Z` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Build-manifest SHA-256 | `507768241745441a486ac950eeb40f94669776f9f156e9723278ab87574a2e4d` |
| Symlink during fresh proof | isolated worktree adapter |
| Pi | `0.84.2`; package SHA-256 `820f4adc6d61f2cefbc29ce17e9dfd9aa482248d54be5d0dfa2a868ca000c7b0` |
| pi-ai | `0.84.2`; package SHA-256 `9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9` |
| pi-tui | `0.84.2`; package SHA-256 `2c19fb7e3d1e83a461b6f020b2ffc118b435dcd78a07af8c8def72864cd09e6e` |
| Independent verifier | **PASS** — `current`; child streaming permitted |

The stale A/B control classified the loaded A against changed on-disk output
as **stale-on-disk**. The manifest and output corruption controls classified
as **unverifiable** and **stale-on-disk**. After restoration, `/reload`
adopted the replacement output and classified **current**. The control process
exited before the final fresh parent. The independent verifier passed before
the final delegation.

Built adapter output digests were content-free and bounded:

| Output | SHA-256 |
| --- | --- |
| `cli` | `9d39ca336f49291f24964e5de2a3890d9c0410cc9ca48736de00fcecac1a418a` |
| `cli-declarations` | `5984be53878a216ed0a054094be409679635219c00519c70e86b6c853369b9e8` |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| `extension-build-identity` | `cdae357c6587a31da95e39f94aa8ab57dfafc7af8ea37799dfec4a9d27c6feb5` |
| `extension-declarations` | `3373de113af5f106448d6adc21b21632a7995da0db9b2af6fb641cac942fe009` |
| `extension-impl` | `bfa80249dddb5bd61caab3efdba8314de4a60e5687a127cd1b3fb91cf6298a5c` |
| `extension-impl-declarations` | `a621a0bb2212fcd1b57ac8d4ce78350bea5017920812a6431c8adf11ff3c4c9c` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |
| `index` | `58fd868f3944805c4ce2bf8e018b5c7e66610e2104ed856bab5b2b69237ea41b` |
| `index-declarations` | `f92b2bf8b4eb0bfa8cf7991ed31b2a6cf6d8bfc77846ee513dc1d02cef4c2cf7` |

### Fresh live lanes

The fresh parent delegated exactly one `shuttle-mini` child. The live TUI was
the only reasoning observation surface. The child used one bounded tool call
and streamed a long assistant reply long enough for two pre-settlement
samples. All observations below are content-free counts.

| Lane | Status | Bounded observation |
| --- | --- | --- |
| Parent raw reasoning live | **PASS** | Exact `↪ reasoning •` prefix observations: `1`; live parent activity remained reasoning-only. |
| Inspector raw reasoning live | **PASS** | Exact prefix observations: `3`; one bounded live reasoning buffer. |
| Inspector tool details | **PASS** | Correlated tool starts: `1`; terminal results: `1`; duplicate terminal rows: `0`. |
| Inspector assistant reply live | **PASS** | Streaming-header observations: `1`; pre-settlement body samples: `2`; body growth: `1`. |

The settled parent card answer-leak predicate was **false**. The parent card
showed no child assistant or tool activity. The inspector became read-only
after settlement. Its final view retained no live reasoning row.

### Sink isolation, lifecycle release, and cleanup

| Check | Status | Bounded result |
| --- | --- | --- |
| Parent card registry after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Inspector reasoning registry after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Tool-result semantics | **PASS** | One authoritative settled result; duplicate terminal results: `0` |
| Content-free capture | **PASS** | `47` events; independent manifest |
| Content-free replay and red controls | **PASS** | `5` red controls; `4` lanes |
| Live diagnostics | **PASS** | Bounded content-free buffer `1096/8192` bytes; omitted `0`; no raw content retained. |
| Durable Weave reasoning sinks | **PASS** | No parent input, message, card details, Runtime Store, checkpoint, replay, log, diagnostic payload, fixture, or proof content. |
| Runtime Store after cleanup | **PASS** | No active lease; `0` workflow instances; schema `6` |
| Herdr proof pane and processes | **PASS** | Fresh pane closed; no child, provider, or proof process remained. |

The zero counts came from the bounded production-extension integration seam.
It exposes only registry sizes and retained byte totals. It does not expose
reasoning text, keys, IDs, or payloads. The host-managed native child session
remained the Pi persistence boundary.

### Restoration and validation

| Gate | Result |
| --- | --- |
| Exact global config restoration | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644` |
| Mode-0600 exact recovery backup | **PASS** — retained through proof; same SHA-256 |
| Global and project config validation | **PASS** |
| `bun run typecheck` | **PASS** — `0` errors |
| `bun run lint` | **PASS** — exit `0`; declaration validation passed |
| `bun run build` | **PASS** |
| `bun run validate-config` | **PASS** |
| `bun run docs:check-links` | **PASS** |
| Content-free capture/replay controls | **PASS** |
| Runtime status | **PASS** — no active lease; `0` workflow instances |
| Adapter symlink and launcher restoration | **PASS** — original main-worktree symlink and launcher SHA restored |

The earlier exact-identity RED remains under `695e15a2`, and the historical
2026-08-18 RED remains unchanged. Task 11 remains unchecked in
`.weave/plans/pi-child-streaming-remediation.md`. Weft and Warp were not run.

## Task 11 verification B: final fresh exact-identity proof (2026-08-20)

This append-only section is the authoritative fresh-parent proof for the clean
subject below. The earlier RED sections and all prior proof history remain
unchanged.

### Exact clean subject and runtime-loaded identity

| Fact | Bounded value |
| --- | --- |
| Clean Git subject | `4697989a7e00cfb06950ddf0799208985f1af42e` |
| Git dirty | `false` |
| Build input count | `149` |
| Build output count | `10` |
| Build completion | `2026-08-20T15:28:57.695Z` |
| Build-manifest SHA-256 | `4ff4e9557630029b6be6f54a2d99daedf25993013b61c96d49e264466a034ae0` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Pi host | `0.84.2` |
| Pi package SHA-256 | `820f4adc6d61f2cefbc29ce17e9dfd9aa482248d54be5d0dfa2a868ca000c7b0` |
| pi-ai package SHA-256 | `9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9` |
| pi-tui package SHA-256 | `2c19fb7e3d1e83a461b6f020b2ffc118b435dcd78a07af8c8def72864cd09e6e` |
| Identity gate before delegation | **PASS** — `current`; child streaming permitted |
| Fresh parent | **PASS** — started after build completion and the identity gate; no `/reload` |

The complete built output set was content-free and bounded:

| Output | SHA-256 |
| --- | --- |
| `cli` | `9d39ca336f49291f24964e5de2a3890d9c0410cc9ca48736de00fcecac1a418a` |
| `cli-declarations` | `5984be53878a216ed0a054094be409679635219c00519c70e86b6c853369b9e8` |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| `extension-build-identity` | `8a7d95ec596de94b6f25a1228262829c85e415199952a38d884b9ac7046c869d` |
| `extension-declarations` | `3373de113af5f106448d6adc21b21632a7995da0db9b2af6fb641cac942fe009` |
| `extension-impl` | `879ba382cc089ed937a1d0c564691ef91a9bbc9f5761852bdf9791afaf13127a` |
| `extension-impl-declarations` | `a2c71bac5b7b6604c6365b4ec47239e24e1687fbfc65398dadaacc0cc86d2b84` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |
| `index` | `a2e161a52596dd83e2e1e34559abbe08fb77f009289bc09fa796217c709e1319` |
| `index-declarations` | `e66c1ee54be87d7148428200f738b3454d15cee58b0c6e8a6857752a4b0f3fc8` |

The runtime-loaded output proof matched the complete runtime set before
delegation:

| Runtime-loaded output | SHA-256 |
| --- | --- |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| `extension-build-identity` | `8a7d95ec596de94b6f25a1228262829c85e415199952a38d884b9ac7046c869d` |
| `extension-impl` | `879ba382cc089ed937a1d0c564691ef91a9bbc9f5761852bdf9791afaf13127a` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |

The direct loaded-output proof and the independent identity verifier both
reported the same four runtime digests. `extension-impl` was included; a thin
entry-only identity was not accepted.

### Fresh live lanes

The fresh parent delegated exactly one deterministic `shuttle-mini` child.
The child emitted generic thinking, one real controlled bash call and its
result, and incremental assistant output. All observations below are
content-free counts.

| Lane | Status | Bounded observation |
| --- | --- | --- |
| Delegation cardinality | **PASS** | `shuttle-mini` children: `1`; no second delegation |
| Parent raw reasoning live | **PASS** | Exact `↪ reasoning •` prefix observations: `1`; parent child activity remained reasoning-only |
| Inspector raw reasoning live | **PASS** | The exact same prefix was observed live: `1`; one bounded reasoning entry |
| Inspector tool details | **PASS** | Correlated bash rows: `1`; terminal result rows: `1`; duplicate running/done terminal rows: `0` |
| Inspector assistant reply live | **PASS** | `shuttle · streaming reply` header observations: `1`; nonblank body samples before settlement: `2`; body growth: `1` |
| Inspector settlement | **PASS** | Read-only after settlement; no live reasoning row remained |

The settled parent card contained no child assistant, tool, or inspector
payload. The authoritative settled tool result occurred exactly once and was
not rendered as parent-card child activity.

### Sink isolation, diagnostics, and cleanup

| Check | Status | Bounded result |
| --- | --- | --- |
| Parent reasoning store after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Inspector reasoning store after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Durable Weave sinks | **PASS** | Parent input, message/model, card details/facts, Runtime Store, checkpoints, diagnostics, logs, fixtures, and proof objects contained no raw reasoning or prohibited child payload |
| Content-free diagnostics | **PASS** | Serialized bytes stayed within `8192`; omitted buckets: `0`; failure buckets invalidating proof: `0` |
| Content-free capture | **PASS** | `47` events; independent manifest |
| Content-free replay and red controls | **PASS** | `5` red controls; `4` lanes |
| Runtime Store | **PASS** | No active lease; `0` workflow instances; schema `6` |
| Runtime content scan | **PASS** | No raw reasoning or prohibited child payload matches |
| Processes and Herdr resource | **PASS** | No child, provider, or proof process; created proof pane closed; temporary proof workspace removed |

### Restoration and validation

| Gate | Result |
| --- | --- |
| Exact global config restoration | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644`; size `2857` |
| Mode-0600 exact recovery backup | **PASS** — retained through proof and verified before removal |
| Global and project config validation | **PASS** |
| Adapter symlink restoration | **PASS** — main-worktree adapter restored |
| Deterministic proof routing restoration | **PASS** — global routing and provider extension restored |
| `bun run build` | **PASS** |
| `bun run docs:check-links` | **PASS** |
| Content scans after update | **PASS** |

Task 11 remains unchecked in `.weave/plans/pi-child-streaming-remediation.md`.
Weft and Warp were not run.

## Task 11 final proof refresh: executable isolation RED (2026-08-20)

This append-only section records the final refresh for the exact clean subject
below. It is authoritative for this run. The executable live verifier blocked
acceptance, so this section does not claim a green Task 11 proof.

### Exact subject and identity gate

| Fact | Bounded result |
| --- | --- |
| Clean Git subject | `3f6f1980d988dca11af2256e9db200d55a4f0644` |
| Git dirty | `false` |
| Build inputs / outputs | `149 / 10` |
| Build completion | `2026-08-20T18:03:30.208Z` |
| Build-manifest SHA-256 | `9c33e6505a7dae551969284a2f02d470ce9785208c1d86b7327d08514a902e93` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Pi host | `0.84.2` |
| Identity before delegation | **PASS** — `current`; child streaming permitted |
| Fresh parent | **PASS** — started after the build; no reload |

### Executable live verifier

The documented `live` invocation ran against the real installed Pi host with
`--require-fresh-parent`, `--require-current-build`, the exact four-lane list,
`--content-free-report`, and `--no-screen-capture`.

| Gate | Bounded result |
| --- | --- |
| Command exit | **RED** — `1` |
| Evidence | `content-free` |
| Identity | `current / fresh` |
| Requested lanes | `4`; all `pass` |
| Isolation | **RED** — `violated` |
| Settlement | `settled` |
| Registry | `empty` |
| Diagnostics | `clean` |
| Cleanup | `complete` |
| Failure codes | `1: isolation-failed` |
| Report mode / bytes | `0600 / 717` |
| Content-free report SHA-256 | `aa93db9773ee6265a2bcd133a1078ff8211fa1fb75a5acf9e9f04e92d5b2fe65` |
| Events / dropped / repaints | `97 / 0 / 29` |
| Diagnostics / cleanup attempts | `0 / 4` |

The report remained within its declared bounds: depth `8`, keys `64`, array
length `8`, string bytes `128`, and total bytes `16384`.

### Fresh Herdr TUI proof

A new real Herdr parent started after the final build. It loaded Pi `0.84.2`
and ran without `/reload`.

| Observation | Bounded result |
| --- | --- |
| Deterministic children | **PASS** — exactly `1` |
| Inspector selection | **PASS** — selected while the child was `LIVE` |
| Parent reasoning surface | **PASS** — control-only activity; no blank active reasoning row |
| Inspector reasoning surface | **PASS** — reasoning status present |
| Correlated tool detail / result | **PASS** — `1 / 1`; duplicate terminal rows `0` |
| Assistant reply surface | **PASS** — live streaming state before settlement; nonblank settled reply |
| Settlement | **PASS** — one authoritative settlement; inspector became read-only |
| Parent card payload | **PASS** — no child assistant or tool payload |
| Herdr and process cleanup | **PASS** — created pane closed; child/provider/proof processes `0` |

The CLI report and terminal proof agreed on one child, one settlement, empty
registry state, complete cleanup, and content-free evidence. The live command's
four lane counts were `6 / 6 / 1 / 4` for parent reasoning, inspector
reasoning, tool detail, and assistant reply observations.

### Fixture, replay, tests, and gates

| Check | Bounded result |
| --- | --- |
| Identity / capture / replay | **PASS** — `current`; `47` events; `5` red controls; `4` lanes |
| Focused live/card tests | **PASS** — `167` tests; `0` failures; `9` files |
| Script suite | **PASS** — `127` tests; `0` failures; `9` files |
| Pi suite | **PASS** — `4,199` tests; `0` failures; `178` files |
| Full hook | **PASS** — `11,193` passed; `11` skipped; `0` failed; `371` files |
| Build / typecheck | **PASS** — build complete; typecheck `0` errors |
| Lint | **PASS** — `0` errors; `350` warnings; `67` infos |
| Documentation links | **PASS** |
| Config validation | **PASS** |

### Restoration and final cleanup

| Gate | Result |
| --- | --- |
| Exact global config | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644`; size `2857` |
| Exact Pi settings | **PASS** — SHA-256 `c887067f200cdd21e7a6a96c196021c5714deb2bf065ceb666d2d23be191722a`; mode `0644`; size `973` |
| Adapter symlink | **PASS** — canonical main-worktree target restored |
| Pi launcher | **PASS** — original SHA restored |
| Runtime Store | **PASS** — no active lease; `0` workflow instances |
| Proof workspace, report, and Herdr pane | **PASS** — removed or closed after verification |

Task 11 remains unchecked in `.weave/plans/pi-child-streaming-remediation.md`.
Weft and Warp were not run.

## Task 11 proof step C2: authoritative green Herdr proof (2026-08-20)

This append-only section is the authoritative C2 terminal proof for the clean
subject below. It preserves every earlier RED section. It contains only bounded
identity facts, counts, closed statuses, and restoration facts. It contains no
reasoning prose, assistant text, tool payload, prompt, credential, capture,
transcript, exception text, absolute path, or content-derived hash.

### C1 executable verifier immediately before C2

C1 ran at the exact clean subject with no source edits. Its owner-only report
was removed after verification.

| C1 gate | Result |
| --- | --- |
| Command exit | **PASS** — `0` |
| Requested lanes | **PASS** — `4/4` |
| Identity | **PASS** — current and fresh |
| Isolation | **PASS** — isolated |
| Settlement | **PASS** — one settlement |
| Registry | **PASS** — empty |
| Diagnostics | **PASS** — clean and content-free |
| Cleanup | **PASS** — complete |
| Report | **PASS** — content-free, mode `0600`, `699` bytes, removed |

C1 is the executable verifier result. C2 below is the independently observed
fresh Herdr TUI result; neither phase changed the source subject.

### Exact identity and fresh-parent gate

| Fact | Bounded value |
| --- | --- |
| Clean Git subject | `f6f06e04ab455b2af86ecee8dd3cf2b8e5673912` |
| Git dirty | `false` |
| Build input count | `149` |
| Build output count | `10` |
| Build completion | `2026-08-20T19:24:20.732Z` |
| Build-manifest SHA-256 | `3e9d939b55c26fb412c9a0fbe83b1f91f48e538e8c8e132e68dab9643e1fa929` |
| Extension artifact SHA-256 | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` |
| Pi host | `0.84.2` |
| Identity before delegation | **PASS** — `current`; loaded, disk, and manifest identity agreed |
| Fresh parent | **PASS** — started after build completion and the identity gate; no `/reload` |

The loaded runtime graph matched all four required runtime outputs. The health
surface reported the same subject, `dirty=false`, current identity, and Pi
`0.84.2` before delegation. The parent was not reused from a prior build.

### C2 fresh Herdr live lanes

The fresh parent used the deterministic proof provider and delegated exactly one
`shuttle-mini` child. The active child picker was opened with `Alt+I` and the
running child was selected with `Enter`. The bounded terminal observer retained
only structural counts.

| Lane | Status | Bounded observation |
| --- | --- | --- |
| Delegation cardinality | **PASS** | Exactly `1` child; no second delegation |
| Active inspector selection | **PASS** | One picker selection while the child was live |
| Parent raw reasoning live | **PASS** | Exact `↪ reasoning •` prefix observed live; parent activity remained reasoning-only |
| Inspector raw reasoning live | **PASS** | Exact `↪ reasoning •` prefix observed live in the focused inspector |
| Inspector tool details | **PASS** | One correlated bash row and one result; duplicate terminal rows: `0` |
| Inspector assistant reply live | **PASS** | Streaming header observed; nonblank body appeared and grew before settlement |
| Inspector settlement | **PASS** | Read-only after settlement; no live reasoning row remained |

The content-free lane counts were parent prefix `1`, inspector prefix `1`,
tool starts `1`, terminal results `1`, duplicate terminals `0`, streaming
headers `1`, pre-settlement assistant body samples `2`, and body growth `1`.
The settled parent card had no child assistant, tool, or inspector payload. The
single authoritative tool API settlement occurred exactly once.

### Sink isolation and lifecycle release

| Check | Status | Bounded result |
| --- | --- | --- |
| Parent card registry after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Inspector reasoning registry after settlement and close | **PASS** | `registryEntries=0`, `retainedBytes=0` |
| Parent card activity | **PASS** | Reasoning-only; no child assistant or tool activity |
| Tool-result semantics | **PASS** | One authoritative settlement; no duplicate terminal |
| Durable Weave sinks | **PASS** | No raw reasoning or child payload reached parent model/message or a Weave durable sink |
| Diagnostics | **PASS** | Content-free; no raw content retained |
| C1 isolation and registry result | **PASS** | Isolated with empty registries |

The host-managed native child session remained the Pi persistence boundary. The
adapter did not copy host content into the parent model, Weave Runtime Store,
card details, checkpoints, transcript, replay, search state, logs, diagnostics,
fixtures, or proof data.

### Cleanup, restoration, and validation

| Gate | Result |
| --- | --- |
| Child, provider, and proof processes | **PASS** — none remained |
| Runtime Store | **PASS** — no active lease; `0` workflow instances |
| Temporary provider, workspace, and report | **PASS** — removed |
| Herdr proof pane | **PASS** — created pane closed |
| Global config | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644`; size `2857` |
| Mode-0600 exact config backup | **PASS** — same bytes verified through proof, then removed |
| Pi settings | **PASS** — pre-proof bytes restored; mode `0644`; size `973` |
| Pi launcher | **PASS** — pre-proof bytes restored; mode `0755`; size `416` |
| Adapter symlink | **PASS** — pre-proof canonical target restored |
| Documentation links | **PASS** |
| Content scans | **PASS** — no raw reasoning, payload, capture, credential, exception, absolute path, or content-derived hash |

Task 11 remains unchecked. Weft and Warp remain pending. No prior RED section
was revised.

## Task 11 proof D3: final verifier timeout evidence and runtime-artifact continuity (2026-08-20)

This bounded final section records the D1 executable verifier at the exact
subject below. Earlier RED evidence and the authoritative C2 Herdr evidence
remain unchanged.

### Exact final verifier subject

| Fact | Bounded result |
| --- | --- |
| Final verifier subject | `c3282f905fd32680e2a13f1baf6031b15452eaca` |
| Subject status | **PASS** — clean and exact |
| D1 verifier | **PASS** — real executable run; no report content retained |
| D2 terminal proof | **NOT CLAIMED** — no new D2 terminal run succeeded |

### D1 executable red and green results

D1's silent-parent negative control was a real executable verifier run. It
closed on the bounded timeout, returned exit `1` within `31s`, completed
cleanup, and removed its bounded mode-`0600` report. This measured the
30-second parent deadline only; it provides no live child-silence evidence. The
closed timeout was the expected RED result; no terminal or UI result is
inferred from it. Child-silence behavior remains separate unit/integration test
evidence, not part of this live D1 control.

D1's positive executable verifier run returned exit `0`. It proved identity
`current` and `fresh`, all `4/4` requested lanes, isolation, one authoritative
settlement, an empty registry, clean content-free diagnostics, and complete
cleanup. Its bounded mode-`0600` report was removed after verification.

| D1 gate | Silent RED | Green |
| --- | --- | --- |
| Command exit | **PASS** — `1` | **PASS** — `0` |
| Timeout / identity | **PASS** — closed timeout; bounded `31s` | **PASS** — current and fresh |
| Proof lanes | **NOT APPLICABLE** — silent-parent negative control | **PASS** — `4/4` |
| Isolation | **NOT APPLICABLE** — silent-parent negative control | **PASS** — isolated |
| Settlement | **NOT APPLICABLE** — silent-parent negative control | **PASS** — one settlement |
| Registry | **NOT APPLICABLE** — silent-parent negative control | **PASS** — empty |
| Diagnostics | **PASS** — closed and content-free | **PASS** — clean and content-free |
| Cleanup | **PASS** — complete | **PASS** — complete |
| Bounded report | **PASS** — mode `0600`, removed | **PASS** — mode `0600`, removed |

Repeated additional fresh Herdr driver attempts are retained only as cleanup
facts: they produced no admissible UI evidence, are not green D2 results, and
all owned processes, sessions, temporary resources, and reports were cleaned.
No new D2 terminal run is claimed here.

### Runtime-artifact continuity from C2 to D1

Commit `c3282f90` changes only the live-proof verifier and its tests, plus
hook-required generated metadata. It does not change production adapter or
runtime source. Its changed live-proof modules are the port, system, runner,
their focused tests, and the live-proof fakes. The generated metadata is not a
runtime output.

The built Pi adapter runtime output set is byte-identical between the
authoritative C2 subject `f6f06e04ab455b2af86ecee8dd3cf2b8e5673912` and the D1
subject `c3282f905fd32680e2a13f1baf6031b15452eaca`. The bounded rebuild
comparison below covers every runtime-loaded output, not declarations or
package-only entries.

| Runtime-loaded output | C2 and D1 SHA-256 | Equality |
| --- | --- | --- |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` | **PASS** — byte-identical |
| `extension-build-identity` | `8a7d95ec596de94b6f25a1228262829c85e415199952a38d884b9ac7046c869d` | **PASS** — byte-identical |
| `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` | **PASS** — byte-identical |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` | **PASS** — byte-identical |

The four-output equality is backed by the C2 build identity and the D1
rebuild output set: `4/4` runtime outputs match. Therefore C2 remains the
terminal UI proof for this exact reviewed runtime artifact, while D1 is the
proof for the final verifier subject. No production adapter/runtime source or
runtime output changed between `f6f06e04` C2 and `c3282f90` D1.

### Current cleanup and restoration

| Gate | Result |
| --- | --- |
| Global config | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644`; size `2857` |
| Exact mode-`0600` config backup | **PASS** — live bytes matched before removal; backup removed |
| Adapter symlink | **PASS** — canonical target restored |
| Runtime Store | **PASS** — no active lease; `0` workflow instances |
| Owned processes, temporary proof resources, and reports | **PASS** — none remained |
| Content/path scans | **PASS** — proof remains content-free and path-free |
| Documentation links | **PASS** |

Task 11 remains unchecked in `.weave/plans/pi-child-streaming-remediation.md`.
The authoritative C2 Herdr evidence at the byte-identical runtime artifact
remains intact and unchanged. Weft and Warp remain pending.

## Task 11 post-Warp proof E3: pinned-runtime verifier and terminal-artifact continuity (2026-08-21)

This final append-only section records E1 for the exact subject below and the
post-Warp E2 terminal-evidence outcome. It does not revise any earlier RED
section or the authoritative C2 section. It contains only bounded identity
values, closed statuses, counts, and digests. It contains no reasoning prose,
assistant text, tool payload, prompt, credential, capture, transcript,
scrollback, screenshot, exception text, absolute path, or content-derived hash.

### Exact final subject and complete pinned runtime identity

| Fact | Bounded value |
| --- | --- |
| Final subject | `d4d3be762d05287925aafde8119e9cd6f669cbf4` |
| Git dirty | `false` |
| Build input count | `149` |
| Build output count | `10` |
| Build binding | `635788a942903eea3fc68688e148b19f46225c05b5cac6ffb7c5bf79fd0bdbff` |
| Build completion | `2026-08-20T23:54:00.050Z` |
| Build-manifest SHA-256 | `311fce3cb233cb85de0e90f88ca9177438ad6c197e1a81644299ae27d7361f6f` |
| Extension artifact SHA-256 | `2ef80dd525645433cad9907051e4c2f3bc83c61c6ca073cc68f425bc88eb5413` |
| Pi host | `0.84.2` |
| Pi package SHA-256 | `820f4adc6d61f2cefbc29ce17e9dfd9aa482248d54be5d0dfa2a868ca000c7b0` |
| Pi CLI SHA-256 | `840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521` |
| pi-ai package SHA-256 | `9575365ce609dca8e1fd4fa72471d55006e1e0f81310c0808f93abc4bc14bbf9` |
| pi-ai entry SHA-256 | `2317a3ec8d3b0474e45d6c5cca04c71d3795c21bf83c08008c5a0869f9f33d95` |
| pi-tui package SHA-256 | `2c19fb7e3d1e83a461b6f020b2ffc118b435dcd78a07af8c8def72864cd09e6e` |
| pi-tui entry SHA-256 | `538865edfcda57a05a1886255700088458f03d47ab079e2dc4c66b6a65473fff` |
| E1 identity verifier | **PASS** — `current`; command exit `0`; child streaming permitted |

The complete E1 built output graph was:

| Output | SHA-256 |
| --- | --- |
| `cli` | `9d39ca336f49291f24964e5de2a3890d9c0410cc9ca48736de00fcecac1a418a` |
| `cli-declarations` | `5984be53878a216ed0a054094be409679635219c00519c70e86b6c853369b9e8` |
| `extension` | `2ef80dd525645433cad9907051e4c2f3bc83c61c6ca073cc68f425bc88eb5413` |
| `extension-build-identity` | `af59484ac5d35fe99bd81a0c81cb6cfa82d28754ee238b2b63e68398ce9d76fe` |
| `extension-declarations` | `3373de113af5f106448d6adc21b21632a7995da0db9b2af6fb641cac942fe009` |
| `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| `extension-impl-declarations` | `9d0bc04746083de67d4a6cc54c6c9634f1a5439fa9ddf5bef0a5da581ca6d36a` |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` |
| `index` | `7c3dc0175c841616733304eeee8da525a9a7d9901a9db25be53a72047567afbc` |
| `index-declarations` | `efe4a81c7f88927567352edfb2f06fc827d6e8b84c32fa1f6b12abfdb0c2f481` |

The four outputs evaluated by the pinned loader were the same four outputs
checked by E1. The entry, identity helper, implementation, and host-loader
bytes all matched the current manifest before the fresh parent started.

### E1 executable verifier and adversarial controls

E1 used the real installed Pi `0.84.2` executable. It required a current build,
a fresh parent, all four lanes, a content-free report, and no screen capture.
The bounded report was mode `0600`, `699` bytes, and was removed after
verification.

| E1 gate | Bounded result |
| --- | --- |
| Command exit | **PASS** — `0` |
| Current identity | **PASS** — `current` |
| Fresh parent | **PASS** — `fresh`; started after the current identity gate |
| Requested lanes | **PASS** — `4/4` |
| Parent raw reasoning lane | **PASS** |
| Inspector raw reasoning lane | **PASS** |
| Inspector tool-details lane | **PASS** |
| Inspector assistant-reply lane | **PASS** |
| Isolation | **PASS** — `isolated` |
| Settlement | **PASS** — one authoritative settlement |
| Registry | **PASS** — empty; all registry and retained-byte counts `0` |
| Diagnostics | **PASS** — `clean` |
| Cleanup | **PASS** — `complete` |
| Failures | **PASS** — none |

The identity and swap controls were adversarial and fail-closed:

| Control | Bounded result |
| --- | --- |
| Build A loaded, build B on disk | **PASS** — `stale-on-disk`; later execution was refused |
| Implementation swapped while the thin entry stayed unchanged | **PASS** — `stale-on-disk`; later execution was refused |
| Valid sidecar with a wrong output digest | **PASS** — `manifest-mismatch`; later execution was refused |
| Missing, malformed, or stale sidecar/output/binding | **PASS** — `unverifiable`; later execution was refused |
| `/reload` adoption of build B | **PASS** — `current` only after B was loaded; reload was not fresh-parent proof |

The identity probe used exactly the explicit environment allowlist: `PATH`,
`BUN_INSTALL`, `VOLTA_HOME`, `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `TMP`, `TEMP`,
`LANG`, `LC_ALL`, and `WEAVE_PI_BUILD_IDENTITY_PROOF`. No ambient environment
was forwarded. Hostile names, sentinel values, and credential-shaped
accessors did not cross the boundary; required accessor reads remained `0`.

The silent-parent and stream-bound controls also failed closed:

| Control | Bounded result |
| --- | --- |
| Silent parent with no output | **PASS** — closed `timeout`; process terminated once and the iterator closed |
| Parent that yielded once and then went silent | **PASS** — closed `timeout`; late output was ignored |
| Newline-free stdout flood | **PASS** — closed `overflow` beyond the `64 KiB` line/undecoded bound |
| Newline-free stderr flood | **PASS** — closed `overflow` beyond the `64 KiB` line/undecoded bound |
| Multiline stdout, stderr, and mixed short-line flood | **PASS** — closed `overflow` beyond `256` queued lines per stream |
| Split multibyte line | **PASS** — bounded UTF-8 line remained intact |

Every overflow and timeout path terminated the owned process, closed its
iterator, observed late reader failures, and retained no output in the report.

### E1 full test and documentation gates

| Gate | Bounded result |
| --- | --- |
| Full Bun test suite | **PASS** — `11,233` passed; `11` skipped; `0` failed; `11,244` tests across `373` files; `902,638` expectations; `2` snapshots |
| Documentation links | **PASS** — `bun run docs:check-links` |
| Proof content scan | **PASS** — no raw reasoning, assistant text, tool payload, credential, exception text, or content-derived hash |
| Proof path scan | **PASS** — no absolute path |

### Post-Warp E2 Herdr evidence status

Three new Herdr driver attempts were made after Warp. They produced **no
admissible terminal evidence**. They are not E2 passes, and no terminal lane,
TUI status, or terminal rendering result is inferred from them. Their owned
processes, sessions, temporary resources, reports, and panes were cleaned.

| E2 fact | Bounded result |
| --- | --- |
| New Herdr attempts | `3` |
| Admissible terminal evidence | `0` |
| E2 passing attempts claimed | `0` |
| Cleanup | **PASS** — complete |

### Runtime-artifact continuity from authoritative C2 to E1

The authoritative C2 subject was
`f6f06e04ab455b2af86ecee8dd3cf2b8e5673912`. The comparison is limited to the
four runtime-loaded outputs. It does not treat declarations, package-only
entries, the new preloader, or the new verifier as terminal evidence.

| Runtime-loaded output | C2 SHA-256 | E1 SHA-256 | Result |
| --- | --- | --- | --- |
| `extension` | `b2e07958a856bc56288f97181eb1c5b1b46d88dc972faf7d93cb62daa193b74a` | `2ef80dd525645433cad9907051e4c2f3bc83c61c6ca073cc68f425bc88eb5413` | **CHANGED** |
| `extension-build-identity` | `8a7d95ec596de94b6f25a1228262829c85e415199952a38d884b9ac7046c869d` | `af59484ac5d35fe99bd81a0c81cb6cfa82d28754ee238b2b63e68398ce9d76fe` | **CHANGED** |
| `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` | **PASS** — byte-identical |
| `host-module-loader` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` | `fedc62ca7752a2c8460e66cf9c1660be6b44fe98d3402a46461bae7ed23f9356` | **PASS** — byte-identical |

Exactly two of the four runtime-loaded outputs changed: `extension` and
`extension-build-identity`. The TUI-behavior implementation payload
`extension-impl` is byte-identical to authoritative C2 at the exact digest
shown above. Therefore C2 is retained only as continuity evidence for terminal
rendering of that shared implementation payload. E1, not C2, proves the new
pinned preloader, the current complete runtime graph, the fresh installed Pi
identity, and the final executable verifier. No post-Warp E2 terminal result is
substituted for either proof.

### Final cleanup and restoration

| Gate | Bounded result |
| --- | --- |
| Global config | **PASS** — SHA-256 `734e649b5233e603363fbbd1f8096bd986bea2ae4641ba2a0ab63dedb02dfd75`; mode `0644`; size `2857` |
| Exact mode-`0600` config backup | **PASS** — live bytes matched the config before removal; backup then removed |
| Pi settings | **PASS** — SHA-256 `c887067f200cdd21e7a6a96c196021c5714deb2bf065ceb666d2d23be191722a`; mode `0644`; size `973` |
| Pi launcher | **PASS** — SHA-256 `c7649907a34aea371063932324a613a6fb2add4cd1ed01d50c7b54807d596d6a`; mode `0755`; size `416` |
| Adapter symlink | **PASS** — original canonical main-worktree target restored |
| Runtime Store | **PASS** — no active lease; `0` workflow instances; schema `6` |
| Child/provider/proof processes | **PASS** — none remained |
| Temporary proof resources and reports | **PASS** — none remained |
| Proof-owned Herdr panes | **PASS** — none remained |
| Documentation and content/path scans | **PASS** |

The previous authoritative C2 section remains unchanged. Task 11 remains
unchecked in `.weave/plans/pi-child-streaming-remediation.md`. The focused
proof update is the only intended source change for this record.

## Task 11 final all-remediation proof F2 (2026-08-21)

This append-only section records the verified F1 facts for subject
`03908522d1c7093eaf22cc3c7684f8e975a4cf40`. It preserves all earlier proof
history. It does not change the Task 11 plan checkbox. No new Herdr result is
claimed.

### F1 validation gates

| Gate | Bounded result |
| --- | --- |
| Focused tests | **PASS** — `144` |
| Pi test suite | **PASS** — `4213` |
| Repository test suite | **PASS** — `9713` |
| Build | **PASS** |
| Typecheck | **PASS** |
| Lint | **PASS** |
| Config validation | **PASS** |
| Documentation checks | **PASS** |

### Complete pinned identity and adversarial controls

| Control | Bounded result |
| --- | --- |
| Complete pinned runtime identity | **PASS** — `current` |
| Retained pinned counters | **PASS** — all `0` |
| Stale-runtime control | **PASS** — stale identity refused |
| Runtime-swap control | **PASS** — swapped implementation refused |
| Corrupt-identity control | **PASS** — corrupt or mismatched identity refused |
| Environment-boundary control | **PASS** — restricted environment proof passed |
| Silent-parent control | **PASS** — bounded timeout and cleanup passed |
| Overflow controls | **PASS** — bounded stream and queue controls passed |

### Real Pi executable live proof

The real Pi live proof is an executable result, not a new Herdr result.

| Gate | Bounded result |
| --- | --- |
| Real Pi live command | **PASS** — exit `0` |
| Requested lanes | **PASS** — `4/4` |
| Isolation | **PASS** — isolated |
| Settlement | **PASS** — one authoritative settlement |
| Registry | **PASS** — empty |
| Diagnostics | **PASS** — clean |
| Cleanup | **PASS** — clean and complete |
| Bounded report | **PASS** — mode `0600`, `699` bytes, removed |

### Runtime implementation digest and terminal-continuity boundary

| Digest fact | SHA-256 / result |
| --- | --- |
| Current built `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Authoritative C2 `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Equality | **PASS** — byte-identical |

The current built `extension-impl` is byte-identical to the authoritative C2
implementation payload. Terminal continuity is limited to that byte-identical
payload. This section makes no terminal-continuity claim for any other runtime
output, loader, or identity artifact. No new Herdr result is claimed.

### Resource cleanup and exact restoration

| Gate | Bounded result |
| --- | --- |
| Resources | **PASS** — no child, provider, proof, pane, lease, or temporary resource remained |
| Exact global config | **PASS** — original bytes restored; temporary mode-`0600` backup removed |
| Runtime Store | **PASS** — no active lease and no workflow instance remained |
| Reports | **PASS** — bounded report removed |
| Task 11 plan state | **UNCHANGED** — checkbox remains unchecked |

## Task 11 final all-remediation proof G2 (2026-08-21)

This append-only section records the final all-review remediation evidence for
subject `a466ddd3462328d889c1c37060d60bef00facd29`. It preserves every earlier
proof section and does not edit the Task 11 plan checkbox. G1b is an executable
real-Pi result; no new Herdr result is claimed.

### G1a review, validation, and bounded-control evidence

| Gate or control | Bounded result |
| --- | --- |
| Focused suite | **PASS** — `520` |
| Pi suite | **PASS** — `4213` |
| Repository suite | **PASS** — `9713` |
| Build | **PASS** |
| Typecheck | **PASS** |
| Lint | **PASS** |
| Config validation | **PASS** |
| Documentation checks | **PASS** |
| Affected-module review | **PASS** — `34` modules; maximum `999` lines per module |
| Pinned counters | **PASS** — all `0` |
| Late-spawn control | **PASS** |
| Dual-stream control | **PASS** |
| Capture/host shared runner control | **PASS** |
| Stale-runtime control | **PASS** |
| Runtime-swap control | **PASS** |
| Environment-boundary control | **PASS** |
| Silent-parent control | **PASS** |
| Flood controls | **PASS** |

### G1b real-Pi executable proof

The real installed Pi executable returned the bounded result below. This is
not a new Herdr observation or a terminal UI result.

| Gate | Bounded result |
| --- | --- |
| Real Pi command exit | **PASS** — `0` |
| Runtime identity | **PASS** — `current` |
| Parent freshness | **PASS** — `fresh` |
| Requested lanes | **PASS** — `4/4` |
| Isolation | **PASS** — `isolated` |
| Settlement | **PASS** — one authoritative settlement |
| Registry | **PASS** — empty |
| Diagnostics | **PASS** — clean and content-free |
| Cleanup | **PASS** — complete |
| Bounded report | **PASS** — mode `0600`, `699` bytes, removed |
| Resources | **PASS** — none remained |
| Exact global config | **PASS** — original bytes restored; mode `0644`; size `2857`; temporary mode-`0600` backup removed |

The real-Pi result also established that the four requested lanes passed under
the current, fresh, isolated run. No Herdr pane, terminal lane, or terminal
rendering result is inferred from it.

### Runtime implementation digest and terminal-continuity boundary

| Digest fact | SHA-256 / result |
| --- | --- |
| Current built `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Authoritative C2 `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Equality | **PASS** — byte-identical |

Terminal continuity is limited to the byte-identical `extension-impl`
implementation payload shown above. This section makes no continuity claim for
the extension entry, build-identity sidecar, host loader, preloader, verifier,
report, or any other runtime output or artifact. No new Herdr claim is made.

### Preservation, cleanup, and scan record

| Gate | Bounded result |
| --- | --- |
| Earlier proof history | **PRESERVED** — prior sections remain unchanged |
| Task 11 plan state | **UNCHANGED** — checkbox remains unchecked |
| Temporary config backup | **PASS** — verified against the restored config and removed |
| Documentation links | **PASS** — `bun run docs:check-links` |
| Content/path scans | **PASS** — no prohibited content or absolute path was retained |
| Resources and reports | **PASS** — no child, provider, proof, pane, lease, temporary resource, or report remained |

## Task 11 final proof I2 (2026-08-21)

This append-only section records the final proof for subject
`e46f68d5d3ea751bfd91d16295d87878a554ee41`. It preserves all earlier proof
history and leaves the Task 11 plan checkbox unchanged. I1a is bounded
validation evidence. I1b is an executable live result; no new Herdr result is
claimed.

### I1a validation and bounded-control gates

| Gate | Bounded result |
| --- | --- |
| Focused suite | **PASS** — `958` |
| Pi suite | **PASS** — `4230` |
| Repository suite | **PASS** — `11291`; `11` skipped |
| Build | **PASS** |
| Typecheck | **PASS** |
| Lint | **PASS** |
| Config validation | **PASS** |
| Documentation checks | **PASS** |
| Affected modules | **PASS** — maximum `793` lines in one affected module |
| Replay | **PASS** — `5` reds / `4` lanes |
| Runtime Store lease | **PASS** — none |

### I1b executable live proof

The live command returned the bounded results below. This is not a new Herdr
observation or a terminal UI result.

| Gate | Bounded result |
| --- | --- |
| Runtime identity | **PASS** — `current` |
| Live command exit | **PASS** — `0` |
| Requested lanes | **PASS** — `4/4` |
| Isolation | **PASS** — `isolated` |
| Settlement | **PASS** — one settlement |
| Registry | **PASS** — `0` |
| Diagnostics | **PASS** — `0` |
| Cleanup failures | **PASS** — `0` |
| Residual resources | **PASS** — `0` |
| Bounded report | **PASS** — mode `0600`, `699` bytes, removed |
| Restorations | **PASS** — `4/4` |

### Current runtime implementation and terminal-continuity boundary

| Digest fact | SHA-256 / result |
| --- | --- |
| Current built `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Authoritative C2 `extension-impl` | `2771dfff0d13587a2db4f6c85adab91084c5e770207227dbfea53f0d18f253ea` |
| Equality | **PASS** — byte-identical |

Terminal continuity is limited to the byte-identical `extension-impl`
implementation payload shown above. This section makes no continuity claim for
the extension entry, build-identity sidecar, host loader, preloader, verifier,
report, or any other runtime output or artifact. No new Herdr claim is made.

### Preservation, cleanup, and scan record

| Gate | Bounded result |
| --- | --- |
| Earlier proof history | **PRESERVED** — all earlier sections remain unchanged |
| Temporary config backup | **PASS** — bytes matched the restored config; mode `0600`; removed |
| Content/path scans | **PASS** — no prohibited content or absolute path was retained |
| Documentation links | **PASS** — `bun run docs:check-links` |
| Proof commit scope | **PASS** — proof record plus required metadata only |
| Task 11 plan state | **UNCHANGED** — checkbox remains unchecked |
