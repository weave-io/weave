# Pi Adapter Architecture

**Status:** Package and activation foundation implemented; full projection and runtime proof pending

**Related:** [Spec 33 — Full-readiness Pi adapter](specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Spec 34 — Harness-neutral permissions](specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md) · [Adapter Boundary](adapter-boundary.md) · [Pi operator guide](adapters/pi.md) · [Adapter Readiness](adapter-readiness-status.md)

## Purpose

`@weaveio/weave-adapter-pi` projects normalized Weave configuration and lifecycle decisions into interactive Earendil Works Pi TUI sessions. The package is a Pi extension. Public print, text, JSON, RPC, and SDK operation are out of scope. The adapter may start private authenticated RPC children for delegation and direct workflow steps.

## Implementation status

The implementation lives in [`packages/adapters/pi`](../packages/adapters/pi). It provides the compiled Pi extension entry, exact host compatibility checks, a read-only safe initializer, generation-scoped controllers, normalized effective-capability health reports, health-only command gating, and an isolated recording fake host. The fake-host suite proves load-time inertness, command ownership checks, stale-generation rejection, trust withholding, and the exact 19-probe report shape without starting Pi.

The adapter now also loads the permitted normalized config, consumes successful materialized descriptors in plan order, reports isolated descriptor errors, and activates valid Loom state on the first `before_agent_start` event. That event supplies Pi's loaded skill catalog; the adapter resolves requested skills exactly, applies deterministic model intent against `ctx.modelRegistry.getAvailable()`, appends one delimited `composedPrompt` block without replacing Pi or other-extension context, and reports deduplicated model or temperature degradation. Model application and prompt authority recheck the controller generation after asynchronous host work.

Registered-tool enforcement, delegation transport, workflow lifecycle projection, packed-consumer proof, and live TUI evidence remain pending. These implemented slices are not a full-readiness claim.

## Activation model

Package load is inert: the extension factory constructs a controller, registers composable lifecycle/event delegates, and registers exact direct command shells behind an inactive generation gate. Pi registration returns no receipt, so activation inspects `getCommands()` provenance and numeric suffixes instead of assuming success. The factory does not register Weave tools, shortcuts, or renderers and does not initialize the project, probe resources, open state, or start services.

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
- `/weave:abort`, `/weave:advance`, `/weave:resume` — explicit lifecycle actions.

Only an explicit user start or resume authorizes work. Session start, idle, settlement, recovery discovery, and ordinary chat never start or resume durable execution.

## Health-only mode

Static capabilities are ceilings. Activation probes all 19 capability IDs once; 12 are required and 7 are optional under Spec 33. A missing, failed, degraded, or unsupported required effective capability enters health-only mode. Optional gaps warn. The adapter still exposes health and safe diagnostics but blocks materialization, workflow mutation, delegation, and governed registered-tool execution.

## Private children

Delegated agents run as ephemeral `pi --mode rpc --no-session` children. Each child authenticates with an independent 256-bit secret and HMAC-SHA-256 envelopes over strict line-delimited JSON. Sequence and nonce checks prevent replay. Children are inspectable and cancellable, not steerable. Public user-started RPC mode does not activate this path.

## Data handling

The adapter uses scoped pino logs and bounded sanitized Runtime Journal observations. It never logs or persists prompts, responses, transcripts, raw RPC, tool input/output, normalized authorization constraints, approval material, environment values, or child secrets.

Harness session entries hold correlation-only recovery pointers. They do not authorize resume. Engine Runtime Store state and explicit user intent remain authoritative.

## Proof standard

Automated tests use fake Pi hosts, injected process/RPC ports, in-memory stores, and narrow Bun filesystem conformance tests. They do not start Pi or mutate developer state. Release readiness also requires a clean packed consumer test and digest-bound stable TUI smoke evidence described by Spec 33's acceptance manifest.
