# Pi Adapter Guide

**Status:** Activation, normalized configuration, tool policy, and delegation transport implemented; do not treat this guide as release proof

**Related:** [Pi adapter architecture](../pi-adapter.md) · [Spec 33](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Adapter readiness](../adapter-readiness-status.md)

## Current implementation

The implemented package in [`packages/adapters/pi`](../../packages/adapters/pi) registers inert command shells and session delegates, then uses exact host, TUI, trust, command-ownership, candidate-plan, and capability probes to create a generation-scoped controller. Failed required probes or withheld trust keep the extension in health-only mode.

For supported sessions, the adapter loads the permitted Weave config, consumes materialized descriptors in stable plan order, and prepares Loom as the ordinary primary. On the first `before_agent_start`, it uses Pi's loaded skill catalog and authenticated model registry to resolve Loom's exact skill and ordered model intent. It applies a resolved model through Pi, preserves model fallback as a visible degradation, and appends Loom's final `composedPrompt` once to Pi's existing prompt. Declared temperature remains ignored and appears as a deduplicated health warning.

The adapter also governs discovered Pi-native tools through input-aware resolvers and the engine permission session. It checks exact built-in provenance, sealed registry coverage, and controller generation before each call. Policy `deny` blocks, `allow` consumes a single-use permit without prompting, and `ask` opens a bounded approval dialog only outside health-only mode. Missing or malformed resolver input is unresolved and supports one-time approval only. Unrelated third-party tools remain unmanaged.

