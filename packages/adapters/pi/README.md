# @weaveio/weave-adapter-pi

Pi adapter for the Weave orchestration framework. Targets the Earendil Works
Pi fork (`@earendil-works/pi-coding-agent`, `>=0.81.1`) in interactive
TUI parent sessions only.

Install as a Pi package:

```bash
pi install npm:@weaveio/weave-adapter-pi
```

The adapter has no maximum Pi version, but its runtime is Bun-only. The Pi
launcher must expose Bun built-ins such as `bun:ffi` and `bun:sqlite` to
extensions. If a compiled Pi launcher loads extensions through a Node-like
runtime, run the same installed Pi CLI under Bun instead:

```bash
bun /path/to/@earendil-works/pi-coding-agent/dist/cli.js
```

A local `pi` wrapper may execute that command so normal `pi` invocations keep
working. This is a launcher requirement, not a second wrapper extension.

See `docs/adapters/pi.md` in the Weave
repository for the full normative contract this package implements.

## Status

This package currently ships the activation, normalized-configuration,
delegation-transport, workflow-lifecycle, diagnostics, and public-packaging
slices:
exact host checks,
trust-aware safe initialization, effective capability health reporting, ordered
agent materialization, Loom primary activation, exact composed-prompt append,
Pi-owned skill/model context, and deterministic model intent. The adapter does
not map or enforce Weave `tool_policy`. It does not intercept tool calls or open
Weave approval prompts; Pi and each concrete tool owner keep control.

The adapter also ships a bounded `weave_delegate` tool and its private
authenticated child transport: an engine-resolved per-agent budget authorizes,
FIFO-queues, or denies each delegation request; an authorized request spawns
an independent `pi --mode rpc --no-session` child over a signed,
replay-resistant channel and bootstraps its exact composed prompt and resolved
model. Nested delegation from a live child is
restricted to that child's own declared delegation targets. The callable tool
keeps the protocol name `weave_delegate`, while Pi's custom transcript renderer
shows the called agent (`Pattern`, `Shuttle`, `Infra-Shuttle`, and so on).
Running children push bounded partial results into the tool entry; expanding it
with Pi's normal tool-expansion control reveals the latest streamed output. A
completed child's settlement summary is its own bounded real assistant output,
not a placeholder. See
[`docs/adapters/pi.md`](../../../docs/adapters/pi.md#delegation) in the Weave
repository for the full delegation contract, including a documented
limitation of Pi's `agent_settled` event (no payload).

The native `/weave` palette and nine direct commands project all ten engine
lifecycle operations. Explicit starts and resumes require fresh confirmation.
Workflow steps run in distinct authenticated direct-step children, and only the
root step child receives the `weave_complete_step` tool. The adapter
also projects revisioned plans, digest-bound artifacts and approvals, recovery,
reconciliation, parent-chat pause handling, and trusted no-follow Runtime Store
persistence.

Diagnostics project bounded, redacted Runtime Journal events and exactly-once
primary/child usage observations, run configured retention at safe boundaries,
and write through a no-follow rotating pino sink. Before session activation,
the adapter redirects the shared engine/config pino destination away from Pi's
stdout to `.weave/weave.log` (or the explicit `WEAVE_LOG_FILE` destination), so
internal JSON logs never appear in the harness transcript. Runtime telemetry
continues to use `.weave/runtime/logs/pi-adapter.ndjson`. Telemetry failures
degrade visibly without blocking activation or recursing through a failed sink.

The public build emits both documented entry points, validates the staged npm
manifest and tar inventory, and passes an offline clean-room consumer against a
fake exact-version Pi host. The package is integrated into the nightly release
plan. The complete acceptance manifest and digest-bound stable interactive TUI
smoke evidence remain pending release gates.

### Peer dependencies

`@earendil-works/pi-ai` and `@earendil-works/pi-tui` are required (not
optional) peer dependencies. The delegation tool's parameter schema imports
`StringEnum` from `@earendil-works/pi-ai` and `Type` from `typebox`
(a direct dependency), and the child-tree keyboard controls import
`matchesKey` from `@earendil-works/pi-tui` — both are genuine, unconditional,
top-level imports in shipped production code, not optional integrations.
