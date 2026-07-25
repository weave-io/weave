# Pi Adapter Guide

**Status:** Ready — all 20 Spec 33 acceptance rows and all 23 digest-bound exact-host Pi TUI checks pass

**Related:** [Pi adapter architecture](../pi-adapter.md) · [Spec 33](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Adapter readiness](../adapter-readiness-status.md)

## Current implementation

The implemented package in [`packages/adapters/pi`](../../packages/adapters/pi) registers inert command shells and session delegates, then uses exact host, TUI, trust, command-ownership, candidate-plan, and capability probes to create a generation-scoped controller. Failed required probes or withheld trust keep the extension in health-only mode.

For supported sessions, the adapter loads the permitted Weave config, consumes materialized descriptors in stable plan order, and prepares Loom as the ordinary primary. On the first `before_agent_start`, it uses Pi's loaded skill catalog and authenticated model registry to resolve Loom's exact skill and ordered model intent. It applies a resolved model through Pi, preserves model fallback as a visible degradation, and appends Loom's final `composedPrompt` once to Pi's existing prompt. Declared temperature remains ignored and appears as a deduplicated health warning.

The adapter also governs discovered Pi-native tools through input-aware resolvers and the engine permission session. It checks exact built-in provenance, sealed registry coverage, and controller generation before each call. Policy `deny` blocks, `allow` consumes a single-use permit without prompting, and `ask` opens a bounded approval dialog only outside health-only mode. Missing or malformed resolver input is unresolved and supports one-time approval only. Unrelated third-party tools remain unmanaged.

