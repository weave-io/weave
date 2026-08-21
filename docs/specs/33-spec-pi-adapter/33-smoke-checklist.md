# Pi child-session smoke checklist

Version: 8

This checklist covers the acceptance surfaces defined in
[Spec 33](33-spec-pi-adapter.md) and the geometry, drop order, and honesty rules
fixed by the [Weave UI design record](33-weave-ui-design.md). Runtime model
fallback rows are `Pending` until a real-harness Pi `0.84.2` run records the
required sanitized facts. Rows explicitly marked historical/native-session may
retain Pi `0.84.1` evidence; that evidence does not prove runtime fallback.
Every live row runs in a fresh Herdr pane that the test creates and closes, with
isolated Pi config, data, session, and project roots. The driver records the
exact subject, artifact and dist hashes, package provenance, Pi version,
commands, observations, and cleanup.
[Spec 33](33-spec-pi-adapter.md) and the geometry, drop order, honesty rules,
and raw-reasoning contract fixed by the [Weave UI design record](33-weave-ui-design.md).
Every live row runs in a fresh Herdr pane that the test creates and closes, with
isolated Pi config, data, session, and project roots. The driver records the
exact subject, source-input and artifact digests, path-free build manifest,
loaded artifact and process identity, package provenance, Pi version, commands,
observations, and cleanup.

Pi `0.84.2` is the required live target. Earlier redesign proof records remain
historical evidence for geometry and unrelated controls only. They do not prove
the user-approved raw-live-reasoning contract, and no fresh green Herdr proof
exists for that contract in this checklist. The full 2026-08-18 run is
preserved as a RED reproduction in
[`33-child-streaming-remediation-proof.md`](33-proofs/33-child-streaming-remediation-proof.md).

## Optional runtime model fallback (Pi 0.84.2)

This section is the current live target for the optional
`runtime-model-fallback` host surface. The implementation targets Pi `0.84.2`'s
public surfaces, and Task 15 is the exact real-host proof target. Until Task 15
passes, Pi `0.84.2` is not a proven fallback host. The support floor remains
`0.81.1`. A missing or unproven optional surface must leave health ready and use
legacy visible and child settlement. The release harness records bounded facts
in its ephemeral report; this checklist does not create a standalone proof file.

Run the exact packed adapter in a fresh Pi `0.84.2` TUI with isolated config,
data, session, and project roots. Use a deterministic provider fixture that
produces one terminal provider failure after Pi's native retry, overflow, and
queued-message recovery paths have had control. Observe these facts without
recording raw provider bodies, failed assistant content, credentials, or marker
tokens:

| ID | Required observation | Result |
|---|---|---|
| RF01 | Pi emits `message_end`, then payloadless `agent_settled`; Weave keeps the visible child/tool/session pending, applies the next candidate, and starts a second low-level run in the same process and native session. | Pending |
| RF02 | Recovery does not use `before_agent_start`; exact `message_start` for `weave.model-fallback.recovery-marker` proves dispatch, and missing proof reaches the bounded timeout. | Pending |
| RF03 | The provider-only context list removes only the fingerprinted failed assistant and its exact marker. Durable native history retains both; no synthetic provider user message exists; successful output is a separate assistant entry. | Pending |
| RF04 | Manual model selection latches fallback off until explicit Weave activation; candidates stay ordered, distinct, and bounded; catalog/auth misses skip locally; overflow advances only to a strictly larger context window; applied model truth remains visible when later recovery proof fails. | Pending |
| RF05 | A recovery-confirmed switch produces one read-only Model Fallback event. Applied-only switches and exhaustion produce none. Use the [Weave UI design record](33-weave-ui-design.md) for the normative event and card geometry; do not add a second card or duplicate geometry. | Pending |
| RF06 | Removing or failing one optional public fallback surface keeps `/weave:health` ready and uses legacy settlement. It does not enter health-only mode or select the overlay fallback. | Pending |

The context-handler check proves trusted composition only: a handler registered
after Weave receives the filtered provider list. It does not prove isolation from
a malicious full-access extension. The exact marker's `message_start` is the only
dispatch proof; a returned `sendMessage` promise, a bare `turn_start`, or a
payloadless settlement is not proof.

## Historical/native-session Pi 0.84.1 contract

This section preserves the historical/native-session contract and its proof
references. It is not evidence for the optional runtime model fallback.
## Pi 0.84.2 native-session contract