The adapter also ships a bounded `weave_delegate` tool and its private authenticated child transport (see [Delegation](#delegation) below). Workflow lifecycle projection, packaging proof, and live TUI validation remain pending.

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

Session start, idle, recovery discovery, and normal chat do not authorize workflow work. The adapter continues automatically only when the engine returns a next effect in the same uninterrupted authorized controller generation.

## Health-only mode

If `/weave:health` reports health-only mode, the adapter blocks work but keeps diagnostics available. Common causes include:

- wrong Pi package identity or unsupported version;
- a missing required host hook or RPC capability;
- unreadable or invalid Weave configuration;
- permission, Runtime Store, plan, or artifact provider failure;
- a required capability probe reporting degraded or unsupported.

Fix the reported cause and start a new Pi session. Do not bypass health-only mode by calling private extension APIs.

## Delegation

`weave_delegate` runs one bounded task on a single eligible agent as a private ephemeral child, then returns that child's own structured result. It never creates or advances workflow state (that is a distinct, later port).

**Exact command.** A delegated child is spawned as `pi --mode rpc --no-session`, never as an interactive session. This is the only Pi RPC entry point the adapter uses; a real user never starts this path themselves.

**Auth and framing.** Each child receives an independent, process-scoped 256-bit secret over its environment (read once, then erased from the child's own environment on first use) and proves possession with an HMAC-SHA-256-signed handshake before either side accepts anything else. Every subsequent control envelope (`bootstrap`, `bootstrap-ack`, `cancel`, `settled`, `cancelled`, `error`, `approval-request`/`-response`, `delegate-request`/`-response`) is signed the same way, carries a monotonic per-direction sequence number and a random nonce, and travels as one strict line-delimited JSON object per line over the child's stdio. Malformed, unsigned, replayed (repeated nonce or non-increasing sequence), or unauthenticated lines fail closed and the runtime disposes itself rather than guessing intent.

**Queues and budgets.** Project settings (and narrower per-agent overrides, direct-child and concurrency limits only) define finite direct-child, concurrency, depth, and global live-process limits, resolved per requesting agent. A request that exceeds direct-child, concurrency, or depth limits is denied immediately; a request within the per-parent direct-child limit but currently over the concurrency or process ceiling queues in FIFO order per parent and is promoted automatically as capacity frees up. The controller fails closed (denies) whenever live count state cannot be resolved, rather than guessing a lower bound.

**Nested relay.** A live child may itself request delegation (its own `weave_delegate` tool, wired the same way as the root's). The parent-side controller restricts any such nested request to that exact child's own declared `delegationTargets` from its bootstrap descriptor — a child can never delegate to an agent its own bootstrap did not name. Every child's own governed tool-call approvals (including a nested child's) relay through the single parent TUI, tagged with the originating child's id, never a nested/child-local approval UI.

**Cleanup.** Cancelling a node cancels that node and every descendant, including not-yet-spawned queued requests under that subtree. A live child is asked to cancel cooperatively (signed `cancel` envelope, then a raw abort command), bounded by a grace period; if it does not exit in time it is force-killed. Process exit while a cancel is outstanding is treated as the expected outcome, not an unexpected exit. Every child's secret is zeroed and its resources released exactly once (idempotent), whether it settles, fails, or is cancelled.

**Active tool/model/context bootstrap.** The parent sends the new child exactly one signed `bootstrap` control envelope containing its resolved agent name, composed prompt, ordered model preference list (plus a parent-resolved model directly, for a root-level delegation with a live model registry), effective tool policy, its own eligible `delegationTargets`, delegation context (parent agent name, parent depth, cwd), and the exact active-tool name list the child must apply. The child validates the bootstrap's `correlationId` against its own authenticated identity, applies the exact active-tool set via the host's `setActiveTools`, resolves a model (using the parent-resolved model if present, else resolving against its own catalog), and only signals readiness (`bootstrap-ack`) after every step succeeds — any failure disposes the child without ever partially applying a bootstrap.

**Tree controls.** The parent renders a live child tree widget and supports direct keyboard navigation over it: Alt+1 through Alt+9 select a direct child by spawn order, Backspace selects the parent (host default at the root), and Esc requests cancellation of the selected node (host default at the root). `/weave:abort` cancels the full owned execution child tree from the palette.

**Limitations.** Pi's `agent_settled` event carries no payload (`{"type":"agent_settled"}` only) — a child cannot read a stop/error signal directly off it. The adapter instead tracks the most recently observed assistant `stopReason` (`stop`/`length`/`toolUse`/`error`/`aborted`) from `message_end` events and derives a `failed` outcome only when that value is `"error"` or `"aborted"`; every other case (including no observed stop reason at all) reports `completed`. A child never reports `completed` once its own cancellation has been admitted, closing the only remaining race between a stray settlement and an already-sent cancellation. A completed child's settlement summary is its own bounded (<=4KiB, valid UTF-8) final assistant output, truncated at a UTF-8 code-point boundary; a fixed fallback string is used only when a completed turn produced no observable assistant text.

**Tests.** Delegation is exercised at three layers with no real Pi process, secret material, or filesystem I/O: pure control-body/limit unit tests (`child-control-bodies.test.ts`, `strict-json.test.ts`), an injected-port parent/child protocol layer (`rpc-child.test.ts`, `child-runtime.test.ts`, `child-crypto.test.ts`, `child-envelope.test.ts`, `child-framing.test.ts`) using a fake child process port and fake clock, and an end-to-end fake-host layer (`child-mode.test.ts`, `delegation-controller.test.ts`, `delegation-tool.test.ts`) that fires real Pi lifecycle events against a recording fake host and asserts on the exact signed envelopes written to its output port.

Private children are an implementation detail. Do not start Pi RPC mode to use Weave directly; public adapter operation is interactive TUI only.

## Approvals

Weave governs registered Pi and Weave-owned tools through input-aware permission requests. Approval choices may be once, current session, or reject. Durable project approval appears only after a trusted persistent Runtime Store is active. Policy `deny` always wins. Unresolved input can receive one-time approval only, and health-only mode never opens an approval dialog.

A changed tool input, stale or replayed permit, displaced tool owner, stale controller generation, resolver failure, or missing permission session blocks the call. Unregistered third-party tools remain under their owner's behavior and appear as unmanaged rather than allowed by Weave.

## Recovery and privacy

A recovery banner is informational. Only `/weave:resume` or an equivalent explicit palette action authorizes resume. Pi session entries are correlation pointers; the engine Runtime Store is authoritative.

Health output and logs omit prompts, responses, tool arguments/results, authorization constraints, secrets, and RPC payloads. Include only sanitized `/weave:health` output when reporting an issue.
