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

The first `before_agent_start` event supplies Pi's loaded skill catalog. The adapter:

- resolves requested skills through the engine matcher;
- resolves ordered model intent against `ctx.modelRegistry.getAvailable()`;
- preserves a native model selected with Pi's set/cycle controls after startup instead of replacing it on the first prompt;
- applies a valid thinking suffix separately from model identity when Weave applies the model;
- appends one delimited composed-prompt block without replacing Pi or other-extension context;
- reports model or temperature degradation once per generation.

Alt+A cycles healthy `primary` and `all` descriptors in materialization order while Pi is idle. It skips subagents and switches atomically. The footer shows `◆ WEAVE · <NORMALIZED-NAME>`, follows a direct workflow agent while it runs, restores the primary after settlement, and clears in health-only mode or at shutdown.

The badge tints the agent name with a stable background drawn only from theme background tokens Pi itself supports. The choice is deterministic: the normalized agent name (trimmed, whitespace-collapsed, case-folded) always selects the same token in every session and on every machine, with no stored assignment, so you learn one color per agent. Distinct agents may share a color; the same agent never changes color. The agent name keeps its accent foreground. If the active theme exposes no background helper, the badge renders foreground-only — accent, bold agent name, no tint — rather than substituting a different color.

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
- `Alt+A` — cycle healthy primary-capable agents;
- `Alt+T` — open the read-only plan-task list.

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

### Private child inspection

Pi's optional `settings.adapters.pi.child_inspection` block controls the local inspector for private child sessions. The canonical source for its exact defaults, bounds, storage path and permissions, inspector slots and controls, commands, quotas and trim markers, retention, clear behavior, recovery scope, resume behavior, export fields, and privacy boundary is [Spec 33 §§4–10](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#4-deterministic-child-inspector-state-model). Do not infer these settings from engine configuration.

The inspector is adapter-owned. It may retain sensitive raw prompts, responses, and session events in local-only private history; it never places that history in the engine Runtime Store, workflow state, logs, telemetry, proof, network requests, or parent-model results. Physical clear removes the private store; it is not a workflow or engine-history operation. Export is a bounded diagnostic projection, not a transcript export.

Recovery is deliberately narrow: it may recover an interrupted ordinary top-level child when the canonical evidence permits it. It does not recursively recover nested children, recover a workflow process, or turn `/weave:resume` into automatic workflow continuation. A workflow resume is a fresh engine-authorized attempt, and engine-owned leases and workflow state remain the engine's concern. See [ADR 0013](../adr/0013-pi-private-child-sessions.md) for the ownership decision and [Spec 33 §6](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#6-child-recovery-contract) for the limits.

For troubleshooting, start with `/weave:health`, then inspect the private-child failure code and the adapter's bounded diagnostics. A missing or corrupt private-history record is quarantined or reported according to [Spec 33 §7.4](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#74-quarantine-and-corruption-handling); it does not authorize a guessed resume. The complete command and key map is [Spec 33 §10](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#10-control-surface).

### Settlement and output

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

The adapter never logs prompts, responses, transcripts, raw RPC, tool input/output, plan/artifact content, private paths, environment values, or child secrets. Full child output and normalized session events may persist only inside the restrictive local child-history store for inspection; they never enter telemetry, parent-model results, controller results, or workflow completion. Telemetry failures expose only closed codes, phases, impacts, and safe correlation fields.

## Health-only mode

Static capability declarations are ceilings. Activation probes every closed capability ID once. Any missing, failed, degraded, or unsupported required effective capability enters health-only mode; optional gaps warn.

Health-only mode exposes health and safe diagnostics but blocks materialization, workflow mutation, and delegation. Pi/tool-owner authorization remains in force regardless of mode.

## Verification

Unit and integration tests use a recording fake host, injected process/RPC ports, in-memory stores, and narrow Bun filesystem conformance tests. They do not start Pi or modify developer state.

Release validation stages the package, checks exact tar inventory and policy, and loads the packed extension against a fake exact-version host. Machine-consumed acceptance inputs live under [`scripts/release/pi-acceptance/`](../../scripts/release/pi-acceptance/):

- [`acceptance-manifest.json`](../../scripts/release/pi-acceptance/acceptance-manifest.json) binds every mandatory `PI-*` requirement to named tests and packed evidence;
- [`acceptance-manifest.schema.json`](../../scripts/release/pi-acceptance/acceptance-manifest.schema.json) validates the generated manifest;
- [`smoke-checklist.md`](../../scripts/release/pi-acceptance/smoke-checklist.md) defines the digest-bound live TUI checks.

[`scripts/release/acceptance-manifest.ts`](../../scripts/release/acceptance-manifest.ts) validates requirement references and closed-set coverage without running tests. [`generate-acceptance-manifest.ts`](../../scripts/release/generate-acceptance-manifest.ts) regenerates the checked-in manifest from the current package digest and commit. Automated checks do not replace live TUI validation.