Pi `0.84.2` provides native path sessions through `SessionManager.create` and
`SessionManager.open`. The adapter validates Pi's generated path, ID, parent,
working directory, and exact v3 header; exclusively writes the deferred header;
reopens and revalidates it; launches with both `--session` and `--session-dir`;
and removes inherited `PI_CODING_AGENT_SESSION_DIR`. Paths remain adapter-private.
Pi's host-managed native child session is outside the Weave persistence boundary:
Pi may persist reasoning under its own rules, while Weave never duplicates raw
reasoning into its stores or evidence.

Readiness exposes only `delegated-specialist-execution`. A generation enters
health-only mode before mutation when the real preflight yields
`pi-session-api-unavailable`, `pi-session-root-unavailable`,
`pi-session-root-unsafe`, or `pi-process-unavailable`. The proof exercises each
closed reason where a deterministic isolated fixture can do so without altering
the global Pi install.

The earlier Pi `0.83.0` descriptor-only acceptance model and its fail-closed
proofs are historical. Their observations remain intact, but their readiness
conclusion does not govern this checklist. The historical Version 6 checklist
required live Pi 0.84.1 evidence for native child create, streaming, settlement,
continue, historical reopen, direct workflow persistence, lifecycle,
readiness-gated deletion, and path non-disclosure.

Version 6 also adds sanitized child provider-error evidence. Controlled child
events must cover 429, 500 with no body, connection/timeout, and unknown JSON
without an actual provider outage or credential use. The canonical bounded line
must agree on the delegation card, the live and historical child inspector, the
custom-editor fallback, and the parent-facing summary;
a later success must clear it. Raw input and sentinel values must remain absent.
General DLP for secret-shaped tool call IDs and credentials in ordinary tool
output is outside this acceptance scope.
Controlled child events cover 429, 500 with no body, connection/timeout, and
unknown JSON without an actual provider outage or credential use. The canonical
bounded provider-error line must agree on the delegation card, the live and
historical child inspector, the custom-editor fallback, and the parent-facing
summary; a later success must clear it. Raw input and sentinel values remain
absent. General DLP for secret-shaped tool call IDs and credentials in ordinary
tool output is outside this acceptance scope.

## Weave UI redesign surfaces (rows S040–S043, S076–S077, S078–S080)

Version 8 carries forward the inline **delegation card** and **child
inspector**, with the user-approved live raw-reasoning projection. The surfaces
a proof must name are:

- **Delegation card** (§6): one framed card per run, status-first ten-column
  rail, one assignment row, and one live child-activity row exactly
  `↪ reasoning • <text>`. It hides assistant and tool activity and uses the
  4 KiB / 240-code-point / 100 ms bounds. Its right footer prints
  `Ctrl+O expand · Alt+I inspect child`. Expanded, one interior rule, one
  status strip, and nine literal bottom card rows with no child assistant/tool
  payload. Settlement rewrites
  the rail and footer verb (`expand` → `details`) and adds no row.
- **Child inspector** (§7): one titled outer frame with the live state marker;
  a two-row session header (badge · agent · model · role · bounded title, then
  `delegated by <PARENT>` · plan › task › subtask); a Pi-native transcript pane
  left showing the exact reasoning row, bounded sanitized correlated tools, and
  live assistant reply; a Status Matrix rail right grouped lifecycle · work ·
  spend; and a primary-like editor with one muted key row below. The inspector
  uses the 4 KiB / three-row / 50 ms bounds.
- **Keys** (§8.1): `Alt+I` picker, `Alt+1..9`, sibling navigation on `Alt+H` /
  `Alt+L` with the arrow forms normally skipped by conflict detection, empty
  `Backspace` parent-or-close, the six scroll keys, `Enter` steer and
  `Alt+Enter` follow-up, empty-draft `q` cancel confirmation answered
  in-overlay with `y` / `n`, empty-draft `/` rail search with `n` / `N`
  (`j` / `k`) and `Enter` accept, and `Escape` following the precedence
  **cancel confirmation › search › overlay**. The `Ctrl+F` search alias is
  routed only when the host does not already own the key. `Ctrl+O` belongs to
  Pi's own tool expand and is never registered by Weave, and `Alt+A` / `Alt+T`
  do not route while the overlay owns input.
