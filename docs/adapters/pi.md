# Pi Adapter

`@weaveio/weave-adapter-pi` projects normalized Weave configuration and lifecycle decisions into an interactive Pi TUI session. It is a Pi extension, not a standalone print/JSON/RPC/SDK runtime. The adapter may start private authenticated RPC children for delegation and direct workflow steps.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Capabilities](../reference/adapter-capabilities.md) · [Execution Lifecycle](../reference/execution-lifecycle.md) · [Runtime Store](../reference/runtime.md) · [Delegation](../reference/delegation.md)

---

## Boundary

The engine owns normalized descriptors, prompt composition, model intent, skill matching, portable delegation authorization, lifecycle state, Runtime Store state, usage rollups, artifact/plan semantics, and capability evaluation.

The Pi adapter owns:

- Pi model, skill, event, command, and tool discovery;
- extension callbacks, command registration, TUI views, and keybindings;
- exact host compatibility checks and runtime probes;
- concrete model and thinking-level activation;
- private child processes, RPC framing, queues, cancellation, and UI;
- no-follow plan and artifact file providers;
- translation of engine effects into Pi operations.

The adapter does **not** map or enforce Weave `tool_policy`. It registers no global `tool_call` interceptor, permission registry, approval UI, grant, or permit. Pi and each concrete tool owner retain authorization. The `tool-policy-mapping` declaration names `pi-native-tool-control`; that is an ownership claim, not Weave policy enforcement.

## Activation

Package load is inert. The extension factory creates a generation controller and registers gated delegates and command shells, but it does not read project files, probe resources, open the Runtime Store, start services, or register Weave tools.

On `session_start`, a fresh generation:

1. determines project trust;
2. loads builtin/global config plus project config only when trusted;
3. probes every known capability through read-only Pi context;
4. builds the effective health report;
5. enters health-only or trust-withheld mode when required;
6. opens the Runtime Store only for a trusted healthy generation;
7. materializes descriptors in plan order;
8. activates commands, tools, the selected primary agent, and runtime services.

A controller generation owns callbacks, children, and transient session state. Replacement or shutdown invalidates stale work, cancels descendants, flushes held sinks, and closes resources. Shutdown is idempotent.

Pi registration returns no receipt, so activation verifies command provenance and generated suffixes through `getCommands()` rather than assuming registration succeeded. Authority-bearing callbacks recheck the generation after asynchronous host work.

Local extension development may set `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` before Pi starts. This accepts unsuffixed `/weave:*` commands from a top-level extension while retaining missing-command and collision checks. Published builds and release verification must leave the variable unset so npm package provenance remains fail-closed.

## Agents, prompts, models, and skills

During `session_start`, the adapter reads Pi's host-owned skill catalog from the public `getSystemPrompt()` surface. This preserves Pi's settings, package, CLI, trust-boundary, path, and collision decisions. In host contexts that expose `getSystemPromptOptions()`, it uses that live snapshot instead. Before it reports ready or exposes delegation authority, it:

- resolves requested skills through the engine matcher;
- resolves ordered model intent against `ctx.modelRegistry.getAvailable()`;
- applies the selected model and a valid thinking suffix separately;
- commits the selected primary agent atomically;
- reports model or temperature degradation once per generation.

If boot activation fails, the adapter remains unavailable and does not retry when a message arrives. The later `before_agent_start` event only appends the committed agent's delimited prompt block without replacing Pi or other-extension context. A native model change after boot governs the active period until an explicit agent switch applies new model intent.

Alt+A cycles healthy `primary` and `all` descriptors in materialization order while Pi is idle. It skips subagents and switches atomically. The footer shows `◆ WEAVE · <NORMALIZED-NAME>`, follows a direct workflow agent while it runs, restores the primary after settlement, and clears in health-only mode or at shutdown.

The badge tints the agent name with a stable background drawn only from theme background tokens Pi itself supports. The choice is deterministic: the normalized agent name (trimmed, whitespace-collapsed, case-folded) always selects the same token in every session and on every machine, with no stored assignment, so you learn one color per agent. Distinct agents may share a color; the same agent never changes color. The agent name keeps its accent foreground. If the active theme exposes no background helper, the badge renders foreground-only — accent, bold agent name, no tint — rather than substituting a different color.

### Provider acceleration is unsupported

A descriptor's `fast true` reaches Pi as neutral intent, and the adapter carries it on the active primary and inside authenticated ordinary and direct-step child bootstraps. It is never translated into a provider control.

Pi's public extension contract exposes `before_provider_headers`, `before_provider_request`, and `after_provider_response`, but none of them binds the effective transport of one prepared request or that request's response body to the same attempt. `ctx.model.baseUrl` is declared configuration that auth resolution may replace, and `ctx.modelRegistry.getProviderAuth()` performs a fresh resolution rather than reporting the resolution the held request used. Without that proof an allowlist match would be a guess, so even `requested` would be untrue.

