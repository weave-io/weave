# Spec 33 — Full-readiness Pi adapter


**Status:** Accepted — normative implementation contract (live review, 2026-07-22)

**Decision ticket:**[Draft and validate the Pi adapter implementation specification](https://github.com/weave-io/weave/issues/129)

**Parent map:**[Specify a full-readiness Pi adapter for the Earendil Works fork](https://github.com/weave-io/weave/issues/121)

**Implementation handoff:**[[adapter-pi] HarnessAdapter implementation](https://github.com/weave-io/weave/issues/21)

## 1. Purpose


This spec defines a full-readiness `@weaveio/weave-adapter-pi` for interactive TUI sessions in the Earendil Works Pi Coding Agent fork. It turns normalized Weave configuration into a native Pi package and extension while preserving the engine/adapter boundary.

The adapter is ready only when every required capability is native or behaviorally equivalent through emulation, the packed artifact passes the acceptance manifest, and a stable release has digest-bound live TUI evidence.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 2. Authority and evidence


Implementation MUST follow these sources in descending order:

1.   this accepted spec and its linked cross-layer ADRs;
2.   `docs/product-vision.md`, `docs/adapter-boundary.md`, and current engine types;
3.   the accepted decisions linked in §27;
4.   Earendil Works Pi `0.81.1` public extension/package/RPC contracts;
5.   reference adapter behavior where it does not conflict with the sources above.

OpenCode and Claude Code are evidence, not implementation templates. Prompt-only commands do not prove durable execution. The bundled Pi subagent and plan-mode examples prove mechanisms only; they do not define Weave state, policy, or completion semantics.

## 3. Scope


### 3.1 In scope


*   Earendil Works `@earendil-works/pi-coding-agent` only.
*   Host versions `>=0.81.1 <0.82.0`.
*   Interactive Pi TUI parent sessions.
*   One globally installed Pi package with one compiled extension entry.
*   Agent materialization, primary selection, skills, model intent, tool policy, categories, review variants, delegation, workflows, lifecycle projection, plans, artifacts, recovery, diagnostics, usage, capabilities, packaging, and release evidence.
*   Private RPC child processes used internally for delegated work.
*   Small harness-neutral core/config/engine changes listed in §20.

### 3.2 Out of scope


*   Public support for Pi print, JSON, RPC, headless, or SDK embedding modes.
*   Upstream `@mariozechner/pi-coding-agent` compatibility.
*   Pi fork changes.
*   A Weave CLI installer.
*   File watching or automatic config reload.
*   Multiple active repository workflows.
*   Eval integration or a full analytics dashboard.
*   Steering delegated children.
*   Automatic work resumption across controller generations.

Private child RPC is an internal transport and does not expand public runtime-mode support.

## 4. Durable documentation split


The implementation MUST use **one Pi adapter spec plus focused cross-layer ADRs**. One monolithic spec without ADRs is rejected because several decisions change portable Weave contracts and would otherwise look Pi-specific.

### 4.1 Canonical artifacts


1.   `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` — this normative end-to-end Pi contract and acceptance matrix.
2.   `docs/adr/0008-portable-delegation-budgets.md` — why delegation limits are product intent rather than Pi process constants.
3.   `docs/adr/0009-input-aware-tool-permission-authorization.md` — why normalized requests, approval grants, challenges, and single-use permits replace one-capability `beforeTool` evaluation.
4.   `docs/adr/0010-plan-state-and-artifact-approval-authority.md` — why Plan Markdown is authoritative, why task updates use revisioned transitions, and why artifact approval accepts user and agent actors.
5.   `docs/adr/0011-effective-adapter-readiness-and-runtime-observability.md` — why static capability claims are ceilings and why usage, retention, and bounded logs are engine-owned portable contracts.

The accepted prototype reserved 0007–0010. ADR 0007 landed before check-in, so this durable contract preserves the four titles at the next free numbers, 0008–0011.

### 4.2 Normative cross-layer updates


ADRs explain decisions but do not replace contracts. Implementation MUST also update:

*   Spec 07 for effective probe-lowered readiness;
*   Spec 12 for usage observations, rollups, retention, and journal pruning;
*   Specs 13 and 22 for permission compatibility, generalized artifact actors, and reconciliation inputs;
*   Spec 19 for revisioned plan snapshots and transitions;
*   `docs/dsl-reference.md` for delegation and runtime retention fields;
*   a new numbered harness-neutral permission spec immediately after Spec 33;
*   `docs/adapter-boundary.md`, `docs/adapter-readiness-status.md`, and related guides.

Pi names, commands, event names, process details, and TUI behavior MUST remain in Spec 33 and Pi guides, not in harness-neutral contracts.

## 5. Package and public surface


Create `packages/adapters/pi` named `@weaveio/weave-adapter-pi`.

The package MUST:

*   publish as a public Pi package;
*   include `keywords: ["pi-package", ...]`;
*   declare `pi.extensions: ["./dist/extension.js"]`;
*   expose `.` as the testable controller/service library;
*   expose `./extension` with exactly one default extension factory;
*   depend on Weave core/config/engine at runtime;
*   declare `@earendil-works/pi-coding-agent` as an unbundled peer at `>=0.81.1 <0.82.0`;
*   declare any imported Pi-provided package as an unbundled `"*"` peer;
*   contain no install lifecycle scripts;
*   exclude source maps, tests, fixtures, private paths, and unneeded source from the tarball.

Canonical installation is:

```shell
pi install npm:@weaveio/weave-adapter-pi
```

Updates and removal use Pi's native package commands. Installation documentation MUST warn that Pi packages run with full process and filesystem authority and link to source and the security model.

## 6. Component model


The package MUST use classes with injected dependencies and no mutable module globals.

Required production components:

*   `PiExtensionController` — one controller generation; owns Pi wiring, active state, commands, effects, and cleanup.
*   `PiSafeInitializer` — read-only host, mode, trust, dependency, and capability probes.
*   `PiConfigActivator` — loads permitted Weave config and materializes descriptors.
*   `PiPrimarySession` — atomic primary activation, prompt append, model, tools, and restoration.
*   `PiSkillCatalog` and `PiModelResolver` — Pi-owned discovery context and deterministic matching.
*   `PiPermissionBridge` — concrete tool registrations, interception, approval UI, and permit consumption.
*   `PiDelegationController` — budgets, queue, child tree, cancellation, and normalized delegation results.
*   `PiRpcChild` and `PiPrivateControlChannel` — LF-framed RPC and authenticated adapter-private control.
*   `PiWorkflowController` — command operations, ten lifecycle projections, effect application, and recovery.
*   `PiPlanProvider` — Pi package wrapper around the revisioned Bun filesystem provider.
*   `PiArtifactProvider` — safe project-relative reads and SHA-256 digests.
*   `PiUsageCollector`, `PiDiagnostics`, and `PiHealthPresenter`.

Framework factories and callbacks MAY return Pi-required shapes. Every fallible internal method MUST return `Result` or `ResultAsync` with closed domain errors. Third-party throwers and rejected promises MUST be wrapped at the boundary.

## 7. Initialization, trust, and controller generations


### 7.1 Extension factory


The extension factory MUST only:

1.   construct `PiExtensionController` with explicit dependencies;
2.   register lifecycle/event delegates and the exact direct command shells once;
3.   bind command shells to an inert generation gate that exposes no work before activation;
4.   return control to Pi.

Pi command registration returns `void`. The adapter MUST NOT invent a registration receipt. At `session_start`, it calls `pi.getCommands()` and verifies that every required command has one unsuffixed invocation whose `sourceInfo` identifies this package and that no same-base suffixed entries exist. Pi's documented duplicate-command behavior preserves every colliding command under numeric suffixes; Weave then enters health-only mode and shows the collision through an always-available startup status/widget rather than depending on the collided health command.

The factory MUST NOT register Weave-owned tools, global shortcuts, message renderers, or entry renderers. During trusted ready activation, the controller registers a Weave-owned tool only after `pi.getAllTools()` proves its name free, then immediately re-reads provenance to verify ownership before enabling it. It governs built-in tools through `tool_call` interception and never overrides them. It implements child-tree keys through a compositional editor wrapper installed with `getEditorComponent()`/`setEditorComponent()`, not `registerShortcut()`. Diagnostics and child views use status/widgets/custom UI, so renderer collisions cannot displace another extension.

It MUST NOT load project config, open or migrate the Runtime Store, materialize descriptors, start timers, append session entries, capture a session context for later reuse, or launch a child.

`PiSafeInitializer` is a separate read-only phase. The factory may register delegates; safe initialization itself MUST NOT register them.

### 7.2 Session activation


`session_start` is the mutation and activation boundary. The controller MUST run this ordered preflight and activation sequence:

1.   create a fresh opaque generation ID;
2.   reject public operation unless `ctx.mode === "tui"`;
3.   verify host identity and version;
4.   read project trust from `ctx.isProjectTrusted()`;
5.   load builtin/global config and project config only when trusted;
6.   discover Pi skills, models, tools, command names, and required APIs through read-only Pi-owned context;
7.   call pure `materializeAgents({ config })` to build a candidate plan without registering or activating anything;
8.   build candidate descriptor and complete engine-owned command dispatch/permission-registry plans in memory;
9.   run all 19 read-only probes against `getCommands()` provenance, `getAllTools()` inventory, editor composition support, host context, and candidate plans, including exact command-collision and governed-tool coverage checks;
10.  build the effective health report and collect every `plan.errors` item;
11.  enter health-only mode without Runtime Store or harness mutation if any required effective capability fails;
12.  when trusted, open/migrate the Runtime Store; otherwise enter trust-withheld mode without reading or writing project paths;
13.  atomically bind the inert command/event shells to the new generation, register and provenance-verify only collision-free Weave-owned tools, install the compositional editor wrapper, activate the sealed permission registry, and build valid descriptor state in plan order;
14.  activate Loom when valid;
15.  reconstruct only correlation from the newest active-branch recovery pointer;
16.  start session-scoped services.

Steps 5–10 are `PiSafeInitializer` preflight. Pure descriptor composition and in-memory candidate planning are allowed; concrete harness materialization, callback registration, Runtime Store access, timers, and process launch are not. If mode, host identity, or trust blocks a later probe, the initializer still emits exactly one sanitized `unavailable` result for each unrun capability without touching the blocked resource. If state changes between a probe and step 13, activation fails closed and a fresh generation must probe again.

The generation gate rechecks required command/tool provenance and editor-wrapper identity at every authority-bearing boundary: before each direct command handler, palette action, event delegate that can perform or authorize work, agent start, and registered tool call. A later command registration that suffixes an active shell therefore blocks before start, resume, advance, abort, artifact approval, or any other mutation. Later displacement, suffixing, or bypass immediately blocks the operation and enters health-only mode. Weave never re-registers over a foreign owner.

A Runtime Store open or migration failure enters health-only mode. A Pi recovery pointer never authorizes work.

### 7.3 Trust behavior


*   Global installation is explicit opt-in to builtin/global Weave behavior.
*   Untrusted projects MUST withhold project `.weave` config and all project-local intent.
*   Before trust, the adapter MUST NOT read, create, migrate, or write `.weave/runtime/**`, project prompts, plans, artifacts, project skills, or any other project path.
*   The adapter MUST NOT pre-empt `project_trust` or grant trust.
*   An untrusted project enters trust-withheld mode, not health-only mode solely because trust is absent. Builtin/global descriptors may support ordinary prompt-only chat, but project-local and durable operations, delegation, registered capability-bearing tools, and artifact/plan access remain disabled with one explicit reason. Health and status remain available.
*   Capability probes that would touch project paths return `ok` only for the narrow fact that access was correctly withheld and attach a sanitized `project-trust-withheld` note. This does not authorize the disabled project operation or claim that the withheld resource itself was probed.
*   Health MUST state that project config and project state were withheld.
*   `/reload` plus a fresh `session_start` applies a changed trust or config snapshot; only the new trusted generation may access project paths.

### 7.4 Replacement and shutdown


Reload, new, resume, fork, and session replacement MUST create fresh Pi API/context/session bindings. Old generation state and messages MUST fail as `ControllerGenerationStale`.

`session_shutdown` MUST stop dispatch, terminate owned child trees, clear secrets, release transient handles, and clean up idempotently. It MUST NOT auto-resume or reuse stale objects.

## 8. Agent and prompt projection


### 8.1 Materialization


The adapter MUST consume every successful `MaterializationPlan.agents` item in order and report every `MaterializationPlan.errors` item.

*   `descriptor.name` is the stable identity.
*   `descriptor.composedPrompt` is final and MUST NOT be rebuilt.
*   Invalid descriptors are isolated.
*   Invalid Loom disables ordinary Weave chat but does not rename another agent Loom.
*   Invalid Tapestry disables plan orchestration only.
*   Invalid delegated targets are removed from eligible delegation views.
*   Disabled agents remain absent.
*   Explicit, category-shuttle, and review-variant source metadata remain distinct.

### 8.2 Active primary


The parent TUI has exactly one active primary descriptor:

*   Loom is the default ordinary primary.
*   Explicit plan start/resume activates Tapestry.
*   Plan exit restores the prior valid primary.
*   A user may select a valid `primary` or `all` descriptor while Pi is idle.
*   `all` descriptors remain eligible for both direct selection and delegation.
*   Category shuttles remain delegated subagents.

Primary activation MUST be atomic from the user's perspective: descriptor identity, prompt source, model intent, active registered tools, effective policy, skills guidance, status, and recovery correlation either all change or all remain at the prior valid state. Plan state, never prompt inference or category glob matching, controls Loom/Tapestry handoff.

### 8.3 Prompt append


On `before_agent_start`, append one clearly delimited Weave block containing the active descriptor identity and its exact `composedPrompt` to Pi's already chained system prompt.

The adapter MUST preserve Pi context, native tool/skill guidance, and other extensions' prompt changes. It MUST NOT replace the full prompt, append twice, or inject full skill files.

Delegated children receive their own descriptor prompt and no parent descriptor prompt.

## 9. Skills, models, and temperature


### 9.1 Skills


Pi owns skill discovery, trust, precedence, collisions, provenance, and progressive loading. The adapter supplies the effective Pi catalog to the engine's exact case-sensitive resolver.

*   Existing Pi skills remain available.
*   Requested non-disabled skills MUST resolve exactly.
*   A missing requested skill disables only that descriptor and appears in health.
*   Disabled requests are omitted under engine semantics.
*   Resolved metadata/path provenance MAY guide progressive loading.
*   Full `SKILL.md` content MUST NOT be injected eagerly.

### 9.2 Models


At each descriptor activation, resolve ordered model intent against authenticated Pi models:

1.   exact canonical `provider/id`;
2.   exact bare ID only when unique;
3.   exact human-readable name only when unique.

Skip unavailable entries. Do not fuzzy match. If none resolve, retain the current authenticated Pi model and lower effective model health to degraded for that descriptor.

A native user model change governs the current active period. The next primary handoff or explicit activation reapplies descriptor intent. Delegated children resolve their own descriptor intent, never the parent's temporary override.

### 9.3 Temperature


Until a stable probed Pi API exists, a declared temperature MUST be ignored with one deduplicated capability warning. The descriptor remains usable. The adapter MUST NOT emulate sampling through prompt prose or provider replacement.

## 10. Portable delegation limits


Add these DSL fields:

```
settings {
  delegation {
    max_children 9
    max_concurrency 3
    max_depth 3
    max_processes 9
  }
}

agent tapestry {
  delegation {
    max_children 3
    max_concurrency 3
  }
}
```

Defaults are exactly 9 direct children, 3 concurrent children per parent, depth 3 below root, and 9 live processes globally.

Validation MUST enforce:

*   positive integers;
*   `max_children` in `1..9`;
*   `max_concurrency <= max_children`;
*   agent overrides may narrow only `max_children` and `max_concurrency`;
*   overrides may not exceed project caps;
*   errors use precise schema paths.

Core owns syntax/schema; config owns merge; engine owns `EffectiveDelegationLimits` and an abstract `authorizeDelegation()` decision from adapter-supplied counts; Pi owns queues, process counts, spawn, and enforcement. Schema work requires schema/parser/validator/full-pipeline tests and DSL docs in the same commit.

## 11. Delegation and private children


### 11.1 Delegation entry


An eligible primary receives one Weave delegation tool whose targets come only from its normalized `delegationTargets`. Category patterns and triggers are selection guidance only. They never auto-launch or switch the parent.

Ordinary delegation returns a structured result to the invoking parent and never creates or advances workflow state. Direct workflow dispatch is a separate engine effect.

### 11.2 Child process


Each delegated or directly dispatched agent runs as ephemeral:

```shell
pi --mode rpc --no-session
```

`pi` here MUST be resolved through an injectable, Bun-compatible executable seam, never hardcoded inline at the spawn call site. Production MUST prefer the exact executable that launched the current Pi host process (read from the invoking shell's own `_` environment variable via the adapter's `PiEnvPort`) over a bare command name, because a bare-name spawn lets `PATH` order silently select an unrelated `pi` install (e.g. a different toolchain's shim) shadowing the real host, whose runtime then fails packed-extension import (`Cannot find module 'bun:ffi'`). The seam falls back to the bare command name - not yet a hard failure - only when `_` is absent, empty, or not an absolute path, so this is a best-effort mitigation, not a guarantee that a PATH-shadowed child can never be spawned in that fallback case. Tests MUST override the seam with a fixed command so `PATH` shadowing can never change what a test observes as the spawned command.

The adapter MUST pass the child's descriptor prompt, resolved model, active tool set, permission bridge, correlation, and bounded context. It MUST stream events, account usage, propagate abort, and clean all descendants. Any model identity placed in a bootstrap or bootstrap-ack control body MUST contain only `provider`/`id`/optional `name`; the strict schema rejects host-only fields. Before calling the child's `setModel()`, the adapter MUST resolve that compact identity to one exact full entry in the child's authenticated model catalog. Missing or duplicate entries fail closed.

The public adapter remains TUI-only. Child mode activates only after the controller handshake marker succeeds. User-started RPC sessions do not activate Weave child behavior.

The controller MUST NOT send RPC `steer` or `follow_up`. Children are inspectable and cancellable, not steerable.

### 11.3 Private control authentication


Each child gets an independent cryptographically random 256-bit secret in its environment, never argv or prompt. The child loads it into an erasable buffer, deletes the environment value, and proves possession before work.

Every private envelope MUST include:

*   schema version;
*   child ID and controller generation;
*   direction-specific monotonic sequence starting at `1`;
*   128-bit nonce;
*   request/reply correlation ID;
*   message kind and a body no larger than 64 KiB after canonical encoding;
*   HMAC-SHA-256 over deterministic canonical bytes.

Canonical bytes are UTF-8 [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) encoding of the complete envelope except the MAC field. Values outside the I-JSON domain, duplicate object keys, invalid Unicode, non-finite numbers, and integers outside the interoperable range are rejected before signing or verification. The MAC is lowercase hex over the exact canonical byte sequence; alternate serialization is never accepted.

Verification uses timing-safe comparison. Accept only the next valid sequence and an unused nonce. Missing, malformed, duplicate, replayed, late, cross-child, cross-generation, or invalidly signed messages stop the affected child operation. All settlement, timeout, abort, spawn-failure, and shutdown paths clear secret references.

Secrets and raw RPC payloads MUST NOT enter UI text, failures, logs, journals, Runtime Store, or Pi entries.

### 11.4 RPC framing


Parse strict LF-delimited JSON records. Handle split UTF-8 chunks, multiple records per chunk, optional CR before LF, and U+2028/U+2029 inside JSON strings. A complete RPC record, including its optional CR and required LF, may not exceed 1 MiB; a partial buffer that exceeds 1 MiB before LF stops the affected child. Invalid UTF-8 and duplicate JSON keys are rejected. Private control bodies retain the stricter 64 KiB canonical limit. Generic Unicode line readers are forbidden.

### 11.5 Child tree and controls


Show bounded child state: logical name, parent, status, current turn/tool, elapsed time, usage, and latest output truncated to 4 KiB of valid UTF-8 at a code-point boundary. The truncated view is transient and MUST NOT enter logs, journals, Runtime Store state, or recovery pointers.

*   Alt+1..Alt+9 selects a direct child of the selected node.
*   Backspace selects its parent; at root Pi keeps normal editor behavior.
*   Esc terminates the selected child subtree; at root Pi keeps normal Esc behavior.
*   `/weave:abort` controls whole-execution cancellation.

Cancelling an ordinary helper returns a structured cancelled result to its parent. Cancelling the direct workflow-step child calls `handleUserInterrupt(...pause)`, terminates that subtree, and leaves the step resumable.

## 12. Tool permission subsystem


### 12.1 Boundary


The engine owns normalized requests, effective-policy binding, grant state, approval challenges, and single-use permits. Pi owns concrete discovery, registrations, pure input resolvers, interception, approval UI/relay, permit consumption, and enforcement.

Every Pi-native and Weave-owned tool that can exercise `read`, `write`, `execute`, `delegate`, or `network` MUST have one authoritative registration and interception path before ordinary operation. The activation probe compares the discovered native/Weave-owned tool inventory with the sealed registry and interception coverage. Any missing, duplicate, or bypassable governed registration makes required tool-policy capability unavailable and enters health-only mode.

Only unrelated third-party extension tools may remain unregistered. They are `unmanaged`: preserve their owner's behavior, issue no Weave permit, do not call them allowed, and identify their owner in bounded health output.

### 12.2 Engine public roles


The harness-neutral permission spec MUST define these exported roles:

*   `PermissionRegistryBuilder`;
*   immutable `PermissionRegistryGeneration`;
*   `PermissionSession`;
*   `PermissionApprovalRepository` on the Runtime Store.

A registration contains opaque runtime tool identity, owner identity, semantic revision, bounded display metadata, and a pure synchronous resolver returning `Result`.

Registry sealing is transactional. Duplicate concrete identity rejects the candidate generation. Replacement is idle-only and atomic, creates a new generation, and invalidates outstanding challenges and permits.

Concrete Pi registered-tool executors MUST mirror the host's five-argument ABI: `(toolCallId, params, signal, onUpdate, ctx)`. Adapter code that needs session context reads only the fifth argument; treating the abort signal as context corrupts delegation and other context-bound calls.

### 12.3 Normalized requests and evaluation


A grantable request contains capability, stable operation, canonical target, optional canonical bounded constraints, and sanitized display. The engine computes authorization identity; display never affects authorization.

A resolver may return explicit non-grantable `unresolved`. It asks every call, cannot create reusable grants, degrades health, and blocks without UI. Resolver error, throw, empty output, invalid output, or unsafe input is a typed failure and creates no challenge.

For every registered call, the engine MUST:

1.   resolve, validate, and deduplicate requests;
2.   evaluate all requests under the session-bound agent policy;
3.   let `deny` win;
4.   satisfy `allow` without grants;
5.   use matching grants only for `ask`;
6.   authorize only when every request is satisfied.

Outcomes are `unmanaged`, `denied`, `approval_required`, or `authorized`. Operational failures remain typed errors outside the outcome union.

### 12.4 Approval and permits


UI choices are allow once, allow for session, allow durably with optional expiry, and reject. The production permission session MUST bind the same trusted, opened Runtime Store instance used by workflow lifecycle and telemetry before it advertises durable approval; an in-memory fallback MUST omit that choice. Unresolved requests support only once or reject. Rejection does not persist hidden policy.

A permit is opaque, short-lived, single-use, and bound to project, session, agent, registry generation, policy fingerprint, normalized requests or unresolved call binding, exact intercepted call, expiry, and consumed state. Pi consumes it immediately before execution. Any changed input, identity, generation, policy, expiry, or replay blocks.

Grants are isolated by project, agent, owner/tool identity, semantic revision, policy fingerprint, request-schema version, and exact request digest. Policy deny always wins. Child approvals relay to the sole parent TUI but remain evaluated under child identity.

## 13. Workflow commands and authorization


Register `/weave` as a native action palette and these direct commands:

| Command | Required behavior |
| --- | --- |
| `/weave:start [plan]` | Select/name an existing plan and call explicit plan start. |
| `/weave:run [workflow]` | Select/name a configured workflow and call named workflow start. |
| `/weave:status` | Read-only execution and child status. |
| `/weave:abort` | Confirm, cancel execution, terminate full owned child tree. |
| `/weave:advance` | Apply explicit user confirmation only when the step allows it. |
| `/weave:health` | Render declarations, probes, compatibility, dependencies, and remediation. |
| `/weave:resume` | Explicitly recover a paused/recoverable execution. |
| `/weave:plan` | Show the full read-only nested task tree. |
| `/weave:artifact [approve|reject] [artifact]` | Decide a pending artifact revision as the user. |

The palette exposes the same actions and hides/disables invalid actions with a reason.

Only `/weave:start`, `/weave:run`, and their palette actions call `startExecution`, always with user authorization. Only `/weave:resume` and its palette action call `resumeExecution`, with fresh user authorization. Prompt text, delegation, tools, idle, session events, continuation, and recovery banners MUST NOT authorize start or resume.

Command collisions that prevent exact direct names are a required capability failure and enter health-only mode. Numeric collision suffixes are not accepted as readiness for these commands.

## 14. Ten lifecycle projections


| Engine operation | Pi projection |
| --- | --- |
| `observeSession` | Sanitized snapshots after authorized start/resume, primary/direct-step activation, meaningful settlement, idle, and termination while a lease is active. |
| `startExecution` | Explicit start/run command or palette only. |
| `resumeExecution` | Explicit resume command or palette only. |
| `handleUserInterrupt` | Abort→cancel; confirmed parent-chat interruption or Esc on direct-step child→pause. |
| `dispatchStep` | Supply context, pinned revisions, and adapter-computed digests; project returned effects only. |
| `completeStep` | After one valid structured candidate and `agent_settled`; include plan provider when required. |
| `beforeTool` | Compatibility wrapper over the general permission session for workflow-governed registered calls. |
| `inspectExecution` | Status, palette, recovery banner, artifacts, widgets; always read-only. |
| `approveArtifact` | Explicit user artifact action or authorized structured review/security verdict with generalized actor. |
| `reconcileExecution` | Digest/plan mismatch, user revision request, review rejection, or security rejection with the matching source. |

The adapter MUST apply each returned effect exactly once and must not infer an effect from Pi events or prose.

After `completeStep`, automatic next-step dispatch is allowed only when the engine returns that effect within the same uninterrupted authorized generation.

If a normal parent prompt arrives while a workflow child is active, ask whether to pause. On confirmation, pause and cancel the direct-step subtree before delivering the prompt to Loom. On rejection, keep the workflow running and do not submit the prompt. Concurrent parent chat and workflow mutation are forbidden.

## 15. Structured completion


Direct workflow-step children receive `weave_complete_step`. Its closed input contains outcome, completion method, review verdict, bounded message, declared artifact references, and optional next-step hint.

The tool records one candidate; it does not advance state. The controller waits for Pi `agent_settled`, then validates the candidate and calls `completeStep`.

*   Process exit or free-form prose is never success.
*   Missing, duplicate, malformed, rejected, or late candidates are typed operation failures.
*   Nested helper children do not receive workflow completion authority.
*   Retry, compaction, and queued continuation before `agent_settled` do not settle the step.

## 16. Revisioned plan state


Plan Markdown is the sole durable task source. Extend `PlanStateProvider` with:

```ts
readSnapshot(planName): ResultAsync<PlanTaskSnapshot, PlanStateError>
applyTransition(input: PlanTaskTransition): ResultAsync<PlanTaskSnapshot, PlanStateError>
```

`planExists` and `isPlanComplete` remain projections of parsed state.

A snapshot includes plan name, content revision, format (`canonical` or `legacy`), ordered parents/children, visible task IDs, titles, states, total parent count, and derived completion.

Canonical plans allow two checkbox levels only:

```md
- [ ] 1. First parent task
  - [ ] a. First subtask
  - [-] b. Second subtask
- [x] 2. Second parent task
```

Task IDs are visible (`1`, `1.a`). Markers map to pending, in-progress, completed. Parent state derives from children. Completion means every leaf is completed.

Allowed leaf transitions are pending→in-progress→completed and explicit coordinator retry in-progress→pending. Completed leaves are terminal. The authorized plan coordinator, Tapestry by default, is the only actor that receives transition authority. Helpers return evidence and cannot mutate or self-certify tasks.

The provider MUST use safe names, expected-revision compare-and-swap, Bun I/O, and atomic replacement in the same verified directory. Lexical validation alone is insufficient. The provider MUST resolve from a canonical trusted project root, reject a symlink in the plans directory or any plan path component, and perform read/compare/write against the same no-follow file identity. If the platform/provider cannot prove no-follow containment and same-target replacement, plan mutation is unavailable and fails closed. Stale revisions or target-identity changes fail closed. Reading never rewrites. Noncanonical but unambiguous plans are `legacy`, read-only until a deliberate transition uses expected revision, and lower health. Malformed/ambiguous trees return typed parse errors.

The compact widget shows `Task N of M`, previous/current/next parent, all current subtasks, and badges other active parent IDs. `/weave:plan` shows the full read-only tree. Pi never toggles tasks directly.

## 17. Artifacts and approval actors


Artifact completion inputs carry logical identity and safe project-relative paths. Pi validates lexical containment and then resolves from a canonical trusted project root through an injected provider. The provider MUST reject absolute paths, `..`, symlinked path components, non-regular files, target-identity changes, and any resolved target outside the canonical root. It hashes bytes from the same no-follow handle used for the approved read; a path check followed by an unrelated reopen is forbidden. If containment or stable identity cannot be proved, the read fails closed. Pi passes references/digests to the engine. The Runtime Store keeps refs, revisions, approval, provenance, and digests, never contents.

Before dispatch, recompute required digests and pass pinned revisions. Mismatch fails closed and invokes `reconcileExecution` with `execution-mismatch`; never silently rebind.

Replace `approverAgent` with:

```ts
type ArtifactApprovalActor =
  | { kind: "user"; provenance: SafeMetadata }
  | { kind: "agent"; agentName: string; gate: "review" | "security" };
```

User decisions originate only in `/weave:artifact` or its palette. Agent decisions originate only from the authorized structured gate. Producing agents cannot approve their own revision. The engine owns actor validation, self-approval prevention, revision binding, and approval state.

## 18. Recovery and persistence


The engine Runtime Store under `.weave/runtime/**` is authoritative. It may open only after project trust. The runtime provider acquires and holds no-follow handles for the canonical project root and runtime directory, creates or opens the database and SQLite sidecars relative to that stable directory identity, rejects symlinked or replaced components, and revalidates file identity across migration/commit. A path check followed by an unrelated reopen is forbidden. Files use restrictive permissions. Inability to prove containment and stable parent/target identity enters health-only mode. Pi JSONL entries hold correlation only.

After a matching Runtime Store commit succeeds, append:

```ts
interface PiWeaveRecoveryPointerV1 {
  schemaVersion: 1;
  workflowId?: string;
  leaseId?: string;
  controllerGeneration: string;
  planName?: string;
  planRevision?: number;
  status: "recoverable" | "terminal";
  observedAt: string;
}
```

`planName` and `planRevision` appear together. The active branch's newest valid pointer is compared with Runtime Store state; Runtime Store always wins. Missing pointers are harmless. Malformed, unknown-version, stale-generation, or mismatched pointers produce one deduplicated diagnostic and no work.

Pointer append failure degrades telemetry after the authoritative commit; it MUST NOT roll back or repeat that commit.

Restart, reload, switch, fork, shutdown, or lease loss stops dispatch and shows recovery. Inspection/observation may run, but only explicit resume reacquires and continues. Parent compaction alone does not pause children or create a new authorization boundary.

## 19. Diagnostics, retention, and usage


### 19.1 Data ban


Raw prompts, completions, transcripts, child output, tool arguments, RPC/provider payloads, plan/artifact contents, secrets, private paths, and command/environment values are forbidden in pointers, Runtime Store metadata, journal, logs, usage, health, and public failures.

### 19.2 TUI, journal, and logs


TUI diagnostics deduplicate by failure code, scope, and safe correlation ID and expose exactly one primary action.

Pi emits normalized Runtime Journal families for activation/health, generations, probes, workflow/recovery/leases/effects, plans/completion/artifacts, child lifecycle/protocol/delegation/UI bridge, usage, retention, and telemetry degradation.

Use an engine-scoped pino child and `.weave/runtime/logs/pi-adapter.ndjson` with restrictive permissions. The sink acquires and holds a no-follow handle for the verified log directory, opens each segment relative to that stable parent identity, and binds rotation source/destination to verified no-follow file identities. It revalidates identities immediately before atomic same-directory replacement and rejects any symlink or swapped parent/target. A preliminary path check followed by reopen is forbidden. Rotate at record boundaries. Serialize rotation/pruning. Log failure must not recurse through the failed sink.

### 19.3 Runtime settings


Add:

```
settings {
  runtime {
    journal {
      strict false
      retention_days 30
      max_entries 10000
    }
    usage {
      detail_retention_days 30
      max_observations 100000
    }
    log {
      max_segment_bytes 5242880
      max_segments 3
    }
  }
}
```

Ranges are respectively 1..3650, 1..10,000,000, 1..3650, 1..10,000,000, 65,536..1,073,741,824, and 1..100. Values are bounded integers; no zero/unbounded mode exists.

Prune after activation and then after 256 relevant writes or 15 minutes. Remove by age, then oldest above count. Use one serialized single-flight task. Failure degrades and retries only at the next safe boundary. `journal.strict=true` makes only the correlated transaction fail/roll back.

### 19.4 Usage ledger


The Runtime Store MUST expose idempotent detailed observations and durable rollups. Pi records one observation per settled assistant message from primary or child; never session totals or tool-result usage.

Observation fields are ID, time, source, optional workflow/step/agent/model, optional non-negative token counters, and optional non-negative finite cost. Missing values remain absent. Identity derives from Pi message identity, never text.

Same ID plus same normalized values is a no-op. Same ID plus different values is an invariant breach. Insert and rollup are atomic. Rollups group by available workflow, step, agent, model, and source and sum each known field independently. Detail pruning does not subtract rollups.

## 20. Required harness-neutral changes


Implementation MUST land these as focused commits before or with the Pi modules that consume them:

1.   Delegation DSL, validation, defaults, merge, `EffectiveDelegationLimits`, and `authorizeDelegation`.
2.   Permission registry/session/repository, normalized requests, approvals, grants, challenges, permits, audit, and a workflow `beforeTool` compatibility path.
3.   Revisioned plan snapshots/transitions and atomic Bun provider behavior.
4.   `ArtifactApprovalActor` and approval validation.
5.   Runtime retention settings and journal pruning service.
6.   Idempotent usage observations/rollups/pruning.
7.   Probe-lowered effective capability contracts while preserving static declarations.
8.   Scoped rotating runtime pino sink.

No engine API may discover Pi resources, query Pi state, register Pi callbacks, spawn Pi, use Pi command/tool names, or render Pi UI.

## 21. Capabilities and health-only mode


Static declarations are ceilings:

*   required native: command entrypoints, token usage;
*   required emulated: config materialization, agent materialization, primary selection, delegated specialist execution, prompt composition, tool policy, workflow persistence, workflow step dispatch, plan compatibility, and event logging;
*   optional native: context-window monitor;
*   optional emulated: idle continuation, compaction recovery within one live generation;
*   optional degraded: analytics dashboard, static artifact generation;
*   optional unsupported: eval integration, multiple workflows.

Each generation MUST return exactly one sanitized probe for all 19 IDs. `ok` preserves the declaration, `degraded` lowers to degraded, and `unavailable` lowers to unsupported. Missing/failed probe is unavailable. A probe never raises readiness.

Any required effective degraded/unsupported result enters health-only mode. Optional gaps warn. Health-only mode disables start, run, advance, resume, dispatch, approval, and delegation; it preserves health, status, idempotent abort, and cleanup.

Read-only probes cover host/mode, trust/config readability, required APIs/events/commands, descriptor inputs, model/auth, skills, complete discovered Pi-native/Weave-owned tool inventory with sealed registration and interception coverage, child executable/extension presence without spawning, existing Runtime Store metadata without create/migration/write, plan prerequisites, usage fields, and optional dependencies. Candidate-plan probes may preserve delegated-specialist execution only when the sealed plan contains the governed `weave_delegate` registration. They may preserve event logging only when trusted Runtime Store containment proves the journal and rotating-log prerequisites before activation. Discovering any governed tool without one authoritative resolver and unavoidable interception lowers tool-policy capability to unavailable.

## 22. Host compatibility


One source-controlled compatibility record MUST name:

*   host package `@earendil-works/pi-coding-agent`;
*   range `>=0.81.1 <0.82.0`;
*   floor `0.81.1`;
*   exact release-tested version.

Unknown identity/version, upstream identity, or out-of-range version enters health-only mode before materialization or work. There is no force/ignore override.

## 23. Closed failure contract


Every controller/service failure uses:

```ts
type PiAdapterFailure = {
  code: PiAdapterFailureCode;
  phase:
    | "safe-init" | "activation" | "persistence" | "capability"
    | "child" | "protocol" | "lifecycle" | "completion"
    | "plan" | "artifact" | "telemetry" | "cleanup";
  scope:
    | { kind: "adapter" }
    | { kind: "execution"; id: string }
    | { kind: "step"; id: string }
    | { kind: "child"; id: string };
  impact: "health-only" | "operation-stopped" | "degraded";
  retryable: boolean;
  recovery:
    | "health-check" | "retry" | "resume" | "abort"
    | "upgrade" | "downgrade" | "none";
  safeMessage: string;
  correlation?: Record<string, string | number | boolean>;
};
```

`PiAdapterFailureCode` is exactly:

*   host/activation: `HostIdentityUnknown`, `HostVersionUnsupported`, `InteractiveTuiRequired`, `ActivationFailed`, `CommandCollision`, `RequiredCapabilityUnavailable`, `ControllerGenerationStale`, `InvariantViolation`;
*   persistence: `RuntimeStoreOpenFailed`, `RuntimeStoreMigrationFailed`, `RuntimeStoreWriteFailed`;
*   execution: `LeaseLost`, `LifecycleProjectionFailed`, `LifecycleEffectFailed`;
*   child/protocol: `ChildCapacityExceeded`, `ChildSpawnFailed`, `ChildHandshakeMissing`, `ChildAuthenticationFailed`, `ChildEnvelopeMalformed`, `ChildEnvelopeReplay`, `ChildReplyMissing`, `ChildReplyDuplicate`, `ChildReplyLate`, `ChildExitedUnexpectedly`, `ChildSettlementMissing`, `ChildAbortFailed`, `RpcBridgeUnavailable`, `UiBridgeFailed`;
*   completion: `CompletionSignalMissing`, `CompletionSignalDuplicate`, `CompletionSignalMalformed`, `CompletionSignalLate`, `CompletionRejected`;
*   plan/artifact: `PlanMissing`, `PlanReadFailed`, `PlanWriteFailed`, `PlanRevisionStale`, `PlanTreeMalformed`, `LegacyPlanUnsupported`, `ArtifactReadFailed`, `ArtifactDigestFailed`, `ArtifactApprovalFailed`;
*   telemetry: `SessionPointerAppendFailed`, `JournalWriteFailed`, `UsageWriteFailed`, `LogWriteFailed`, `RetentionFailed`.

Permission-engine failures remain the closed harness-neutral variants from its own spec; adapters map them to blocked permission results and safe diagnostics rather than extending `PiAdapterFailureCode` ad hoc.

Adapter-blocking failures enter health-only mode. Operation failures stop only the correlated operation. Telemetry and optional failures degrade visibly, except `journal.strict=true` makes `JournalWriteFailed` stop only its correlated transaction. Invalid child signatures and replays stop only that child. A conflicting usage duplicate is `InvariantViolation`. Internal causes remain ephemeral and are reduced to an approved exception class and safe scalars before logging. Pi-required throws occur only at framework boundaries.

## 24. Test architecture


Automated tests MUST NOT run Pi, spawn real children, use the network, or mutate a developer project.

Required layers:

A. pure core/config/engine contracts;

 B. Pi adapter units;

 C. compiled extension against a recording fake Pi host;

 D. scripted LF-delimited child/RPC/private-control transport through an injected process port;

 E. in-memory persistence/telemetry plus narrow isolated Bun filesystem conformance;

 F. packed tarball and clean-room fake-host consumer;

 G. manual stable live TUI smoke only.

Inject clocks, timers, IDs, randomness, HMAC, environment, process, filesystem, Pi context, dialogs, Runtime Store, journal, usage, and log ports. Unit/integration tests use deterministic fixtures and mocks.

The fake Pi host MUST record all command/tool/event/shortcut/renderer/prompt/model/status/widget/dialog/session-entry calls, issue fresh contexts after replacement, simulate all Pi modes, and inject host failures.

## 25. Acceptance manifest and release gates


Check in a manifest mapping stable requirement IDs to normative section, named test IDs, packed proof, live smoke inclusion, and result. CI rejects duplicate IDs, orphan tests, missing proof, and nonexistent tests.

The mandatory rows are defined by [`acceptance-manifest.schema.json`](acceptance-manifest.schema.json):

| ID | Required proof scope | Normative sections |
| --- | --- | --- |
| `PI-ACT` | Safe initialization, trust, activation, generations, and cleanup | 7 |
| `PI-MAT` | Ordered materialization, descriptor isolation, and primary activation | 8.1–8.2 |
| `PI-PRM` | Single composed-prompt append with native prompt preservation | 8.3 |
| `PI-SKL` | Pi-owned discovery and exact engine skill resolution | 9.1 |
| `PI-MDL` | Deterministic model intent and visible temperature degradation | 9.2–9.3 |
| `PI-POL` | Registered-tool interception, approval bridge, and permit enforcement | 12 |
| `PI-DEL` | Portable limits, authenticated children, framing, tree controls, and cleanup | 10–11 |
| `PI-CMD` | Exact native command and palette behavior, including invalid states | 13 |
| `PI-LIF` | All ten lifecycle projections and exactly-once effect application | 14 |
| `PI-CMP` | Structured candidate and settlement completion contract | 15 |
| `PI-REC` | Runtime-authoritative recovery, correlation pointers, and explicit resume | 18 |
| `PI-PLN` | Revisioned snapshots, transitions, legacy handling, and plan UI | 16 |
| `PI-ART` | Safe artifact reads, digest/revision binding, actors, and reconciliation | 17 |
| `PI-PER` | Runtime Store ownership, migration, grants, and durable state | 12, 18, 20 |
| `PI-DIA` | Data ban, bounded diagnostics, journal projection, and rotating logs | 19.1–19.3 |
| `PI-USG` | Idempotent observations, atomic rollups, and pruning | 19.4 |
| `PI-CAP` | Nineteen probe-lowered capabilities and health-only behavior | 21 |
| `PI-ERR` | Closed failure codes, impacts, recovery actions, and sanitization | 23 |
| `PI-PKG` | Public package policy, exact-host build, pack, and clean consumer | 5, 22, 24–25 |
| `PI-MODE` | Interactive TUI-only public support and private-child handshake isolation | 3, 7, 11.2 |

The table uses prose ranges for readability. A manifest expands each range into individual tokens accepted by the schema; for example, `8.1–8.2` becomes `["33§8.1", "33§8.2"]`.

The manifest has exactly one row per ID. Every row requires at least one automated test, packed proof, and live-smoke checklist item; none may opt out. Evidence IDs are local (`T###`, `P###`, `S###`) inside a requirement row. Tests are an object keyed by `T###`, so duplicate local test IDs are invalid JSON object keys; packed and smoke IDs are unique arrays. Their canonical ID is the row ID plus the local ID, for example `PI-MODE-T001`; this makes cross-requirement evidence mismatch impossible by construction and supports the four-letter `PI-MODE` namespace.

Each row also names its Spec 33 sections, existing test files/names, and result. CI validates the schema, rejects missing or duplicate IDs, verifies named tests and evidence exist, and rejects orphan canonical `PI-*` IDs. A `pass` result is accepted only after those existence and artifact-binding checks succeed. The final manifest is added only after implementation supplies every required proof; placeholder evidence is forbidden.

Closed sets require exhaustive proof: 19 capability IDs, ten lifecycle operations, every failure code/impact/recovery, every command and invalid state, private envelope/reply states, permission outcomes/failures, plan markers/transitions/revisions, artifact actors/reconciliation sources, and host boundaries.

Pull requests and nightlies require all automated layers, floor/exact-host builds, packed policy, clean consumer, artifact binding, and registry digest checks. Nightly may publish without live smoke but MUST NOT claim live validation.

Stable publication requires protected `pi-stable-smoke` approval tied to the exact package version, payload artifact ID, SHA-256, subject SHA, run attempt, exact host version, and checklist version. Any rebuild or binding change invalidates approval. Promotion to `latest` keeps the existing digest re-verification and MFA policy.

The live smoke MUST cover install/trust/reload, health, materialization, skill/model/prompt/temperature, allow/deny/ask and unmanaged tools, authenticated child/approval/cancel, workflow/completion/plan/artifact, no-auto-resume plus explicit resume, diagnostics/usage/redaction, cleanup, and package removal.

## 26. Implementation order


Use this dependency order; each step may be a separate focused issue/commit set:

1.   documentation ADRs, requirement IDs, and acceptance-manifest schema;
2.   delegation DSL and engine authorization;
3.   permission subsystem;
4.   revisioned plans and artifact actors;
5.   usage, retention, effective capabilities, and log sink;
6.   Pi package skeleton, fake host, safe init, compatibility, and health-only mode;
7.   config/materialization, primaries, prompt, skills, models, and temperature;
8.   registered tool policy and approval UI;
9.   private RPC/control transport and delegation tree;
10.   commands, workflow lifecycle, completion, recovery, plans, and artifacts;
11.   diagnostics, usage, package/release integration, clean-room proof;
12.   full acceptance manifest, stable smoke checklist, and implementation handoff closure.

A later step MUST NOT claim readiness while an earlier consumed contract remains provisional.

## 27. Decision traceability


| Source decision | Normative sections |
| --- | --- |
| [Pi runtime-surface research](https://gist.github.com/josevelaz/d95b898bfeea40456a244b92a585dcbc) | 2, 5–9, 11–15, 22, 24 |
| [Pi full-readiness parity audit](https://gist.github.com/josevelaz/fb7446dc7c82eb5e4ff5874b29cb1d8a) | 1–3, 8–9, 13–15, 21, 24–25 |
| [Package and activation](https://gist.github.com/josevelaz/6d1b4fd5df6f074dd7578a4edf300405) | 5–7, 18, 22 |
| [Agents, skills, models, policy](https://gist.github.com/josevelaz/aebdec129c1c9b6c229bd2e13b7fb479) | 8–12 |
| [Workflow, delegation, lifecycle](https://gist.github.com/josevelaz/a61c601d514672d924a4d85ee9a06f3a) | 10–18, 20 |
| [Persistence, diagnostics, failure, capabilities](https://gist.github.com/josevelaz/75d8a61fe96a7e0babe7743180bcd3f5) | 18–23 |
| [Verification and release acceptance](https://gist.github.com/josevelaz/8a3938292993c6ff92fab35e234f15a5) | 24–26 |
| [Permission engine](https://gist.github.com/josevelaz/c330b990d6cdba44d0e15635ce6e5c22) | 12, 20, 23–25 |

## 28. Edge-case closure


| Edge case | Required result |
| --- | --- |
| Untrusted project | Builtin/global only; project intent withheld; visible health note. |
| Wrong mode/host/version | Health-only before materialization/work. |
| Partial descriptor failures | Keep unrelated valid descriptors; no identity substitution. |
| Ambiguous model | Skip; never fuzzy choose; fallback with degraded health. |
| Temperature present | Keep descriptor; warn once; no fake sampling. |
| Unknown/unregistered tool | `unmanaged`; preserve owner behavior; no permit. |
| Registered unresolved input | Ask once only; no reusable grant; block without UI. |
| Resolver throws/returns bad data | Typed error; no challenge/grant; block. |
| Concurrent approval or permit replay | Serialize/transactionally guard; one execution only. |
| Child replay/cross-generation message | Stop affected child operation and sanitize diagnostics. |
| Child exits without settled completion | Typed missing-settlement/completion failure. |
| Duplicate/late completion | Reject; do not advance. |
| Parent prompt during workflow | Explicit pause choice; never concurrent mutation. |
| Restart/reload/fork/switch | Stop dispatch; no auto-resume; stale generation rejected. |
| Parent compaction | Keep children; refresh bounded status; no transcript injection. |
| Stale plan revision | Fail closed; refresh snapshot; no implicit rewrite. |
| Legacy/malformed plan | Degraded readable legacy or typed malformed error; no read-time rewrite. |
| Artifact path escape/digest mismatch | Reject; reconcile mismatch; never rebind silently. |
| Pointer append failure | Degrade only; never repeat authoritative commit. |
| Conflicting usage duplicate | Invariant breach; no double rollup. |
| Log sink failure | Visible degradation; no recursive logging. |
| Exact command collision | Required capability failure; health-only. |
| Cleanup repeated | Idempotent; no stranded child or secret. |

## 29. Final acceptance


This spec is implementation-ready when reviewers confirm that:

*   every accepted map decision is traceable to a normative section;
*   all adapter/engine ownership is explicit;
*   all required behavior, fallbacks, edge cases, errors, tests, packaging, documentation, and release gates are closed;
*   no product or architecture decision remains for implementation;
*   implementation may choose only local code organization details that do not alter this contract.

**Open product or architecture decisions: none.**