- **Plan Rail** (design record §4): the widget above the parent editor carrying
  `◆ WEAVE · <AGENT>`, the `Alt+A cycle` hint, the plan name, task marks with
  the ordinal, `┃ now`, and `┗ next`, with no duplicate task footer beside it.

## Overlay UX live procedure (rows S051, S070–S080)

For historical/native-session rows, run every step in one fresh Pi `0.84.1`
TUI on a real PTY. Current rows that cite Pi `0.84.2` use that host instead.
In either case, use the exact packaged adapter artifact after confirming the
loaded `dist/extension.js` and `dist/index.js` SHA-256 values and package
provenance. Delegate
one child that produces enough output to overflow the viewport, and open it with
`Alt+I`.
Run every step in one fresh Pi `0.84.2` TUI on a real PTY, through the exact
packaged adapter artifact, after the independent identity gate confirms the
source input, manifest, on-disk outputs, loaded outputs, load time, and process
start. Delegate one child that produces enough output to overflow the viewport,
and open it with `Alt+I`.

1. **Scroll (`S070`).** Press PageUp, PageDown, Shift+Up, Shift+Down, Home, and
   End. Expect: PageUp and Shift+Up move the viewport toward older output;
   PageDown and Shift+Down move it back; Home reaches the oldest loaded output;
   End re-engages the live tail. Repeat with the terminal in application cursor
   mode so Home and End arrive as `ESC O H` / `ESC O F`. Expect identical
   movement. Record that one physical press moves one step, never two, under
   Kitty event reporting.
2. **pi-vim coexistence (`S071`).** With pi-vim active, repeat step 1. Expect the
   same movement, then close the overlay and confirm pi-vim reaches NORMAL mode
   and accepts `i` for INSERT in the parent editor.
3. **Escape (`S051`, `S072`).** Press `Escape` once. Expect the overlay to close,
   the parent editor to take focus, and no cancel prompt. Run
   `weave runtime status` and confirm the child's lease is still held. Reopen the
   child and confirm it is still `running`.
4. **`q` confirm (`S073`).** With an empty overlay draft, press `q`. Expect a
   confirmation whose first and default choice is `Keep running`, answered
   inside the overlay. Press `n`; expect the child to keep running. Press `q`
   again and dismiss with `Escape`; expect the child to keep running and the
   overlay to stay mounted. Press `q` a third time and press `y` for
   `Cancel subtree`; expect the child to settle as `cancelled` and the lease to
   release. Confirm any other key is swallowed while the question is open.
5. **`q` draft and read-only (`S074`).** Type `hi` into the overlay draft, then
   press `q`. Expect `hiq` in the draft and no confirmation. Open a settled
   child, clear the draft, and press `q`. Expect no confirmation.
6. **Telemetry (`S075`).** On a live child that has reported usage, read the
   Status Matrix rail. Expect the lifecycle, work, and spend groups to carry
   real provider, model, context percentage, token, elapsed, queue, turn, and
   spend values. Confirm the session header shows the model exactly once and
   carries no telemetry row and no child ID. Open a child with no usage report
   and expect `—` in each unreported field, with no `0%` and no invented model.
7. **Rail search (`S076`).** With an empty overlay draft, press `/`. Expect a
   SEARCH section prepended to the Status Matrix and a marker gutter beside the
   transcript. Press `n` and `N` (then `j` and `k`) and expect the rail cursor and
   the transcript window to move together. Press `Enter` and expect the jump to
   latch the anchor. Press `Escape` once and expect search to close with the
   overlay still mounted; press `Escape` again and expect the overlay to close.
   Type `hi` into the draft and press `/`; expect `hi/` in the draft and no
   search. Repeat on a historical child after restarting Pi.
8. **Conflict (`S077`).** Bind an overlay key in Pi's own keybindings, restart,
   and open a child. Expect the route to be skipped, the affordance to be absent
   from the key row, and one bounded diagnostic naming the existing owner.
   Confirm Weave registers no binding for `ctrl+o`. On a stock keymap, confirm
   the `ctrl+f` search alias is reported as skipped and that `/` still opens
   rail search on an empty draft.
