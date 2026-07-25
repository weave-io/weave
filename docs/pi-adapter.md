# Pi Adapter Architecture

**Status:** Ready — all 20 Spec 33 acceptance rows and all 23 digest-bound exact-host Pi TUI checks pass

**Related:** [Spec 33 — Full-readiness Pi adapter](specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Spec 34 — Harness-neutral permissions](specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md) · [Adapter Boundary](adapter-boundary.md) · [Pi operator guide](adapters/pi.md) · [Adapter Readiness](adapter-readiness-status.md)

## Purpose

`@weaveio/weave-adapter-pi` projects normalized Weave configuration and lifecycle decisions into interactive Earendil Works Pi TUI sessions. The package is a Pi extension. Public print, text, JSON, RPC, and SDK operation are out of scope. The adapter may start private authenticated RPC children for delegation and direct workflow steps.

## Implementation status

The implementation lives in [`packages/adapters/pi`](../packages/adapters/pi). It provides the compiled Pi extension entry, exact host compatibility checks, a read-only safe initializer, generation-scoped controllers, normalized effective-capability health reports, health-only command gating, and an isolated recording fake host. The fake-host suite proves load-time inertness, command ownership checks, stale-generation rejection, trust withholding, and the exact 19-probe report shape without starting Pi.

The adapter now also loads the permitted normalized config, consumes successful materialized descriptors in plan order, reports isolated descriptor errors, and activates valid Loom state on the first `before_agent_start` event. That event supplies Pi's loaded skill catalog; the adapter resolves requested skills exactly, applies deterministic model intent against `ctx.modelRegistry.getAvailable()`, appends one delimited `composedPrompt` block without replacing Pi or other-extension context, and reports deduplicated model or temperature degradation. Model application and prompt authority recheck the controller generation after asynchronous host work.

The adapter now also seals an input-aware permission registry for discovered Pi-native tools, proves interception coverage, binds agent policy through the engine permission session, and consumes single-use permits immediately before execution. Policy `deny` blocks, `allow` proceeds without a grant, and `ask` uses a bounded Pi approval dialog when the adapter is healthy. Unresolved input permits one-time approval only. Tool provenance and controller generation are rechecked at each governed call; changed provenance, stale authority, resolver failure, missing coverage, or unavailable permission state blocks. Unrelated third-party tools remain unmanaged and preserve their owner's behavior.

The adapter now also ships the private delegation transport and the `weave_delegate` tool: an engine-resolved per-agent budget (direct-child, concurrency, depth, and global live-process limits) authorizes, queues (FIFO per parent), or denies each request; an authorized request spawns an independent authenticated `pi --mode rpc --no-session` child, bootstraps its exact composed prompt, active-tool set, and resolved model in one signed envelope, and relays that child's own governed tool-call approvals to the sole parent TUI. The tool's `agent` enum contains only exact normalized names from the invoking descriptor's delegation targets; it rejects display labels and aliases. A live child may itself request nested delegation, restricted to its own declared delegation targets. `weave_delegate` never creates or advances workflow state; it only runs one bounded task and returns the child's own structured settlement.

The adapter now also projects all ten lifecycle operations through the `/weave` palette and nine direct commands. Explicit starts and resumes mint one-use authorization only after fresh user confirmation. Workflow steps use a distinct direct-step child transport: the descriptor `composedPrompt` remains signed bootstrap/system context, while the rendered workflow step prompt is sent separately as the bounded task. Only the root step child receives `weave_complete_step`, and completion requires one bounded structured candidate. Pi's persistent `weave-agent` footer badge renders `◆ WEAVE · <NORMALIZED-NAME>`, switches to the direct workflow agent while it runs, restores the primary after settlement, and clears in health-only mode or at shutdown. Alt+A cycles materialized `primary` and `all` descriptors in order while Pi is idle; it skips subagents and fails atomically. The projection includes `user_confirm` withholding, retry-stable artifact revision pins, digest checks, artifact approval and self-approval guards, revisioned plan rendering, recovery pointers, parent-chat pause handling, and reconciliation.

Trusted activation opens the engine Runtime Store under `.weave/runtime`. The engine holds the project/runtime directory chain with no-follow descriptors, serializes cross-store access with a bounded OS lock, runs `bun:sqlite` in memory, and atomically persists serialized snapshots through descriptor-relative temporary leaves. This avoids path reopens and WAL/SHM sidecars while retaining restrictive local permissions.

The adapter projects bounded normalized Runtime Journal families, exactly-once primary and child usage observations, configured retention, deduplicated TUI failures, and scoped pino output. Its no-follow rotating sink serializes record writes and rotation, then flushes and closes held handles at generation shutdown. Journal validation rejects raw-content fields and oversized or malformed event data before persistence.

