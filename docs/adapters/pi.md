# Pi Adapter Guide

**Status:** Planned contract; do not treat this guide as release proof

**Related:** [Pi adapter architecture](../pi-adapter.md) · [Spec 33](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md) · [Adapter readiness](../adapter-readiness-status.md)

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

## Delegation limits

Project settings define finite child, concurrency, depth, and process limits. Agent overrides may narrow direct-child and concurrency limits only. The adapter queues within those limits and fails closed when live count state is unavailable.

Private children are an implementation detail. Do not start Pi RPC mode to use Weave directly; public adapter operation is interactive TUI only.

## Approvals

Weave governs registered Pi and Weave-owned tools through input-aware permission requests. Approval choices may be once, current session, durable project approval, or reject, subject to policy and request type. Policy `deny` always wins. Unresolved input can receive one-time approval only.

Unregistered third-party tools remain under their owner's behavior and appear as unmanaged rather than allowed by Weave.

## Recovery and privacy

A recovery banner is informational. Only `/weave:resume` or an equivalent explicit palette action authorizes resume. Pi session entries are correlation pointers; the engine Runtime Store is authoritative.

Health output and logs omit prompts, responses, tool arguments/results, authorization constraints, secrets, and RPC payloads. Include only sanitized `/weave:health` output when reporting an issue.