The adapter therefore registers **no** provider request, header, or response handler. Every provider payload reference and header map is left exactly as other extensions left it; no `service_tier`, `speed`, or `anthropic-beta` value is ever written. The `provider-fast-activation` capability declares `unsupported` with runtime status `unsupported` and the bounded reason `harness-seam-unavailable`.

The adapter records that outcome when a turn settles (`agent_settled`). A bounded in-memory dedupe window collapses repeats of the same state and reason to one durable journal record, and the key is claimed before the write so two settled turns cannot persist it twice. A failed write releases the claim, so a later settled turn may record it again. The window is in-memory only: it is cleared on session start, after a successful primary switch, and on shutdown or a failed boot activation, so the new active intent owner records its own outcome. Durable journal events already written are never removed by that reset.

This is an optional-capability gap. It warns, never enters health-only mode, and never blocks activation, prompts, models, tools, delegation, or bootstrap. `/weave:status` may show `fast: unsupported (harness-seam-unavailable)`; it never says applied, active, or confirmed. Raising Pi above `unsupported` requires a documented host seam that reports the effective transport of one prepared request plus correlated official response-body evidence for that same request, proven in a fresh real harness under [Adapter Verification](../testing/adapter-verification.md). Unit confidence is not that proof.

The registered `weave_delegate` schema is static because Pi requires it at registration time. Each invocation still resolves the live primary identity and that descriptor's current eligible targets, so switching primary agents cannot reuse stale authority.

## User surface