The public build now emits both package entry points, passes package-policy and exact-inventory checks, and loads from a packed tarball in an offline clean room against a fake exact-version host. Pi is in the nightly release plan. The checked-in acceptance manifest ([`acceptance-manifest.json`](specs/33-spec-pi-adapter/acceptance-manifest.json)) traces every mandatory `PI-*` requirement to real named tests and packed proof. The exact-host compatibility matrix (`packages/adapters/pi/src/host-compatibility-matrix.ts`) is the source-controlled record Spec 33 §22 requires. All 23 checks in the digest-bound stable TUI smoke checklist ([`33-smoke-checklist.md`](specs/33-spec-pi-adapter/33-smoke-checklist.md)) passed against Pi `0.81.1`; see the [`Task 12 proof`](specs/33-spec-pi-adapter/33-proofs/33-task-12-proofs.md).

## Activation model

Package load is inert: the extension factory constructs a controller, registers composable lifecycle/event delegates, registers exact direct command shells, and binds Alt+A behind an inactive generation gate. Pi registration returns no receipt, so activation inspects `getCommands()` provenance and numeric suffixes instead of assuming success. The factory does not register Weave tools or renderers and does not initialize the project, probe resources, open state, or start services. Shift+Tab remains Pi's reserved thinking-cycle key.

After preflight, activation binds command/event delegates, registers only Weave tool names proven free and verifies their `getAllTools()` provenance, and composes child keys by wrapping the current editor. The generation gate rechecks provenance and wrapper identity before every command, palette action, authority-bearing event, agent start, and registered tool call; later displacement fails closed before mutation. Built-in tools are intercepted, never overridden. `session_start` creates a fresh controller generation and invokes the separate read-only safe initializer before any mutation.

On activation, the controller:

1. determines project trust and loads builtin/global config plus trusted project config;
2. captures Pi-owned model, skill, tool, event, and command context through all 19 read-only probes;
3. builds the effective capability report and stops in health-only mode when a required probe fails;
4. when trusted, opens the Runtime Store; when untrusted, avoids every project path and enters trust-withheld mode;
5. materializes ordered descriptors and builds the complete registered-tool inventory;
6. activates commands, the selected primary, and runtime services only when their trust and capability gates permit them.

A controller generation owns all callbacks, children, challenges, permits, and transient session state. Replacing or shutting down a generation invalidates stale work and cleans descendants. Shutdown is idempotent.

## Ownership

The engine owns normalized descriptors, prompt composition, model intent rules, skill matching, effective tool policy, delegation authorization, lifecycle state, permission semantics, Runtime Store state, usage rollups, and abstract capability evaluation.

The Pi adapter owns Pi resource discovery, concrete tool registration and resolvers, callback and command registration, TUI rendering, host compatibility checks, private child processes and RPC framing, plan/artifact I/O providers, and final permit enforcement.

See [Adapter Boundary](adapter-boundary.md) for the full matrix.

## User surface

The first release projects these commands:

- `/weave` — native palette;
- `/weave:start` and `/weave:run` — explicit workflow start;
- `/weave:status`, `/weave:health`, `/weave:plan`, `/weave:artifact` — read-only views unless an explicit artifact action is chosen;
- `/weave:abort`, `/weave:advance`, `/weave:resume` — explicit lifecycle actions;
- `Alt+A` — cycle healthy, idle `primary` and `all` descriptors in materialization order.

Only an explicit user start or resume authorizes work. Session start, idle, settlement, recovery discovery, and ordinary chat never start or resume durable execution.

## Workflow projection

The adapter maps Pi commands and events into the engine-owned lifecycle surface; it does not reimplement workflow state transitions. One generation-scoped `PiWorkflowController` applies returned effects, records session observations, and rechecks generation authority at asynchronous boundaries. `inspectExecution` supplies persisted attempts so retries reuse the exact artifact revisions consumed by the prior attempt instead of rebinding to newer revisions.

Direct-step children remain private `pi --mode rpc --no-session` processes but are not ordinary delegation. Their bootstrap carries workflow instance, lease, and step correlation. Nested delegation remains available only through the child's ordinary bounded delegation targets and never inherits step-completion authority. A direct step succeeds only through the governed structured completion tool; prose and process exit are not success signals.

The adapter owns no-follow plan/artifact providers and TUI projection. The engine owns lifecycle state, revisioned artifacts, approvals, leases, and Runtime Store writes. Recovery pointers and widgets are read-only projections of authoritative engine state.

## Health-only mode