9. **Delegation card (`S078`).** In the parent transcript, watch one
   `weave_delegate` call from bootstrap through generic thinking, a tool call,
   and a tool result. Expect exactly one framed card with one top and one bottom
   edge, a ten-column status-first rail, one assignment row, and one live
   child-activity row formatted exactly as `↪ reasoning • <text>`. The card
   hides assistant and tool activity, arguments, results, stdout, and stderr.
   Its parent line is one 240-code-point row backed by a 4 KiB UTF-8 buffer and
   a 100 ms repaint coalescer. Press `Ctrl+O`; expect one interior rule, one
   status strip, and nine card-owned rows with no child assistant/tool
   payload. Press `Ctrl+O` again to collapse.
   Narrow the terminal to about 50 columns and expect the state word, the
   assignment, and `Alt+I` to survive.
10. **Card settlement (`S079`).** Observe a completed, a failed, and a cancelled
    run. Expect the settled card to have the same row count as the running card,
    the rail word and settlement framing rewritten from the authoritative
    settlement, the footer verb reading `details`, and no added row, banner, or
    border verdict. Expect the reasoning registry to be empty after settlement;
    no raw reasoning, assistant activity, tool activity, stdout, stderr, or
    inspector payload may appear in card facts, `content`, `details`, replay,
    or the final card. Expect no stack frame, absolute path, or provider payload
    on the failed card, and no success claim on the cancelled one.
11. **Plan Rail (`S080`).** Confirm the Plan Rail is visible above the parent
    editor with the selected agent, the `Alt+A cycle` hint, the plan, the task
    marks, `now`, and `next`. Press `Alt+A` and expect the agent to cycle and the
    rail to update. Confirm no duplicate task footer, and confirm the rail shows
    no child ID, token count, cost, elapsed time, or queue depth in any child
    state. Press `Escape` and expect the rail to survive.
12. **Cleanup.** Close the overlay, quit Pi, and confirm no residual child process
    and no active Runtime Store lease. Close the pane the test created.


## Child-streaming remediation procedure (Task 10/11)

This procedure is separate from the historical redesign rows. It is the
required proof for the user-approved raw-live-reasoning contract.

1. Build the exact subject in an isolated worktree. Record the source-input
   digest, built `dist` output digests, path-free sidecar manifest, Git subject
   and dirty state, Pi `0.84.2` version, and artifact completion time. The
   manifest must contain no paths, source text, user data, or reasoning text.
2. Run the independent identity verifier. It must match the on-disk output,
   manifest output, loaded artifact digest, extension load time, and process
   start time before a live assertion. Run the stale A/B control (build A
   loaded while build B is on disk), the corrupt manifest/output controls, and
   the `/reload` adoption control. Exit those processes and use a new parent
   for live evidence. Modification time is ordering evidence only.
3. Capture Pi `0.84.2` through real session/RPC/extension machinery at the
   public event boundary. Keep generic `thinking_start` /
   `thinking_delta` / `thinking_end` shape, own enumerable field names, value
   kinds, order, lifecycle, tool correlation, bounded sanitized tool data, and
   incremental assistant order. Omit thinking text online before any fixture,
   manifest, report, snapshot, or failure output is written. Keep only
   content-free counts and truncation state. In-memory replay may inject a
   controlled string; no reasoning prose belongs in evidence.
4. Run deterministic replay and red controls for stale generation, wrong child,
   malformed thinking lifecycle, bounds and truncation, terminal controls,
   swallowed mapper/reducer failures, sink leakage, late updates after close or
   settlement, missing assistant deltas, broken tool correlation, and duplicate
   tool terminal events. Diagnostics must contain only closed stage/reason
   codes, saturated counts, and bounded times.
5. In a fresh identity-proven Herdr parent, delegate exactly one deterministic
   `shuttle-mini` child. While it runs, open the active child with `Alt+I` and
   Enter. Check these four lanes independently:

   | Lane | Required live assertion | Current preserved run |
   | --- | --- | --- |
   | Parent raw reasoning live | The card shows only `↪ reasoning • <text>` for child activity and hides assistant/tool activity. | FAIL |
   | Inspector raw reasoning live | The focused inspector shows the same exact row with no blank reasoning row. | FAIL |
   | Inspector tool details | One correlated bash row shows bounded command and result, without duplicate running/done rows. | FAIL |
   | Inspector assistant reply live | Indented assistant text appears and grows under `shuttle · streaming reply` before settlement. | FAIL |

6. Observe raw reasoning only on the live TUI. Disable TUI write logs. Do not
   save pane captures, screenshots, terminal transcripts, scrollback exports,
   or reasoning text. The verifier may hold text in memory only long enough for
   bounded assertions and then emits lane status, identity facts, closed
   reason codes, saturated counts, and cleanup facts.