- `/weave` — native command palette;
- `/weave:start` — confirm and submit an existing plan as a visible foreground Tapestry turn;
- `/weave:run` — explicitly start an engine-managed durable workflow;
- `/weave:resume` — resume an engine-managed durable workflow;
- `/weave:advance` — advance the active workflow;
- `/weave:abort` — stop active work;
- `/weave:status` — inspect workflow status;
- `/weave:health` — inspect activation health;
- `/weave:plan` — inspect the current plan;
- `/weave:artifact` — inspect an available artifact;
- `/weave:inspect` — open the child inspector for the current session's children;
- `/weave:history` — list bounded child metadata for this workspace, including tombstoned rows;
- `/weave:doctor` — run the bounded child-storage diagnostics and print each check;
- `/weave:clear-children` — clear terminal child records for this session;
- `/weave:recover-children` — recover interrupted top-level children;
- `Alt+A` — cycle healthy primary-capable agents;
- `Alt+T` — open the read-only plan-task list;
- `Alt+I` — open the child picker (see [Overlay keys](#overlay-keys)).

Only an explicit user command authorizes work. Session start, idle, settlement, recovery discovery, ordinary chat, and health views never start or resume durable execution.

`/weave:start` is the only plan-execution command. It confirms an existing plan and submits it as one visible foreground Pi turn; it creates no durable workflow state and starts no engine-managed workflow. `/weave:run` does one separate thing: it explicitly starts a named engine-managed durable workflow through the engine lifecycle surface, and it never runs a plan on `/weave:start`'s behalf. `/weave:resume` also calls the engine lifecycle surface. Neither command implies the other.

### Plan-task footer

While a durable workflow is active, Pi renders one `weave-task` status entry: `▸ task N/M · <id>. <title>`, bounded to 56 terminal display columns with a single ellipsis when the text is longer. The footer shows exactly one active task, selected by the engine from the same plan snapshot the plan widget and the Alt+T list read, so those surfaces cannot disagree.

The footer clears when nothing is active: no tracked workflow, no readable plan task, a completed, failed, or cancelled workflow, or an unreadable lookup. It never freezes the last snapshot on screen. When the session tracks no workflow but an eligible recovered pointer exists, the footer may show that paused plan as read-only state. Showing a recovered plan authorizes nothing; only `/weave:resume`, with its own confirmation and lease recheck, continues that work.

### Alt+T plan-task list

`Alt+T` opens a read-only, scrollable list of the active plan's parent tasks. It reads the same active-plan and recovery source as the footer, marks each task `[ ]`, `[~]`, or `[x]`, points a cursor at the active task, and opens on that task rather than at the top. The viewport is bounded on both ends, so a small terminal still scrolls and a tall terminal does not become a full-screen takeover; when tasks are hidden the last line says how many.

Navigation uses your configured Pi keybindings, not fixed bytes: `tui.select.up` and `tui.select.down` scroll, `tui.select.cancel` closes. The hint line names the keys you actually have bound. If a binding is unbound, the list says so rather than silently restoring a default.

The list starts, resumes, advances, and cancels nothing. When no plan is active, it says the plan has no tasks or reports a short, path-free notice such as "Weave could not read the active plan" instead of opening a stale or empty modal. An unreadable plan or workflow produces the same bounded notice and no modal contents.

## Workflow projection

One generation-scoped `PiWorkflowController` maps commands and Pi observations into the ten engine lifecycle projections. It does not reimplement workflow transitions.

A direct workflow step runs in a private child but is not ordinary delegation:

- signed bootstrap carries descriptor/system context and resolved model;
- rendered workflow-step text is sent separately as the task;
- oversized task text is split into generated prompt records below the RPC record limit;
- only the root direct child receives `weave_complete_step`;
- one bounded structured completion candidate plus Pi settlement is required;
- prose and process exit are never success signals.

Nested helpers remain ordinary delegated children. They consume shared budgets, enter the child tree beneath the direct child, inherit only their own declared delegation targets, and receive no workflow-completion authority.

Retries use persisted attempt metadata so they reuse the artifact revisions consumed by the earlier attempt rather than silently binding to newer revisions. User confirmation, digest comparison, artifact approval and self-approval guards, recovery pointers, parent-chat pause handling, and reconciliation remain engine-owned decisions projected through Pi.

## Private children

`weave_delegate` authorizes one non-empty task against engine-resolved limits: eligible targets, direct-child budget, active-child `max_children`, depth, and global live-process count. `max_children` caps children running in parallel; settled or disposed children release capacity.

Delegation requires a persistent parent session. A parent started with `--no-session` has nowhere to record child references, so the adapter refuses to spawn a child and returns `PersistentParentSessionRequired`; the child surfaces stay mounted but read-only. This fails before any child work starts rather than falling back to an unrecorded child.

A delegation call addresses a *thread*, not a single run. Omitting `action` starts a new thread from `agent` plus `task`. `action retry` reruns a failed or cancelled thread by opaque `thread` id, with optional extra `instruction`. `action continue` gives a completed thread more work from a new `task`. A thread that is already running refuses both with `ThreadAlreadyRunning`; other thread failures are `ThreadNotFound`, `ThreadAuthorityDenied`, `ThreadStale`, `ThreadIntegrityError`, `ThreadNotRetryable`, `ThreadNotResumable`, and `ThreadResumeUnavailable`. Each run increments a run number, and earlier runs freeze rather than being rewritten. See [Delegation](../reference/delegation.md#thread-lifecycle).

A run that settles with no terminal assistant response fails with `ChildResponseMissing` and one reason: `empty`, `whitespace-only`, `thinking-only`, `tool-only`, or `no-response`. This is a result failure, not a transport failure — the recorded session stays intact, capacity is released like any other settlement, the failure is retryable, and its recovery hint is to retry the thread.

Authorized work enters a FIFO queue per parent and spawns an independent `pi --mode rpc --no-session` process. Each child has its own 256-bit secret, read once from the environment and then erased.

The control protocol uses:

- HMAC-SHA-256-signed strict line-delimited JSON envelopes;
- an authenticated handshake before bootstrap;
- monotonic sequence numbers and random nonces in each direction;
- closed envelope kinds and validated bounded bodies;
- one bootstrap acknowledgment after prompt, tools, and model activation succeed;
- acknowledged parent-to-child prompt and child-to-parent output transfers.

The protocol keeps three limits separate: native Pi JSONL records are capped at
8 MiB, signed control bodies remain capped at 64 KiB, and one logical chunked
transfer is capped at 64 MiB. Chunks carry at most 24 KiB of decoded payload.
Assemblers bound chunk count and concurrent transfers. Senders wait 10 seconds
for an authenticated ACK/NACK, retry once with a fresh transfer ID, and then
return a typed timeout, rejection, oversize, or delivery failure. Stdin writes
retain partial-write suffixes and await flush.

Malformed, unauthenticated, replayed, or out-of-sequence input fails closed and disposes the runtime. Outbound control writes are serialized, and a failed settlement write is retried once without consuming its authenticated sequence number. Every secret is zeroed and every resource released exactly once.

A child may request nested delegation only to its own declared targets. Canceling a node cancels queued and live descendants. Live children get a bounded cooperative grace period before force termination. The 15-minute settlement budget is an inactivity timeout: each parser-approved session event or authenticated control envelope renews it, while a silent child still fails with `ChildSettlementMissing`.

Children are inspectable and cancellable through the TUI tree, not steerable. Public user-started RPC mode does not activate this private path.

### Native child sessions

Every delegated child runs in a persistent native Pi v3 session created through the host's own session manager, so recorded child work is real Pi session data rather than an adapter transcript format.

Sessions live under `$XDG_DATA_HOME/weave/adapters/pi/sessions/`, defaulting to `~/.local/share/weave/adapters/pi/sessions/`. That root sits outside Pi's default session tree, so child sessions never appear in Pi discovery or `/resume`, while remaining readable through Pi's native open and read APIs. A relative `XDG_DATA_HOME` is a root violation, not a silently ignored value.

All filesystem access goes through a no-follow `openat` chain: directories are `0700`, files are `0600`, and traversal, absolute escape, symlinked components, and permissive modes fail closed. The adapter never copies transcript bytes into its own storage; entry reads return the host's `getEntries()` output.

A bounded metadata cache lives beside it at `$XDG_DATA_HOME/weave/adapters/pi/cache/child-metadata.sqlite` (schema version 1, same permissions). It stores metadata only — ids, titles, statuses, and timestamps — with no column for any prompt, message, response, thinking block, tool call, tool result, or transcript. It is fully rebuildable from the parent session's child references, and its loss is never fatal: an open failure, permission failure, corruption, or schema mismatch degrades to reading the bounded parent references directly, so delegation, settlement, and the live overlay keep working with no cache at all.

The authoritative record of which children belong to a parent is a custom entry in the parent's own Pi session. Origin authority is the session file's persisted header id when the host exposes `SessionManager.getHeader()` — not the manager's per-process runtime id — so a restart that reopens the same file keeps the refs this session wrote. A reference whose recorded origin does not match that identity — after a fork or clone, for example — is excluded rather than adopted. When the header is absent or unusable, the adapter falls back to the live runtime id for that process only and never invents a prior origin.

#### Cleanup, tombstones, and orphans

Cleanup is explicit only. The adapter runs no retention timer, prunes nothing on a schedule, enforces no byte quota, and deletes no session because it is old, large, or settled. Data disappears only when you ask for it through `/weave:clear-children` or `weave adapter pi children delete <id>`.

Deletion appends a tombstone record to `tombstones.jsonl` at the session-tree root. The tombstone file is append-only: there is no rewrite or truncate path. A tombstoned child stays listed, marked `tombstoned`, so a removal is visible rather than silent.

A child whose parent session is gone becomes an orphan. Orphans stay readable and stay listed; the overlay marks them `Read-only orphan — mutations disabled` and refuses steering, follow-up, retry, and continue. `ChildOrphanReadOnly` is the corresponding failure code. The adapter does not delete orphans.

#### No migration from the JSONL store

Earlier versions kept child history in an adapter-owned JSONL store under `child-history/<parent-session-id>/`. That store is removed, and there is no migration. Weave does not read, convert, quarantine, or delete existing JSONL history — the files are simply left in place and are no longer visible to Weave. Handle them outside Weave if you still want the data. See [ADR 0014](../adr/0014-pi-native-child-sessions.md).

The removed settings `persist_history`, `max_bytes_per_child`, `max_bytes_total`, and `orphan_retention_days` went with the store. The `child_inspection` block is strict, so a config that still sets them fails validation.

### Private child inspection

Pi's optional `settings.adapters.pi.child_inspection` block controls the local inspector for private child sessions. It carries `recovery_enabled` (default `true`), `recovery_countdown_seconds` (default `10`, range `0`–`60`), and the optional `keys` overlay key map. The canonical source for its exact defaults, bounds, storage path and permissions, inspector slots and controls, commands, retention, clear behavior, recovery scope, resume behavior, export fields, and privacy boundary is [Spec 33 §§4–10](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#4-deterministic-child-inspector-state-model). Do not infer these settings from engine configuration.

The inspector is adapter-owned. It reads sensitive raw prompts, responses, and session events from local-only native child sessions; it never places that content in the engine Runtime Store, workflow state, logs, telemetry, proof, network requests, or parent-model results. Clearing removes local records; it is not a workflow or engine-history operation. Export is a bounded diagnostic projection, not a transcript export.

Recovery is deliberately narrow: it may recover an interrupted ordinary top-level child when the canonical evidence permits it. It does not recursively recover nested children, recover a workflow process, or turn `/weave:resume` into automatic workflow continuation. A workflow resume is a fresh engine-authorized attempt, and engine-owned leases and workflow state remain the engine's concern. See [ADR 0013](../adr/0013-pi-private-child-sessions.md) for the ownership decision and [Spec 33 §6](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#6-child-recovery-contract) for the limits.

The inspection view renders with Pi's own chat components, so a streamed child reads like a native Pi session: user and task blocks, markdown answer text, italic reasoning, and Pi's tool-execution blocks with real diffs and bash output. Tool calls render through Pi's builtin tool definitions, so a row reads `read <path>` rather than a bare tool name. The adapter injects those components through a narrow port (`PiTranscriptComponentFactory`); the transcript reducer and its dependency-free fallback renderer stay pure, and the fallback text still renders when a component cannot be built. Bookkeeping facts Pi never shows — usage, queue, status, retry, extension-UI requests, and unknown events — are suppressed instead of printed as event prose.

A pinned header names the child and its runtime: status, the concrete model, the reasoning level it was bootstrapped with, turn and queue counts, and token cost. Messages sit one blank row apart. Below the header the transcript scrolls: PageUp and PageDown move a page, Shift+Up and Shift+Down a line, Home jumps to the oldest output, and End follows the live tail again. The overlay matches these keys by identity, so legacy terminal frames, Kitty event-aware frames, and SS3 `ESC O H` / `ESC O F` all work, and it ignores Kitty release frames. While scrolled back, the view says how many newer lines wait below. Escape leaves the view without cancelling anything, and leaving returns the tree editor to the root so typing goes to the parent session again, not to the child.

The session editor is a single shared Pi surface, so Weave never claims it away from another extension. If a foreign editor factory (for example `pi-vim`'s modal editor) is already installed, Weave leaves it in place for the rest of the generation and does not reassert its own on `session_start`, `before_agent_start`, or `agent_start`. If a foreign factory appears after Weave activated, Weave yields on the next lifecycle event instead of reclaiming. Child inspection still works because the overlay carries its own local editor. It never borrows, replaces, or restores the primary session editor during mount or teardown. Root-level child-tree keys are the only optional convenience lost when Weave yields.

#### Compact delegation block

A running `weave_delegate` call renders as exactly three collapsed lines, in every state, for every child:

```
Shuttle gpt-5.6-terra high
<latest activity>
run 2 · editing
```

Line one names the child, its concrete model, and its reasoning level. Line two is the latest whitespace-normalized activity, bounded to 240 code points; expanding the entry reveals the current item up to 4 KiB. Line three names the run number and the current action, so a retried or continued thread shows which run you are watching.

The block is fail-closed: invalid state or a render failure produces a degraded three-line block rather than a partial or missing entry. Chrome lines never echo opaque thread ids, session paths, or native session ids. The reducer keeps at most 64 runs per thread and 128 items per run; older runs stay frozen exactly as they last rendered.

#### True child overlay

Opening a child mounts a centered, bordered Pi overlay above the parent UI. The parent stays visible around it. The overlay uses Pi's native transcript components and a fresh Weave-owned `CustomEditor`, so it never replaces or borrows the primary editor. Its row budget matches Pi's `90%` maximum-height and margin rules. On short terminals it reduces transcript rows first, which keeps the draft editor and bottom border visible.

The local editor owns cursor movement, deletion, multiline text, and draft state. `Enter` steers the active child, and `Alt+Enter` queues a follow-up. Settled and orphan children hide the editor and remain read-only. The overlay owns pagination through recorded history, search, live tail, and per-child view state, and it isolates input: while mounted, no key reaches Pi or the primary editor.

A header meta row reports the focused child's runtime: `provider · model · ctx 42% · 12.3k in / 4.1k out`. The values come only from the host's own bounded usage reports; the overlay keeps the latest report per child and never sums runs. Any field the host did not report shows `—`. Nothing is estimated, so a child whose host never reported a context window shows `ctx —`, not `ctx 0%`.

`Ctrl+O` switches the focused child between the full transcript and a compact one-line-per-entry view, and the header shows a `compact` badge while it is on. Compact is a render-time projection: no entry is dropped or rewritten, the draft and search state survive the toggle, and the viewport stays anchored on the same entry even though the row count changes. The mode is per child and defaults to full.

Historical pages adapt native session entries directly through the host's read API. Live output flows through the same parser and compact pipeline as the collapsed block, so the two views cannot disagree. The visible help lists PageUp, PageDown, Shift+Up, Shift+Down, Home, and End. Scroll keys are matched by key identity rather than by raw bytes, so legacy, Kitty event-aware, and SS3 encodings of the same key all scroll, and a Kitty release frame never repeats a page. Pi does not enable terminal mouse reporting (including SGR-1006 and modes 1002/1003), so mouse-wheel events cannot reach the component. Mouse-wheel scrolling remains unavailable until Pi exposes a mouse input surface.

When the host does not provide the `child-overlay-lifecycle` surface, the overlay degrades to the existing custom-editor inspection path instead of disappearing. Delegation itself is unaffected: overlay gaps never trigger health-only mode.

#### Overlay keys

Overlay controls are named actions with defaults, not fixed bytes:

| Action | Default keys |
| --- | --- |
| `weave.child.picker.open` | `alt+i` |
| `weave.child.slot.1` … `weave.child.slot.9` | `alt+1` … `alt+9` |
| `weave.child.sibling.previous` | `alt+left`, `alt+h` |
| `weave.child.sibling.next` | `alt+right`, `alt+l` |
| Compact view toggle (in-overlay, not a host shortcut) | `ctrl+o` |

Override them under `settings.adapters.pi.child_inspection.keys`, keyed by action id, with a single key string or up to four keys per action. The map is strict: an unknown action id or malformed key syntax is a validation error, never a silent drop.

Every key is checked against your effective Pi keybindings before it is claimed. A key that is already bound stays with its existing owner; the adapter skips its own binding and reports it once as `weave overlay action <id> skipped key <key>: already bound to <owner>`. Weave never overwrites a binding you or another extension already have.

Escape closes child inspection. One press closes the overlay, returns focus to the parent, and leaves the inspected child running. It never cancels a child and never reaches Pi while the overlay is mounted. In search mode it leaves search instead.

Cancelling is explicit and separate. With an empty overlay draft, `q` or `Q` opens a confirmation whose choices are `Keep running` and `Cancel subtree`, defaulting to `Keep running`. Only choosing `Cancel subtree` cancels; dismissing the modal, or any other outcome, leaves the child running. With a non-empty draft, `q` types a character as usual, and a settled or orphan child opens no confirmation at all. `q` is never registered as a Pi shortcut, so it keeps its ordinary meaning everywhere else.

`Ctrl+O` is checked against your effective Pi keybindings like every other overlay key. If the host already binds it, the toggle is skipped and reported as `weave overlay compact view skipped key ctrl+o: already bound to <owner>`, and the compact help row is not shown.

Backspace edits at the owned editor's cursor when its draft is non-empty. On an empty editor draft it moves focus to the parent child, or closes the overlay when the focused child is already a direct child of the session.

#### Transcript search

`Ctrl+F` opens a search prompt inside the focused overlay. Type a query and press Enter to run it; the header then shows the query and the current match position, `n` moves to the next match, `N` to the previous one, and Escape leaves search and clears the query. Search owns the keyboard while the prompt is open: no key reaches the draft editor, the overlay key actions, or Pi, and Escape closes search rather than the overlay. A settled or orphan child stays read-only throughout, so search can never steer or follow up.

Searching scans every page within the overlay's bounded historical page budget, not just the first page that contains a hit, and merges the matches from all of them in transcript order without duplicates. A match that the bounded window has since trimmed still counts toward the reported total, so the match count is the real total rather than the visible one. `Ctrl+F` is checked against your effective Pi keybindings like every other overlay key: if the host already binds it, the route is disabled and reported as `weave overlay search skipped key ctrl+f: already bound to <owner>` instead of taking the key over.

#### Why an inspection opened in the fallback editor

Child inspection has two paths: the native full-screen overlay and the custom-editor fallback. Every decision to use the fallback is recorded as a bounded reason code and printed by `/weave:health` as `overlay: weave overlay fallback: <code>`. The codes carry no child id, session id, path, prompt, or transcript text.

| Code | Meaning |
| --- | --- |
| `preflight-not-native` | The host preflight resolved the custom editor, so the native path never ran. |
| `controller-absent` | No overlay controller exists for this generation. |
| `generation-changed` | The session generation changed between selection and activation. |
| `open-failed` | Opening the child failed for a reason other than a fallback request. |
| `open-source-failed`, `open-describe-failed`, `open-render-failed` | Opening the child requested the fallback for that reason. |
| `open-describe-child-not-found`, `open-describe-source-unavailable`, `open-describe-source-corrupt`, `open-describe-source-not-ready` | Opening the child requested the fallback because describing it failed, and the source error is known. A describe failure only reports the generic `open-describe-failed` when no source error discriminant is available. |
| `mounted-source-failed`, `mounted-describe-failed`, `mounted-render-failed` | The mounted native overlay requested the fallback for that reason. |
| `no-tui-custom-surface` | The host offers no TUI custom surface, so no overlay can mount. |

#### Child picker

`Alt+I` opens a bounded metadata picker over at most 200 candidates. Rows are ordered by stable depth-first tree order, and the numbered slots `Alt+1` through `Alt+9` address the active children in that same order, so a slot means the same child in the list and on the keyboard. Sibling navigation wraps at both ends.

Each row resolves its title by precedence: explicit title, then the task's first line, then the workflow step, then the agent name. Titles are bounded to 200 characters. Rows carry a status — `queued`, `running`, `completed`, `failed`, `cancelled`, `settled`, `interrupted`, `quarantined`, `cleared`, or `tombstoned` — and a source state of `available`, `stale`, `unavailable`, or `orphan`, so an unreadable or orphaned child is labeled rather than hidden.

### Child session commands

In the TUI, `/weave:inspect` opens the inspector, `/weave:history` prints the bounded child list for this workspace including tombstoned rows, `/weave:doctor` prints the doctor status and each check, `/weave:clear-children` clears terminal child records for the session, and `/weave:recover-children` recovers interrupted top-level children.

Outside the TUI, the same adapter-owned data is reachable through `weave adapter pi children list|show|delete` and `weave adapter pi doctor`. Those commands travel over the engine's opaque adapter-command dispatch: the engine validates the envelope and routes it, while command names, payloads, and results stay adapter-owned. The CLI loads production ports through the thin `@weaveio/weave-adapter-pi/cli` entry and bundles that surface at build time; it does not take a published runtime dependency on the Pi adapter package. Delete resolves the child's immutable origin parent from list metadata (or `--parent-session` when the same child id exists under two parents) and rejects forged parent scopes. List pages are 50 children; entry pages are 100 entries with a cursor. Filesystem paths appear only under `--diagnostic`; otherwise every absolute path is replaced with `[path omitted]`. See [CLI](../reference/cli.md#weave-adapter).

### Doctor

`weave adapter pi doctor` and `/weave:doctor` run the same seven bounded checks and never write anything:

| Check | Question |
| --- | --- |
| `doctor.capabilities` | Are the required host surfaces present? |
| `doctor.permissions` | Are the storage directories `0700` and files `0600`? |
| `doctor.sessions` | Is the session tree readable and well-formed? |
| `doctor.refs` | Do the parent's child references parse and match their origin? |
| `doctor.cache` | Is the metadata cache open, current, and uncorrupted? |
| `doctor.stale` | How many recorded children no longer resolve? |
| `doctor.orphans` | How many children have lost their parent session? |

Each check reports `pass`, `fail`, or `skip` with a bounded detail string. The report status is `ok` when no check fails, `degraded` when any check fails, and `unavailable` when every check is skipped or the report itself fails validation. Scans are bounded to 50 rows per page and details carry counters, never child text.

For troubleshooting, start with `/weave:health`, then `/weave:doctor`, then the private-child failure code and the adapter's bounded diagnostics. A missing or corrupt record is reported as a diagnostic code — `ChildSessionMissing`, `ChildSessionCorrupt`, `ChildSessionRootViolation`, `ChildSessionPermissionError`, `ChildTombstoneAppendFailed`, `ChildRefInvalid`, `ChildRefOriginMismatch`, `ChildCacheDegraded`, or `ChildCacheStale` — and it does not authorize a guessed resume. Step-by-step remedies are in [Pi child troubleshooting](../guides/pi-child-troubleshooting.md); the complete command and key map is [Spec 33 §10](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#10-control-surface).

### Settlement and output

The delegation tool entry names its child on the call line and shows the child's
latest output below a rule:

```
Shuttle gpt-5.6-terra high
──────────────────────────────────────────────────
<latest thought or answer text>
```

The model and reasoning level come from the same resolution the child's
bootstrap carries, so the entry names what the child will actually run on before
it exists. When no output has streamed yet, the body shows the child's status.

While a child runs, `weave_delegate` updates its tool entry from Pi's streamed
`message_update` events. Before answer text starts, the entry shows the latest
bounded `thinking_delta` preview so a reasoning child does not look frozen.
Once a `text_delta` arrives, answer text replaces the thinking preview and
remains authoritative. Both previews are transient, capped at 4 KiB, and never
persisted. The collapsed tool entry shows the latest whitespace-normalized 240
code points; expanding it reveals the full bounded preview. The status line also
shows the child's current tool. Spawn failures return the typed code plus the adapter-owned safe message,
closed reason when available, retryability, and recovery hint; raw host errors
and environment values never enter the result.

Pi's `agent_settled` event has no payload. The adapter derives `failed` from the latest assistant `message_end.stopReason` when it is `error` or `aborted`; every other case, including no observed reason, settles as `completed`. Once cancellation is admitted, that child cannot report `completed`.

Completed settlement fields have one meaning each: `assistantOutput` is the
bounded parent projection, `completionCandidate` is direct-step structured JSON,
`outputTransferId` references an ACKed private transfer, and
`outputByteLength` is numeric metadata. Output above the 4 KiB projection cap is
transferred before settlement. A failed output transfer still produces one
bounded inline settlement. The inspector/history sink receives full output;
controller, delegation-tool, and workflow results receive only the bounded
projection plus numeric metadata.

## Plans, artifacts, and recovery

The adapter's no-follow providers prove project containment, read plan/artifact files, and compute digests. The engine owns plan state, workflow transitions, artifact identity/revisions, approval, leases, and integrity comparison.

Pi session entries contain correlation-only recovery pointers. They do not authorize resume. Runtime Store state plus explicit user intent remain authoritative.

## Runtime and data handling

Trusted healthy activation opens `.weave/runtime/weave.db` through the engine Runtime Store. The engine hardens the project/runtime path, serializes cross-store access with a bounded OS lock, uses `bun:sqlite`, and atomically publishes durable state.

The adapter records bounded normalized journal families, exactly-once primary/child usage observations, configured retention, deduplicated TUI failures, and scoped pino output. Its rotating file sink serializes writes and closes held handles at generation shutdown.

The adapter never logs prompts, responses, transcripts, raw RPC, tool input/output, plan/artifact content, private paths, environment values, or child secrets. Full child output and normalized session events persist only inside the restrictive native child sessions described above; they never enter telemetry, parent-model results, controller results, or workflow completion. Telemetry failures expose only closed codes, phases, impacts, and safe correlation fields.

## Host surface probes

Beyond the engine's closed capability IDs, the adapter declares the concrete Pi host surfaces it needs, each with a severity. The compatibility floor is Pi `0.81.1`.

- `required-for-delegation` — a gap puts the generation into health-only mode. Native child sessions add `rpc-persistent-session`, `rpc-append-entry`, `rpc-session-tree-read`, and `custom-session-directory` to this set, alongside the existing editor, RPC, and session-restore surfaces.
- `overlay-only` — a gap selects the custom-editor fallback and never triggers health-only mode. `child-overlay-lifecycle` is the only such surface. Session reads are deliberately not overlay-only.
- `rendering-fallback` — a gap uses Pi's default rendering.

A gap reports the stable surface id plus a remediation string, for example upgrading to a host that exposes `pi.appendEntry`. Pi 0.83 exposes no named extension action ids, so overlay actions are reported through the `named-configurable-shortcut-actions` diagnostic rather than as a native capability. See [Adapter Capabilities](../reference/adapter-capabilities.md#adapter-owned-host-surface-probes).

## Health-only mode

Static capability declarations are ceilings. Activation probes every closed capability ID once. Any missing, failed, degraded, or unsupported required effective capability enters health-only mode; optional gaps warn.

Health-only mode exposes health and safe diagnostics but blocks materialization, workflow mutation, and delegation. Pi/tool-owner authorization remains in force regardless of mode.

## Pi-native path sessions

Pi addresses native sessions by filesystem path. Containment is therefore proven by the adapter, not claimed from the host:

1. The adapter resolves its fixed session root under the trusted XDG data base, creates a private `0700` child directory, and hands that exact directory to `SessionManager.create`.
2. It validates Pi's generated leaf as a canonical immediate child of that directory, never a path prefix, and validates the generated v3 header, session ID, parent link, and `cwd`.
3. Because Pi defers the first write, the adapter exclusively creates the absent `0600` leaf with Pi's exact generated header bytes plus a newline. It never invents, alters, or reorders a header field.
4. It reopens the leaf through `SessionManager.open` and revalidates path, directory, header, session ID, parent, `cwd`, and persistence before any spawn.
5. The RPC child receives both `--session <validated file>` and `--session-dir <validated directory>`, and the launch environment drops any inherited `PI_CODING_AGENT_SESSION_DIR` so the explicit argument stays the sole authority.

Callers, models, and the engine never supply a path, and no path crosses the adapter boundary into Results, logs, health, status, doctor, CLI output, lifecycle metadata, or model content.

Delegation readiness is reported through the required `delegated-specialist-execution` capability. When the real Pi session or process surfaces do not probe ready, the generation stays health-only before spawn and reports exactly one closed, path-free reason: `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable`. No environment variable or configuration setting can raise it.

While the capability is unavailable for one of those reasons, the adapter fails every persistent session mutation with a typed `RequiredCapabilityUnavailable` result before it reaches a controller, session service, filesystem, metadata cache, execution lease, or child process:

- `weave_delegate` (start, retry, continue, steer, follow-up) and relayed child delegation;
- direct workflow dispatch, `/weave:start`, `/weave:run`, `/weave:advance`, `/weave:resume`, `/weave:artifact`;
- cancellation and cleanup: `/weave:abort`, `/weave:clear-children`, `/weave:recover-children`;
- the adapter CLI `children delete` command.

`/weave:status`, `/weave:health`, `/weave:plan`, `/weave:inspect`, `/weave:history`, `/weave:doctor`, and the CLI `list`, `show`, and `doctor` commands stay available and perform no mutation. `/weave:health` and the status line name the unavailable capability and its reason without printing a path or a prompt.

## Verification

Unit and integration tests use a recording fake host, injected process/RPC ports, in-memory stores, and narrow Bun filesystem conformance tests. They do not start Pi or modify developer state.

Release validation stages the package, checks exact tar inventory and policy, and loads the packed extension against a fake exact-version host. Machine-consumed acceptance inputs live under [`scripts/release/pi-acceptance/`](../../scripts/release/pi-acceptance/):

- [`acceptance-manifest.json`](../../scripts/release/pi-acceptance/acceptance-manifest.json) binds every mandatory `PI-*` requirement to named tests and packed evidence;
- [`acceptance-manifest.schema.json`](../../scripts/release/pi-acceptance/acceptance-manifest.schema.json) validates the generated manifest;
- [`smoke-checklist.md`](../../scripts/release/pi-acceptance/smoke-checklist.md) defines the digest-bound live TUI checks.

[`scripts/release/acceptance-manifest.ts`](../../scripts/release/acceptance-manifest.ts) validates requirement references and closed-set coverage without running tests. [`generate-acceptance-manifest.ts`](../../scripts/release/generate-acceptance-manifest.ts) regenerates the checked-in manifest from the current package digest and commit. Automated checks do not replace live TUI validation.