Static capabilities are ceilings. Activation probes all 19 capability IDs once; 12 are required and 7 are optional under Spec 33. A missing, failed, degraded, or unsupported required effective capability enters health-only mode. Optional gaps warn. The adapter still exposes health and safe diagnostics but blocks materialization, workflow mutation, delegation, and permission approval. Governed calls also block whenever registry coverage, provenance, or the permission session is unavailable.

## Private children

Delegated agents run as ephemeral `pi --mode rpc --no-session` children. Each child authenticates with an independent 256-bit secret (read once from its own environment, then erased) and proves possession via an HMAC-SHA-256-signed handshake; every subsequent control envelope is signed the same way, carries a monotonic per-direction sequence number and a random nonce, and travels as one strict line-delimited JSON object per line. Sequence and nonce checks prevent replay; malformed or unauthenticated lines fail closed and dispose the runtime rather than guessing intent.

The parent-side `PiDelegationController` owns a per-parent FIFO queue and the global live-process count against engine-resolved limits, spawns and bootstraps each authorized child (exact composed prompt, active-tool set, and resolved model in one signed `bootstrap` envelope, acknowledged only after every step applies cleanly), and relays a child's own governed tool-call approvals to the sole parent TUI, tagged with the originating child's id. A live ordinary child or direct workflow-step child may request nested delegation restricted to its own declared delegation targets. The authenticated direct-step transport relays that request into the same controller, so nested helpers consume shared budgets, enter the ordinary child tree under the direct child ID, receive no workflow-completion authority, and are cancelled with the direct subtree. Bootstrap target metadata preserves the engine's optional trigger `routing_hint`; rejecting that valid normalized field would prevent delegation-capable step agents such as Tapestry from bootstrapping. Cancelling a node cancels every descendant, including not-yet-spawned queued requests; a live child is asked to cancel cooperatively, bounded by a grace period, then force-killed. Every child's secret is zeroed and its resources released exactly once, whatever the outcome.

Children are inspectable (a live tree widget with Alt+1-9/Backspace/Esc keyboard controls) and cancellable, not steerable. Public user-started RPC mode does not activate this path.

**Known limitation.** Pi's `agent_settled` event carries no payload, so a child cannot read a stop/error signal directly off it. The adapter derives a `failed` outcome from the most recently observed assistant `stopReason` (`error`/`aborted`) seen on `message_end`; every other case, including no observed stop reason, reports `completed`. A child never reports `completed` once its own cancellation has been admitted. A completed child's settlement summary is its own bounded (<=4KiB, valid UTF-8) final assistant output, with a fixed fallback string used only when a completed turn produced no observable assistant text.

## Data handling

The adapter uses scoped pino logs and bounded sanitized Runtime Journal observations. Closed journal families cover activation/health, generations, probes, workflow/recovery, leases, effects, plans, completion, artifacts, child lifecycle/protocol, delegation, UI bridge, usage, retention, and telemetry degradation. Stable Pi message IDs key usage observations; a bounded generation-local timestamp map makes retries compare exactly without using message content.

It never logs or persists prompts, responses, transcripts, raw RPC, tool input/output, normalized authorization constraints, approval material, plan/artifact content, private paths, environment values, or child secrets. Telemetry failure logs only closed failure codes, phases, impacts, and safe correlation fields.

Harness session entries hold correlation-only recovery pointers. They do not authorize resume. Engine Runtime Store state and explicit user intent remain authoritative.

## Proof standard

Automated tests use fake Pi hosts, injected process/RPC ports, in-memory stores, and narrow Bun filesystem conformance tests. They do not start Pi or mutate developer state. Package proof stages the public files, checks the exact tar inventory and manifest policy, and consumes the tarball offline with fake exact-version host peers. The packed extension must not contain Bun's `import.meta.require` CommonJS bridge: Pi 0.81.1's compiled `jiti/static` path rejects its generated `data:` module with `NameTooLong`. Keeping the bridge-producing `pino` and `kysely` graphs external, with direct runtime dependency declarations, preserves exact-host loadability. `scripts/release/acceptance-manifest.ts` verifies every requirement row's named tests and packed-proof evidence actually exist on disk (never runs them) and that the closed sets it claims (capability IDs, commands and their invalid-state classifications, lifecycle operations, private envelope/reply kinds, permission-gate outcomes, plan-task markers, artifact-approval actors and reconciliation sources, and every failure code/impact/recovery value) are exhaustively covered, and that no packed-proof or live-smoke evidence entry is orphaned (registered but never referenced by a requirement row); `scripts/release/generate-acceptance-manifest.ts` regenerates the checked-in manifest from a real local pack digest and the current git HEAD. The automated suite does not replace live TUI evidence. The completed digest-bound smoke checklist (`docs/specs/33-spec-pi-adapter/33-smoke-checklist.md`) records that separate exact-host run and its artifact binding.