The adapter also ships a bounded `weave_delegate` tool and its private authenticated child transport (see [Delegation](#delegation) below). Workflow commands, direct-step execution, plans, artifacts, recovery, and reconciliation are implemented. Bounded diagnostics, packed-package policy, clean-room fake-host consumption, and nightly release integration are also implemented. The acceptance manifest, exact-host compatibility matrix, and completed digest-bound stable TUI smoke checklist provide the readiness proof (see [Package proof](#package-proof) below).

## Compatibility

The first adapter release supports only the Earendil Works Pi host package:

```text
@earendil-works/pi-coding-agent >=0.81.1 <0.82.0
```

Host package identity and version are checked at activation. Unsupported or ambiguous hosts fail closed into health-only mode.

## Install

When a release has passed Spec 33's package and smoke gates, install it as a Pi package:

```shell
pi install npm:@weaveio/weave-adapter-pi
```

The published package declares `pi.extensions: ["./dist/extension.js"]`; users do not need a wrapper extension. The package has no install or postinstall scripts.

> **Security:** Pi packages run with the user's full process and filesystem authority. Install only the published package digest that passed Spec 33, and review the [source and security boundary](../pi-adapter.md) before enabling it.

## Configuration and trust

Global configuration lives at `~/.weave/config.weave`. Project configuration lives at `.weave/config.weave`.

In an untrusted project, the adapter loads only builtin/global configuration and does not read or write project prompts, skills, plans, artifacts, runtime state, or any other project path. It may expose ordinary prompt-only chat from builtin/global descriptors, but it disables project-local and durable operations, delegation, and capability-bearing registered tools. After Pi establishes project trust, reload into a fresh session so a new controller generation can activate project configuration.

## Start and inspect

Use `/weave` to open the palette or invoke a direct command:

- `/weave:start [plan]` — select or name an existing plan and start its plan execution;
- `/weave:run [workflow]` — select or name a configured workflow and start it;
- `/weave:status` — inspect active execution;
- `/weave:health` — inspect host and capability probes;
- `/weave:resume` — explicitly resume durable state;
- `/weave:abort` — confirm cancellation and terminate the full owned execution child tree;
- `/weave:advance` — answer an allowed blocked transition;
- `/weave:plan` — show the read-only task tree;
- `/weave:artifact` — inspect or explicitly act on an artifact.

Session start, idle, recovery discovery, and normal chat do not authorize workflow work. The adapter continues automatically only when the engine returns a next effect in the same uninterrupted authorized controller generation. Pi's persistent footer shows `agent: <name>` under status key `weave-agent`, using the exact normalized active descriptor name. It shows `agent: loom` during ordinary chat, switches to a workflow agent such as `agent: tapestry` while that direct step runs, restores the primary after settlement, and clears in health-only mode or at shutdown.

## Workflow lifecycle

The palette and nine direct commands project all ten engine lifecycle operations through one generation-checked `PiWorkflowController`. `/weave:start`, `/weave:run`, and `/weave:resume` require fresh user confirmation before the adapter mints a one-use authorization token. A recovery banner is informational and never resumes work by itself.

Workflow steps use a direct private-child transport distinct from ordinary `weave_delegate` calls. The signed bootstrap installs the activated descriptor's `composedPrompt` as system context; the separately rendered workflow `step.prompt` travels as the bounded RPC task. The adapter never concatenates the full descriptor prompt into that task, which lets canonical primaries such as Tapestry run without weakening the ordinary delegation-task bound. Only the root direct-step child receives `weave_complete_step`; nested helpers do not inherit completion authority. When a step agent such as Tapestry calls `weave_delegate`, the direct transport authenticates the request and relays it into the generation's shared `PiDelegationController`. The nested child therefore uses the step agent's own eligible targets and the same depth, concurrency, process, queue, cancellation, and cleanup rules as ordinary delegation. The tool records one bounded structured completion candidate. Free-form assistant text, process exit, duplicate signals, malformed candidates, and late calls never count as successful completion. `user_confirm` candidates remain withheld until `/weave:advance` confirms them.

Before dispatch, the adapter reuses the prior attempt's pinned artifact revisions on retries and verifies each consumed artifact's current SHA-256 digest through a held, no-follow file descriptor. Plan catalog and artifact reads reject traversal and symlink components. New artifact revisions reset approval, and an agent cannot approve its own artifact. The compact plan widget refreshes after lifecycle transitions; explicit reconciliation handles mismatched execution state.

Trusted sessions open the engine Runtime Store under `.weave/runtime`. The engine holds the project/runtime directory chain with no-follow descriptors, coordinates stores with a bounded OS lock, runs SQLite in memory, and atomically persists serialized snapshots through descriptor-relative temporary files. Database, temporary, and lock leaves use restrictive permissions; no WAL/SHM sidecars are created. Recovery pointers supplement this authoritative state but never grant resume authority.

Ordinary parent chat does not interleave silently with a live direct step. Pi asks whether to pause the workflow first; declining leaves the workflow running and withholds the prompt.

## Health-only mode

If `/weave:health` reports health-only mode, the adapter blocks work but keeps diagnostics available. Common causes include:

- wrong Pi package identity or unsupported version;
- a missing required host hook or RPC capability;
- unreadable or invalid Weave configuration;
- permission, Runtime Store, plan, or artifact provider failure;
- a required capability probe reporting degraded or unsupported.

Fix the reported cause and start a new Pi session. Do not bypass health-only mode by calling private extension APIs.

## Delegation

`weave_delegate` runs one bounded task on a single eligible subagent as a private ephemeral child, then returns that child's own structured result. Its `agent` parameter is an enum of exact normalized names from the invoking descriptor's `delegationTargets` (for example `shuttle` or `shuttle-backend`); display labels, descriptions, and aliases are invalid. It never creates or advances workflow state; workflow steps use the distinct direct-step transport described above.

**Exact command.** A delegated child is spawned as `pi --mode rpc --no-session`, never as an interactive session. This is the only Pi RPC entry point the adapter uses; a real user never starts this path themselves.

**Auth and framing.** Each child receives an independent, process-scoped 256-bit secret over its environment (read once, then erased from the child's own environment on first use) and proves possession with an HMAC-SHA-256-signed handshake before either side accepts anything else. Every subsequent control envelope (`bootstrap`, `bootstrap-ack`, `cancel`, `settled`, `cancelled`, `error`, `approval-request`/`-response`, `delegate-request`/`-response`) is signed the same way, carries a monotonic per-direction sequence number and a random nonce, and travels as one strict line-delimited JSON object per line over the child's stdio. Malformed, unsigned, replayed (repeated nonce or non-increasing sequence), or unauthenticated lines fail closed and the runtime disposes itself rather than guessing intent.

**Queues and budgets.** Project settings (and narrower per-agent overrides, direct-child and concurrency limits only) define finite direct-child, concurrency, depth, and global live-process limits, resolved per requesting agent. A request that exceeds direct-child, concurrency, or depth limits is denied immediately; a request within the per-parent direct-child limit but currently over the concurrency or process ceiling queues in FIFO order per parent and is promoted automatically as capacity frees up. The controller fails closed (denies) whenever live count state cannot be resolved, rather than guessing a lower bound.

**Nested relay.** A live ordinary child or direct workflow-step child may itself request delegation through its own `weave_delegate` tool. The parent transport admits only an authenticated request from a running child, then the shared controller restricts the request to that exact child's own declared `delegationTargets` from its bootstrap descriptor — a child can never delegate to an agent its own bootstrap did not name. A direct-step child remains outside the ordinary process budget, but every helper it delegates enters the shared ordinary tree under the direct child ID and consumes the normal budget. Cancelling the direct child also cancels that descendant subtree. Every child's own governed tool-call approvals (including a nested child's) relay through the single parent TUI, tagged with the originating child's id, never a nested/child-local approval UI.

**Cleanup.** Cancelling a node cancels that node and every descendant, including not-yet-spawned queued requests under that subtree. A live child is asked to cancel cooperatively (signed `cancel` envelope, then a raw abort command), bounded by a grace period; if it does not exit in time it is force-killed. Process exit while a cancel is outstanding is treated as the expected outcome, not an unexpected exit. Every child's secret is zeroed and its resources released exactly once (idempotent), whether it settles, fails, or is cancelled.

**Active tool/model/context bootstrap.** The parent sends the new child exactly one signed `bootstrap` control envelope containing its resolved agent name, composed prompt, ordered model preference list (plus a parent-resolved model directly, for a root-level delegation with a live model registry), effective tool policy, its own eligible `delegationTargets`, delegation context (parent agent name, parent depth, cwd), and the exact active-tool name list the child must apply. Each target preserves the engine's bounded trigger metadata, including optional `routing_hint`; the transport schema must not reject that normalized field or a delegation-capable step agent such as Tapestry fails bootstrap before its first turn. The child validates the bootstrap's `correlationId` against its own authenticated identity, applies the exact active-tool set via the host's `setActiveTools`, resolves a model (using the parent-resolved model if present, else resolving against its own catalog), and only signals readiness (`bootstrap-ack`) after every step succeeds — any failure disposes the child without ever partially applying a bootstrap.

**Tree controls.** The parent renders a live child tree widget and supports direct keyboard navigation over it: Alt+1 through Alt+9 select a direct child by spawn order, Backspace selects the parent (host default at the root), and Esc requests cancellation of the selected node (host default at the root). `/weave:abort` cancels the full owned execution child tree from the palette.

**Limitations.** Pi's `agent_settled` event carries no payload (`{"type":"agent_settled"}` only) — a child cannot read a stop/error signal directly off it. The adapter instead tracks the most recently observed assistant `stopReason` (`stop`/`length`/`toolUse`/`error`/`aborted`) from `message_end` events and derives a `failed` outcome only when that value is `"error"` or `"aborted"`; every other case (including no observed stop reason at all) reports `completed`. A child never reports `completed` once its own cancellation has been admitted, closing the only remaining race between a stray settlement and an already-sent cancellation. A completed child's settlement summary is its own bounded (<=4KiB, valid UTF-8) final assistant output, truncated at a UTF-8 code-point boundary; a fixed fallback string is used only when a completed turn produced no observable assistant text.

**Tests.** Delegation is exercised at three automated layers with no real Pi process, secret material, or filesystem I/O: pure control-body/limit unit tests (`child-control-bodies.test.ts`, `strict-json.test.ts`), an injected-port parent/child protocol layer (`rpc-child.test.ts`, `child-runtime.test.ts`, `child-crypto.test.ts`, `child-envelope.test.ts`, `child-framing.test.ts`, `direct-dispatch-transport.test.ts`) using a fake child process port and fake clock, and an end-to-end fake-host layer (`child-mode.test.ts`, `delegation-controller.test.ts`, `delegation-tool.test.ts`) that fires real Pi lifecycle events against a recording fake host and asserts on the exact signed envelopes written to its output port. The direct-dispatch regression combines a Tapestry step, authenticated `delegate-request`, shared-controller relay, and correlated `delegate-response`; the control-body regression carries a real optional trigger `routing_hint` through strict bootstrap validation.

Private children are an implementation detail. Do not start Pi RPC mode to use Weave directly; public adapter operation is interactive TUI only.

## Approvals

Weave governs registered Pi and Weave-owned tools through input-aware permission requests. Approval choices may be once, current session, or reject. Durable project approval appears only after a trusted persistent Runtime Store is active. Policy `deny` always wins. Unresolved input can receive one-time approval only, and health-only mode never opens an approval dialog.

A changed tool input, stale or replayed permit, displaced tool owner, stale controller generation, resolver failure, or missing permission session blocks the call. Unregistered third-party tools remain under their owner's behavior and appear as unmanaged rather than allowed by Weave.

## Diagnostics, usage, and privacy

A recovery banner is informational. Only `/weave:resume` or an equivalent explicit palette action authorizes resume. Pi session entries are correlation pointers; the engine Runtime Store is authoritative.

Trusted healthy generations write bounded normalized events to the Runtime Journal and record one usage observation for each settled primary or child assistant message. Message identity, never message text, supplies the exact-once key. Configured journal and usage retention runs on activation and later safe write/time boundaries.

The adapter writes scoped pino records to `.weave/runtime/logs/pi-adapter.ndjson`. The engine sink holds no-follow directory and file identities, rotates only between records, prunes serially, and closes held handles at shutdown. Log, journal, usage, or retention failure produces one deduplicated TUI diagnostic and degrades telemetry without blocking ordinary activation.

Health output, journal entries, usage observations, and logs omit prompts, responses, transcripts, tool arguments/results, authorization constraints, plan/artifact contents, private paths, secrets, environment values, and RPC payloads. Include only sanitized `/weave:health` output when reporting an issue.

## Package proof

The public package build emits `dist/index.js` and Pi's `dist/extension.js`, preserves the supported host peer range and `pi.extensions` manifest field, and rejects lifecycle scripts, private dependencies, undeclared imports, or unexpected tar entries. It keeps `pino` and `kysely` external and declares both as direct runtime dependencies. This avoids Bun's `import.meta.require` CommonJS bridge in the compiled extension: Pi 0.81.1's `jiti/static` loader otherwise converts that bridge into a `data:` module that the compiled host rejects with `NameTooLong`. The clean-room package test rejects that bridge before importing the packed entry points. Release tests pack the staged files and load the tarball in an offline clean room with a fake `@earendil-works/pi-coding-agent@0.81.1` host. The package participates in the nightly release plan.

The exact-host compatibility matrix (`packages/adapters/pi/src/host-compatibility-matrix.ts`) is the single source-controlled record naming the host package, supported range, floor, and exact tested version (Spec 33 §22); `scripts/release/host-compatibility.ts`'s constants and the matrix can never drift apart because the matrix derives its range from the same constants at import time.

The acceptance manifest ([`docs/specs/33-spec-pi-adapter/acceptance-manifest.json`](../specs/33-spec-pi-adapter/acceptance-manifest.json)) traces every mandatory `PI-*` requirement to real named tests, packed proof, and live-smoke checklist items (`scripts/release/acceptance-manifest.ts` validates the schema, rejects duplicate/orphan/missing IDs, and verifies the named evidence exists and that the closed sets it claims (19 capability IDs, 9 direct commands plus 3 command classifications, 10 lifecycle operations, 11 private control envelope/reply kinds, 3 permission-gate outcome kinds, 3 plan-task markers, artifact-approval actor kinds plus reconciliation authorization sources, host package/floor/ceiling boundary tokens, and every failure code/impact/recovery value) are exhaustive, and rejects any packed-proof or live-smoke evidence entry that exists but is never referenced by a requirement row). `scripts/release/generate-acceptance-manifest.ts` regenerates it from a real local pack digest and the current git HEAD — never a fabricated digest.

All 23 rows in the digest-bound live TUI smoke checklist ([`33-smoke-checklist.md`](../specs/33-spec-pi-adapter/33-smoke-checklist.md)) passed against Pi `0.81.1`. The exact package digest, source revision, run attempt, host version, and checklist version are recorded in the checklist and [`acceptance-manifest.json`](../specs/33-spec-pi-adapter/acceptance-manifest.json). See the [`Task 12 proof`](../specs/33-spec-pi-adapter/33-proofs/33-task-12-proofs.md) for the live findings and final verification.
