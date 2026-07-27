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

## Agents, prompts, models, and skills

The first `before_agent_start` event supplies Pi's loaded skill catalog. The adapter:

- resolves requested skills through the engine matcher;
- resolves ordered model intent against `ctx.modelRegistry.getAvailable()`;
- applies a valid thinking suffix separately from model identity;
- appends one delimited composed-prompt block without replacing Pi or other-extension context;
- reports model or temperature degradation once per generation.

Alt+A cycles healthy `primary` and `all` descriptors in materialization order while Pi is idle. It skips subagents and switches atomically. The footer shows `◆ WEAVE · <NORMALIZED-NAME>`, follows a direct workflow agent while it runs, restores the primary after settlement, and clears in health-only mode or at shutdown.

The registered `weave_delegate` schema is static because Pi requires it at registration time. Each invocation still resolves the live primary identity and that descriptor's current eligible targets, so switching primary agents cannot reuse stale authority.

## User surface

- `/weave` — native command palette;
- `/weave:start` — confirm and submit an existing plan as a visible foreground Tapestry turn;
- `/weave:run` — explicitly start an engine-managed durable workflow;
- `/weave:resume`, `/weave:advance`, `/weave:abort` — explicit lifecycle actions;
- `/weave:status`, `/weave:health`, `/weave:plan`, `/weave:artifact` — read-only views unless an explicit artifact action is chosen;
- `Alt+A` — cycle healthy primary-capable agents.

Only an explicit user command authorizes work. Session start, idle, settlement, recovery discovery, ordinary chat, and health views never start or resume durable execution.

`/weave:start` is a foreground Pi turn and does not create durable workflow state. `/weave:run` and `/weave:resume` call the engine lifecycle surface.

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
- one bootstrap acknowledgment after prompt, tools, and model activation succeed.

Malformed, unauthenticated, replayed, or out-of-sequence input fails closed and disposes the runtime. Every secret is zeroed and every resource released exactly once.

A child may request nested delegation only to its own declared targets. Canceling a node cancels queued and live descendants. Live children get a bounded cooperative grace period before force termination.

Children are inspectable and cancellable through the TUI tree, not steerable. Public user-started RPC mode does not activate this private path.

### Settlement limitation

Pi's `agent_settled` event has no payload. The adapter derives `failed` from the latest assistant `message_end.stopReason` when it is `error` or `aborted`; every other case, including no observed reason, settles as `completed`. Once cancellation is admitted, that child cannot report `completed`.

A completed child's result is its own bounded final assistant text, with a fixed fallback when the turn emitted none.

## Plans, artifacts, and recovery

The adapter's no-follow providers prove project containment, read plan/artifact files, and compute digests. The engine owns plan state, workflow transitions, artifact identity/revisions, approval, leases, and integrity comparison.

Pi session entries contain correlation-only recovery pointers. They do not authorize resume. Runtime Store state plus explicit user intent remain authoritative.

## Runtime and data handling

Trusted healthy activation opens `.weave/runtime/weave.db` through the engine Runtime Store. The engine hardens the project/runtime path, serializes cross-store access with a bounded OS lock, uses `bun:sqlite`, and atomically publishes durable state.

The adapter records bounded normalized journal families, exactly-once primary/child usage observations, configured retention, deduplicated TUI failures, and scoped pino output. Its rotating file sink serializes writes and closes held handles at generation shutdown.

The adapter never logs or persists prompts, responses, transcripts, raw RPC, tool input/output, plan/artifact content, private paths, environment values, or child secrets. Telemetry failures expose only closed codes, phases, impacts, and safe correlation fields.

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