7. Inspect parent card facts, partial tool updates, persisted `details`, parent
   messages, Runtime Store records, checkpoints, transcript/replay/search
   state, diagnostics, logs, fixture files, and proof output for the forbidden
   reasoning sentinel and assistant/tool activity. The settled tool API result
   may still carry authoritative child output; the custom card must not render
   it as activity. Treat Pi native child-session persistence as the host
   boundary and do not copy it into Weave evidence.
8. Confirm both transient registries are empty after settlement/close, no active
   Runtime Store lease or child process remains, no temporary provider/workspace
   remains, and the test-created Herdr pane is closed.

### Preserved RED reproduction: 2026-08-18

The full post-build Herdr run is recorded in
[`33-child-streaming-remediation-proof.md`](33-proofs/33-child-streaming-remediation-proof.md).
A new Pi parent delegated one `shuttle-mini` task. The parent card showed
`▸ shuttle-mini is writing`, then `⏵ bash · running`, and never showed live raw
reasoning. `Alt+I` opened the picker and Enter selected the active child. The
live inspector showed an empty `✻ reasoning` row and a timeout-only bash row;
the command was absent. Completion added separate bash `running` and `done`
rows, still without command or stdout/result detail. During `live streaming
reply`, the inspector showed the assistant header with only a cursor; after
approximately two seconds it changed to a final response. The final parent
card rendered the child answer. Cleanup succeeded: `weave runtime status`
reported no active lease and the created Herdr pane was closed.

The product reversal accounts only for the empty reasoning row. It does not
account for missing tool command/result detail or blank incremental assistant
text. Those are separate reducer, correlation, or event-projection defects.
The run is RED evidence, not a passing proof. No observed reasoning prose is
recorded here or in the proof file.

The deterministic Task 9 parser, projector, sink-isolation, card, inspector,
and four-lane test gates are recorded separately from live Herdr status. They
do not promote this reproduction to a fresh live pass.

Rows `S057`, `S063`, `S064`, and `S067` were re-run live against the final
fail-closed head `9a8c64683f3e159a587119ee045dc60ae5a62e86` on Pi `0.83.0`, and
[`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md)
is their current record. It also records bounded and fail-closed native-session
reads and the fail-closed rejection of `weave_delegate`, `/weave:run`,
`/weave:start`, and `children.delete` with no child process, lease, ref, cache
mutation, or native child session. The Task 20
`(j)`, `(k)`, and `(n)` records are historical for pre-`c24182f` behaviour,
including their formerly passing mutation rows.

| ID | Requirement | Spec | Result | Proof |
|---|---|---|---|---|
| S040 | The delegation card shows the status-first rail, the assignment row, and exactly one live `↪ reasoning • <text>` child-activity row while running; assistant and tool activity stay out of the card | §6, §2.6a | FAIL | [`33-child-streaming-remediation-proof.md`](33-proofs/33-child-streaming-remediation-proof.md), 2026-08-18 RED reproduction |
| S041 | The authoritative settlement rewrites the rail word and footer verb without changing row count or adding chrome, clears the transient card reasoning buffer, and freezes prior-run cards | §6 | Pending | historical geometry evidence does not prove the new live reasoning boundary |
| S042 | The card renders safely at narrow widths keeping state, assignment and `Alt+I`, sanitizes terminal control sequences, and degrades instead of failing | §6 | Partial | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `g` proves the 48-column render; control-sequence sanitization was not exercised live |
| S043 | The child inspector's titled outer frame leaves the parent UI visible, renders the live raw-reasoning row, one detailed correlated tool row, and incremental assistant reply, and supports the live-tail and scroll controls | §7, §2.6a | FAIL | [`33-child-streaming-remediation-proof.md`](33-proofs/33-child-streaming-remediation-proof.md), 2026-08-18 RED reproduction |
| S044 | The owned native editor shows its cursor and border, supports cursor movement and multiline input, steers with `Enter`, and queues a follow-up with `Alt+Enter` | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S045 | Overlay renders a historical child after parent restart with bounded pagination and search | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `o` |
| S046 | A terminal of 12 rows or fewer keeps the owned editor and bottom border visible; settled children remain read-only and focused input never reaches the primary editor | §7 | Pass | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) |
| S047 | Renderer failure uses the custom-editor fallback; normal overlay mount and unmount never replace the primary editor, and pi-vim remains usable after close | §7, §16 | Pending | [`33-true-overlay-owned-editor-proof.md`](33-proofs/33-true-overlay-owned-editor-proof.md) passes coexistence and teardown; no live renderer failure was injected |
| S048 | Picker lists all statuses with title precedence and active-first, newest-settled ordering | §8.2 | Pending | historical: [`33-task20-d-picker-navigation-proof.md`](33-proofs/33-task20-d-picker-navigation-proof.md) |
| S049 | Named keys route correctly: `Alt+I`, `Alt+1..9`, sibling keys, empty `Backspace` parent-or-close | §8.1 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `h`, `k` |
| S050 | Keybinding conflicts are reported and never overwrite user bindings | §8.1 | Pass | [`33-task20-m-pi-vim-coexistence-proof.md`](33-proofs/33-task20-m-pi-vim-coexistence-proof.md) |
| S051 | `Escape` closes child inspection, never falls through to Pi, and leaves the child running | §7, §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S052 | Retry a retryable failed thread and a cancelled thread; new block per run, divider metadata recorded | §9 | Pending | historical: [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S053 | Continue a completed thread with a required task; continue without a task is a validation error | §9 | Pending | historical: [`33-task20-f-retry-continue-frozen-block-proof.md`](33-proofs/33-task20-f-retry-continue-frozen-block-proof.md) |
| S054 | Thread errors are structured: already-running, stale, integrity, not-retryable; capacity held while running and released on settlement | §9, §3 | Pending | not run in Task 20 |
| S055 | Empty, whitespace-only, thinking-only, and tool-only completions settle as retryable `ChildResponseMissing` with the transcript preserved | §10 | Pending | historical: [`33-task20-g-child-response-missing-retryable-proof.md`](33-proofs/33-task20-g-child-response-missing-retryable-proof.md) |
| S056 | `--no-session` parent fails delegation with `PersistentParentSessionRequired` and creates zero session files | §11 | Pending | historical: [`33-task20-j-no-session-readonly-proof.md`](33-proofs/33-task20-j-no-session-readonly-proof.md) |
| S057 | Read-only history, picker, and doctor remain available under a non-persistent parent and in health-only mode | §11, §15.1 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S058 | Session transition prompts with default Stay, then cancels descendants and writes settlement to origin refs before switching | §12 | Pending | historical: [`33-task20-h-transition-stay-cancel-switch-proof.md`](33-proofs/33-task20-h-transition-stay-cancel-switch-proof.md) |
| S059 | A new parent session shows no prior-session child data; fork/clone refs are excluded on origin mismatch | §4.3, §12 | Pending | historical: [`33-task20-i-fork-clone-origin-exclusion-proof.md`](33-proofs/33-task20-i-fork-clone-origin-exclusion-proof.md) |
| S060 | Quit and reload perform bounded cancel then force-stop with no residual child process | §12 | Pending | not run in Task 20 |
| S061 | No child session appears in Pi `/resume` or in Pi's default session tree | §2 | Pending | historical: [`33-task20-l-resume-exclusion-proof.md`](33-proofs/33-task20-l-resume-exclusion-proof.md) |
| S062 | Child sessions and cache use user-only permissions inside the contained root | §2, §5 | Pending | not run in Task 20 |
| S063 | `/weave:history` returns a bounded first page; `/weave:doctor` returns a sanitized report with no raw prompt or transcript | §15.1, §15.4 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S064 | `weave adapter pi children list/show` respect the 50/100+cursor bounds, stable JSON, and no paths by default | §15.3 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S065 | `weave adapter pi children delete` requires confirmation, appends a tombstone, and leaves the child listed as a tombstone | §2, §15.3 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S066 | Deleting a parent leaves orphan children readable through history and doctor | §2 | Pending | historical: [`33-task20-k-history-doctor-cli-proof.md`](33-proofs/33-task20-k-history-doctor-cli-proof.md) |
| S067 | Missing required capability enters health-only mode with capability, version, contract, probe, mode, and remediation | §16 | Pass | [`33-task21-final-head-fail-closed-proof.md`](33-proofs/33-task21-final-head-fail-closed-proof.md) |
| S068 | Keep child content out of parent projections: bounded terminal output and numeric metadata only | §13 | Pending | not run in Task 20 |
| S069 | Reject exact structured `ChildSettlementMissing` for valid bounded or transferred output | §1, §14 | Pending | not run in Task 20 |
| S070 | All six scroll keys move the mounted overlay viewport live, in legacy, Kitty event-aware, and SS3 encodings, with no release repeats | §7 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S071 | Scroll keys still move the overlay when a foreign primary editor (pi-vim) is installed, and pi-vim keeps its modes after close | §7, §16 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S072 | `Escape` closes the overlay and the inspected child is still running afterwards | §7, §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S073 | Empty-draft `q` opens the cancel confirmation; **Cancel subtree** cancels, and dismissal or **Keep running** leaves the child running | §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S074 | Non-empty draft `q` types into the draft and opens no confirmation; a settled child reports no target | §8.1 | Pass | [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) |
| S075 | The Status Matrix rail shows lifecycle, work, and spend for a reporting child, and `—` for every field the host did not report; the session header shows the model once and carries no telemetry row and no child ID | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `h` |
| S076 | Empty-draft `/` opens rail search with the transcript marker gutter; `n`/`N` and `j`/`k` move, `Enter` latches the jump, and `Escape` closes search before the overlay, on live and historical children | §7, §8.1 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `j` (live) and `o` (historical). Search matches the ANSI-free rendered rows, so text that exists only in a tool row matches |
| S077 | A host that already owns an overlay key keeps it: the route is skipped, unadvertised, and reported once; Weave registers no binding for `Ctrl+O` | §8.1 | Pending | superseded surface; [`33-overlay-ux-live-proof.md`](33-proofs/33-overlay-ux-live-proof.md) records the removed `Ctrl+O` conflict route |
| S078 | The delegation card is one framed card with one top and one bottom edge at every width, expands to a status strip over nine literal bottom card rows without child assistant/tool payload, and prints `Ctrl+O expand · Alt+I inspect child` | §6 | Pending | historical geometry evidence does not prove the new parent-card isolation boundary |
| S079 | Completed, failed, and cancelled cards keep the running row count, print the authoritative settlement text, expose no stack frame, path, or provider payload, and never claim unverified success | §6, §10 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) items `c`, `e` at the retry bytes; the failed card is item `d`, carried over from the first attempt at `600bd88` |
| S080 | The Plan Rail above the parent editor shows agent, `Alt+A cycle`, plan, task marks, `now`, and `next`; `Alt+A` cycles; it survives `Escape`; and it prints no child-operational fact and no duplicate task footer | §7 | Pass | Pi `0.84.2`: [`33-weave-ui-redesign-live-proof.md`](33-proofs/33-weave-ui-redesign-live-proof.md) item `q` proves the plan name, marks, ordinal, `now`, `next`, `Alt+A` cycling, and the absence of a duplicate footer |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, `childSettlementMissingCount: 0`, and, for each
row, that the test-created pane was closed with no residual process, lease, or
pane. Every proof cited above records those fields.

`S042`, `S054`, `S060`, `S062`, `S068`, and `S069` stay `Pending`: Task 20 ran
no live scenario for them, and their automated coverage alone cannot close a
live row.

`S041`–`S043`, `S045`, `S049`, and `S075`–`S080` retain historical geometry,
navigation, and telemetry evidence where their rows say so. The earlier
redesign proof does not close the new raw-reasoning, tool-detail, or incremental
assistant requirements. `S040` and `S043` therefore remain the current RED
reproduction's failed live rows. `S041` remains pending until settlement and
lifecycle release are observed with the new card projection. `S042` remains
partial because control-sequence sanitization was not exercised live, and
`S077` remains pending because its old conflict route was removed with the old
chrome.

`S051` and `S070`–`S074` cite the exact-subject evidence and the overlay key
matrix in `33-proofs/33-overlay-ux-live-proof.md`.

The rows marked `historical` stay `Pending` because they need a persistent
child spawn or a native session mutation. Their prior observations do not close
those rows for this contract.

Because of both groups, `PI-INS`, `PI-INT`, `PI-PRI`, `PI-BND`, `PI-OVR`,
`PI-SET`, `PI-RCV`, `PI-DEL`, `PI-LIF`, and `PI-QUO` are `pending` in
[`acceptance-manifest.json`](acceptance-manifest.json). The requirements that
remain `pass` rest on read-only, reporting, or automated evidence only.
