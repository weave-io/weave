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
- config source digests, delegation-boundary refresh, and catalog publication;
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

Alt+A cycles healthy `primary` and `all` descriptors in materialization order while Pi is idle. It skips subagents, resolves the new primary against the currently published catalog, and switches atomically. It is also the one in-session point at which a deferred config change may be applied; see [Config refresh at delegation boundaries](#config-refresh-at-delegation-boundaries). The [Plan Rail](#plan-rail) above the editor shows `◆ WEAVE · <NORMALIZED-NAME>`, follows a direct workflow agent while it runs, restores the primary after settlement, and clears in health-only mode or at shutdown. When the host cannot mount a widget, the same name falls back to Pi's status line.

The badge tints the agent name with a stable background drawn only from theme background tokens Pi itself supports. The choice is deterministic: the normalized agent name (trimmed, whitespace-collapsed, case-folded) always selects the same token in every session and on every machine, with no stored assignment, so you learn one color per agent. Distinct agents may share a color; the same agent never changes color. The agent name keeps its accent foreground. If the active theme exposes no background helper, the badge renders foreground-only — accent, bold agent name, no tint — rather than substituting a different color.

### Provider acceleration

A descriptor's `fast true` reaches Pi as neutral intent, and the adapter carries it on the active primary and inside authenticated ordinary and direct-step child bootstraps. Pi translates that intent into a provider control in exactly one mapping.

| Mapping | Status |
| --- | --- |
| OpenAI Codex subscription, the ChatGPT-backed `openai-codex` provider | Mapped through Weave's own wrapped provider |
| Public OpenAI API Fast/Priority, the `openai` provider | Unsupported |
| Every other Pi provider | Unsupported |

These are two different OpenAI contracts, and they share no fact, allowlist entry, request field, or response value. See the [provider acceleration contract](../specs/fast-provider-acceleration-contract.md#openai-codex-subscription-fast-mode-chatgpt-backend).

#### The hook seam stays unsupported

Pi's public extension contract exposes `before_provider_headers`, `before_provider_request`, and `after_provider_response`, but none of them binds the effective transport of one prepared request or that request's response body to the same attempt. `ctx.model.baseUrl` is declared configuration that auth resolution may replace, and `ctx.modelRegistry.getProviderAuth()` performs a fresh resolution rather than reporting the resolution the held request used. Without that proof an allowlist match would be a guess, so even `requested` would be untrue.

The adapter therefore registers **no** provider request, header, or response handler. Every provider payload reference and header map is left exactly as other extensions left it; no `service_tier`, `speed`, or `anthropic-beta` value is ever written there. Intent that reaches no eligible Codex attempt reports `unsupported` with the bounded reason `harness-seam-unavailable`.

#### The wrapped codex provider

Weave registers its own `openai-codex` provider that wraps Pi's native one: same id, name, `auth` object, and model list, with only `stream` and `streamSimple` wrapped. That object holds what the hooks cannot — the effective post-auth transport, the resolved credential shape, the final body after other extensions ran, the outgoing request headers, and the same attempt's response.

Registration happens once per process and fails closed. It requires the host's public `VERSION` to be at least `0.83.0` (the first version whose codex SSE path honors `options.fetch`), the pi-ai codex provider subpath to import with the expected factory, and `registerProvider` to be callable. A parent registers only in a trusted, non-health-only session; a child registers only after its bootstrap handshake proved the process is a real Weave child. Any failure registers nothing, leaves Pi's native provider in place, reports `unsupported`, and leaves activation untouched.

#### Exact eligibility

The wrapper computes one verdict per stream call, before any mutation. A request is mapped only when every rule holds:

- the process-local active owner declares `fast true` — the committed primary in a parent, or the authenticated applied bootstrap in a child or direct workflow step;
- the call reached the wrapped `openai-codex` provider;
- the request model id is an exact member of the frozen allowlist, matches `^[A-Za-z0-9._-]{1,64}$`, and equals the owner's resolved model id;
- the effective base URL is absent or exactly the first-party ChatGPT backend, compared as a whole string. Any gateway, proxy, localhost, or lookalike URL is `transport-not-first-party`;
- the resolved credential parses as a ChatGPT subscription OAuth token carrying an account claim. The token and the account id never enter state, logs, evidence, or errors;
- no collision exists: the final body carries no foreign `service_tier`, and neither caller-held header source carries an `x-codex-routing-hint` in any casing.

#### What a mapped request sends

An eligible request uses `transport: "sse"`, the only codex path with header authority, and carries both parts of the contract or neither:

1. `service_tier: "priority"` in the final body;
2. `originator: codex_cli_rs` and `x-codex-routing-hint: model=<model id>;tier=priority` on the outgoing request.

The activation window is process-level, because no per-request agent identity exists at the provider seam. While a fast owner is active, an ambient host request on the same allowlisted model — a branch summary or a title generation — is mapped too. That window is accepted deliberately; narrowing it by heuristic would be a guess.

#### Fail-closed behavior

Registration itself is gated on proof, not on the host version alone. The wrapper's only seam for header authority is `options.fetch` on pi-ai's codex SSE path, which exists from pi-ai `0.83.0`, so the adapter registers only when the exact module it wraps — `@earendil-works/pi-ai/providers/openai-codex` — is proven to be the running host's own copy. That subpath is its own member of the closed [host-module set](#host-runtime-resolution); a proof about the bare `@earendil-works/pi-ai` package entry does not answer for it, because a subpath import resolves to its own file. An unproven, unknown, or skipped subpath registers nothing, leaves the native provider in place, and reports one bounded token, so no body this adapter mutated can reach the network through a copy that would ignore its headers.

No intent, any eligibility failure, a gateway base URL, a host below the version gate, a failed registration, and a known collision all produce the same result: the call runs on the native implementation with the caller's own transport, fetch, and payload hook, the request stays byte-identical to the same configuration without `fast true`, and the adapter records one bounded reason. A failure known before the body exists delegates the caller's own options object. A body collision is knowable only after the caller's hook has run, so the wrapper puts those three fields back before the host reads any of them.

One case cannot be a passthrough. The body is serialized, and possibly compressed, before any fetch runs, so a routing-hint collision that appears only at fetch time cannot roll back a tier Weave already wrote. The wrapper then does not send that attempt at all and fails the call, rather than putting a half-mapped request on the wire.

#### What the states mean

`requested` means the wrapper's own fetch ran for that attempt and wrote both parts. It does not mean the request was faster. Only same-attempt evidence carrying exactly `service_tier: "priority"` permits `applied`.

On the pinned host, Pi 0.84.2, the backend reported `service_tier: "default"` — standard speed — for a fully mapped request, a tier-only request, and an untouched control alike. A successful eligible request therefore terminates at `not-confirmed` with the evidence outcome `standard`, and `applied` has never been observed. The adapter never infers acceleration from HTTP status, latency, absence of error, or its own mutation.

`/weave:status` renders the sanitized snapshot: `fast: requested (codex-sub-05, openai-service-tier=absent)`, `fast: not-confirmed (codex-sub-05, openai-service-tier=standard)`, or `fast: unsupported (harness-seam-unavailable)`. A mapped attempt names the evidence kind as soon as it writes both controls, and the outcome stays `absent` until that same attempt's response resolves it. The allowlist rule id is the only model-adjacent token; no provider string, model text, URL, header, or credential can enter it.

#### Capability and journaling

The `provider-fast-activation` capability declares the static readiness `degraded`: one mapping only, capped below `applied` on the pinned host. A live attempt is read through `providerFastActivationState` and `effectiveProviderFastReadiness`, which may lower that ceiling and can never raise it.

A mapped attempt journals its own sanitized snapshots, and the latest of them is also the state `/weave:status` reports. `requested` is recorded immediately, as soon as both controls land on the outgoing request, and the terminal snapshot is recorded later, when that same attempt's evidence resolves or the call ends below `applied`. A mapped snapshot therefore does not wait for the turn to settle. Intent that reached no mapped attempt is recorded instead when a turn settles (`agent_settled`). A bounded in-memory dedupe window collapses repeats of the same `(state, reason, evidenceOutcome)` triple to one durable journal record, so the transient `requested` state and its terminal outcome are each kept once, and the key is claimed before the write so two settled turns cannot persist it twice. A failed write releases the claim, so a later settled turn may record it again. The window is in-memory only: it is cleared on session start, after a successful primary switch, and on shutdown or a failed boot activation, so the new active intent owner records its own outcome. The latest mapped snapshot is dropped with it, because it describes one session's request. Durable journal events already written are never removed by that reset.

This capability is optional. It warns, never enters health-only mode, and never blocks activation, prompts, models, tools, delegation, or bootstrap. Raising Pi to `applied`, or mapping any further provider, requires the same proof this mapping already carries: the effective transport of one prepared request plus correlated response evidence for that same request, shown in a fresh real harness under [Adapter Verification](../testing/adapter-verification.md). Unit confidence is not that proof. The Codex mapping also carries a [recheck obligation](../specs/fast-provider-acceleration-contract.md#recheck-obligation-for-this-transport): a failed recheck returns it to `unsupported`.

## Config refresh at delegation boundaries

A generation's catalog is no longer frozen at `session_start`. Before each child dispatch — root `weave_delegate`, an authenticated nested relay, a direct workflow step, and a recovery restore — the adapter re-checks its config sources and may publish a newer validated catalog for later work. Nothing already committed moves: the active primary keeps the contract it was activated with, and every live child keeps the catalog it was dispatched with.

### Source graph and digests

The catalog is derived from four kinds of source:

| Source | Digest |
| --- | --- |
| Builtin layer | One immutable in-process source — the builtin DSL string plus its embedded prompt contents — hashed once per process and never re-probed |
| `~/.weave/config.weave` | Its own SHA-256 |
| `<projectRoot>/.weave/config.weave` | Its own SHA-256; not a source at all while project trust is withheld |
| Each referenced `prompt_file` and `prompt_append_file` | Its own SHA-256, one entry per path |

Every file source keeps its **own** SHA-256 over the raw bytes as read. A digest is never taken over a concatenation of several files, and DSL-level normalization happens after hashing, so detection is byte-level.

Inline prompts are not separate sources. A single-line `prompt` and a triple-quoted multiline `prompt` are both content of the config file that declares them, so an inline prompt edit is detected through that file's digest; there is no separate manifest entry for inline prompt text. See [Prompt Composition — Change detection](../reference/prompts.md#change-detection), and [DSL Reference — Multiline strings](../reference/dsl.md#multiline-strings) for the multiline syntax itself.

The project root and the trust state are identity inputs, not sources. A change to either is a different source graph and is handled by session replacement, never by refresh.

### The unchanged fast path

A boundary check first stats every known file source and compares byte size and modification time. When nothing moved, the check ends there: no file is read, no digest is computed, no config is parsed, no descriptor is materialized, and nothing is published. Concurrent delegations join one in-flight attempt, and a minimum interval between probes — 250 ms in production — keeps a burst of parallel delegations to a single probe round.

Metadata is a bound, not a guarantee. A rewrite that keeps the same byte size and lands inside the same filesystem timestamp tick is invisible to the probe and is reported as unchanged until another source changes. Size participates in the comparison to narrow that window; it does not close it. Where metadata is unreliable the production port reports a value that never compares equal, so the source is re-hashed. The probe always fails toward hashing, never toward assuming a source is unchanged.

### Exact-byte candidate builds

Only the sources a probe could not rule out are read — once each — and hashed. When the new digest equals the cached one, the stored metadata is updated and nothing is rebuilt, so an identical-content rewrite costs one read and the next boundary is a pure fast path again.

The bytes that were hashed are the bytes the candidate is built from. A caching config reader feeds the config loader and a memoized prompt reader feeds engine composition, both serving the bytes this attempt already read; anything the pipeline still needs is read and hashed exactly once, memoized by path. Both caches live for one attempt, so bytes from one candidate build never leak into the next.

The classification decides which path runs:

- **prompt-only** — no config file changed. The config loader is never called: the current merged config is reused, descriptors are re-materialized with the memoized reader, and the Pi-local lifecycle and inspection settings carry through unchanged.
- **config-changed** — the full pipeline runs once: parse, merge, materialize, and re-resolve the Pi-local lifecycle settings.

After either rebuild the prompt references are rediscovered from the resulting config. A newly referenced prompt file is read and hashed there; a reference the config dropped simply leaves the manifest.

### Validate, then publish atomically

A candidate is fully validated before anything is published, and publication assigns one frozen reference. No reader can observe descriptors from one config beside workflows from another.

Refresh failures are values from a closed set: an unreadable source, a config that did not parse or validate, a missing prompt file, out-of-range lifecycle settings, or a materialization that produced no plan. A failed attempt publishes nothing. The last valid catalog keeps serving, the delegation that triggered the refresh proceeds against it, and the next boundary probes again. A config saved mid-edit — an unterminated `"""` string, for example — is an ordinary parse failure with exactly that effect.

Per-agent composition failures follow the same policy as activation: they are accumulated rather than fatal, the affected descriptors are absent from the candidate, and the candidate is still publishable. The refresh call itself is total, so a delegation never fails because a refresh did.

### What refreshes automatically

A candidate publishes automatically when it leaves the active primary's contract exactly as committed. That covers most editing: subagent prompts (inline or file), model lists and thinking levels, temperature, `fast` intent, tool policy, declared skills, delegation limits, child lifecycle timeouts, workflow definitions and steps, disabled agents and skills, and agents added or removed outside the active primary's target set. The next root dispatch, nested relay, direct workflow step, or recovery restore resolves against the published catalog, with no restart and no re-registration.

### Active-primary pinning and deferral

The committed primary is compared with the candidate on a closed facet list: `primary-missing`, `primary-disabled`, `primary-demoted`, `prompt`, `models`, `thinking`, `temperature`, `fast`, `tool-policy`, and `delegation-targets`.

The prompt facet compares rendered output, not source form — the exact block the adapter appends to Pi's system prompt, skills line included, rendered with the candidate's `disabled.skills`. Rewriting the primary's prompt from a single-line inline string into a triple-quoted one, or moving it into a `prompt_file`, is not primary-affecting when the rendered block is byte-identical.

Delegation targets normalize to name plus description, sorted by name. Reordering the same targets changes nothing; **adding a target, removing a target, or changing a target's description is primary-affecting**. An agent newly aimed at the active primary is therefore not delegable at the next dispatch, and a target removed from the config keeps serving until an authorized publication.

A primary-affecting candidate is deferred, not published. The current catalog keeps serving, and the primary's rendered prompt, model, thinking level, temperature, `fast` intent, tool policy, badge, and delegation targets stay exactly as committed.

### Explicit reactivation and restart

An `Alt+A` switch is the one in-session authorization point. It resolves the new primary against the published catalog, and once it commits, the deferred candidate is *dropped* rather than published: it was validated against the previous primary and may have been built from bytes that have since changed. The sources are re-probed and rebuilt, and the result is guarded against the primary that just committed. Cycling back then activates whatever that rebuild published.

Session replacement and restart are the other path. They revoke the generation, clear every piece of refresh state, and make boot activation authoritative again. A trust change is a session-replacement concern for the same reason: refresh never re-evaluates trust.

### The stable `weave_delegate` schema

The registered `weave_delegate` schema is constant: `agent` is one bounded plain string, never a union of the target names known at registration time. Pi requires parameters at registration time, so a name-derived schema would pin the callable set to the registration-time catalog. It also keeps the schema free of the `anyOf`/`const` unions some providers reject, and byte-identical for a whole generation, so tool and prompt caching never observe a mid-session schema change. The schema therefore grants no authority. Every invocation resolves the live primary identity and that descriptor's current eligible targets and authorizes the requested name against them, so switching primary agents cannot reuse stale authority, and an ineligible or unresolvable name is refused before the delegation controller is reached. A relayed child's tool uses the same constant schema; its own bootstrap-pinned targets refuse an impossible name locally, and the authenticated parent re-resolves every relayed name against the snapshot pinned to that child.

Schema stability removes the re-registration obstacle and nothing else. It decides no authorization and authorizes no publication: a candidate that would change the active primary's target set still defers. The two rules compose — the tool's shape is fixed for the generation, while its runtime authority follows the active primary's pinned targets until an explicit reactivation or a session replacement publishes a new set.

### Per-child snapshot pinning

At dispatch a child pins one immutable catalog by reference. Its four lifecycle budgets — handshake, reply, settlement inactivity, and absolute runtime — and its nested-target authority come from one read of that one catalog, so a publication can never give a child one catalog's handshake timeout beside another's runtime budget. The reference is released when the child settles or is disposed; the bound is one reference per live child.

A live child's nested request resolves against its own pinned snapshot, and the nested child inherits that same snapshot, so an in-flight subtree stays on one catalog for its whole life. A direct-step child carries its snapshot into the authenticated relay for the same reason. Refreshed delegation limits apply to future admission decisions only: a running child is never cancelled because a limit shrank.

### What refresh never does

- **No watchers, no timers.** There is no file watcher, no polling interval, and no background job. Every probe happens inside a boundary call, so a generation that stops delegating stops refreshing.
- **No trust reload.** Trust is decided once per generation. Refresh never re-evaluates it and never widens what a trust state may read: with trust withheld the project config is not a source, and both readers refuse every path under `<projectRoot>/.weave/` before touching the filesystem.
- **No health-only transition.** Refresh never changes the generation's mode, never re-probes host surfaces or capabilities, and never re-resolves child-inspection settings. Health-only and trust-withheld generations register no delegation surfaces, so they build no refresh coordinator at all.
- **No silent primary mutation.** The active primary's prompt, model, thinking level, temperature, tool policy, badge, and delegation targets change only through an explicit `Alt+A` reactivation or a session replacement.
- **No tool re-registration.** Registered commands and tools stay fixed for the whole generation.

### Refresh diagnostics

A new deferral or a new failure emits one notice, and only one: notices are deduped by classification and digest state, so a config left broken does not warn at every delegation boundary. A deferral always reads `Weave config change affects the active primary; switch primary or restart to apply.`

`/weave:status` carries one refresh row:

```text
config refresh: fresh; published 2
config refresh: deferred: primary-affecting; published 2; facets prompt, delegation-targets
config refresh: failed: config-invalid; published 2
```

`published` counts catalog publications in this generation. Failure reasons are the closed set `source-unreadable`, `config-invalid`, `prompt-unavailable`, `settings-invalid`, and `composition-failed`. At most four facet names are printed, followed by `(+N)`. The row is absent for a generation that runs no refresh at all. Nothing in it can carry a path, a filesystem message, config content, or prompt text.

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
- `/weave:pi-config` — choose which Pi extensions Weave children load;
- `Alt+A` — cycle healthy primary-capable agents;
- `Alt+T` — open the read-only plan-task list;
- `Alt+I` — open the child picker (see [Overlay keys](#overlay-keys)).

Only an explicit user command authorizes work. Session start, idle, settlement, recovery discovery, ordinary chat, and health views never start or resume durable execution.

`/weave:start` is the only plan-execution command. It confirms an existing plan and submits it as one visible foreground Pi turn; it creates no durable workflow state and starts no engine-managed workflow. `/weave:run` does one separate thing: it explicitly starts a named engine-managed durable workflow through the engine lifecycle surface, and it never runs a plan on `/weave:start`'s behalf. `/weave:resume` also calls the engine lifecycle surface. Neither command implies the other.

### Plan Rail

The **Plan Rail** is the single owner of ambient parent context. It mounts as a widget above the real Pi editor, survives `Esc`, and is the only surface that names the active plan task. There is no separate task footer beside it.

Its rows are fixed:

1. `◆ WEAVE · <AGENT>` · `Alt+A cycle` · plan name;
2. spaced task marks and the ordinal (`3/8`);
3. `┃ now` and the active task;
4. `┗ next` and the following task.

The rail degrades through measured width bands, never guessed ones: `wide` at 96 columns or more, `mid` at 68 or more, `tight` at 46 or more, and `micro` below that. Pieces leave in one fixed order — the plan name first, then the `next` row, then the descriptive word `cycle`. `Alt+A` is the last hint standing, and the selected agent name is the last thing the rail can lose. The cycle hint appears only when there is another primary agent to cycle to.

The rail names the running direct workflow step's own agent while one is active, and otherwise only the committed primary; a merely pending selection is never named. It reads parent-side facts only, and its fact type has **no field** for a child id, token count, cost, elapsed time, active tool, or queue depth. Those exclusions are structural, so the rail is byte-identical in every child state; child telemetry belongs to the inspector's Status Matrix rail. Task marks are bounded to 40, after which the row states the position with its ordinal alone.

The rail is removed, not frozen, when there is nothing to name: no Weave primary agent, no tracked workflow, no readable plan task, or a completed, failed, or cancelled workflow. Row 1 still shows the agent when no plan is active, because the plan half is a structural absence rather than a row of blanks. When the session tracks no workflow but an eligible recovered pointer exists, the rail may show that paused plan as read-only state. Showing a recovered plan authorizes nothing; only `/weave:resume`, with its own confirmation and lease recheck, continues that work.

#### Which plan the rail names

Three sources, in descending authority. Each is used only when the one above it
has nothing to say.

1. **The tracked durable workflow.** This session's own workflow instance.
2. **An eligible recovery pointer.** A paused execution, shown as read-only
   state; showing it authorizes nothing.
3. **The foreground plan.** The plan this session is working through in its own
   turn, with no workflow instance behind it — which is what `/weave:start`
   produces.

The third source is **display-only**. It starts, resumes, and authorizes
nothing, acquires no lease, and writes no runtime state. Exactly two
user-authorized paths may set it: `/weave:start`, from the plan the user
selected and confirmed, and one direct interactive message that explicitly asks
for exactly one contained `.weave/plans/<name>.md` to be executed.

The direct path is parsed by a closed grammar over the **whole message**, not
by searching for keywords and not by reading only the clause beside the path.
The message must be within a bounded length, and every token outside the plan
path itself must be in one of four closed vocabularies, in this order:

```
<lead-in>* <execution verb> <connector>* PATH <trailer>*
```

- lead-ins: `please`, `now`, `then`, `first`, `let's`, `go ahead and`,
  `i want you to`, `you should`, …
- execution verbs: `execute`, `run`, `start`, `implement`, `continue`,
  `resume`, `finish`, `complete`, `work through`, `carry out`, `pick up`
- connectors: `the`, `this`, `plan`, `file`, `at`, `in`, `through`, …
- trailers: `end to end`, `now`, `please`, `thanks`, `for me`, …

One token outside those vocabularies rejects the message, and so does one
character the grammar has no rule for — a colon, a period, a digit, a bullet,
an angle quote, or a code fence before the path. That is what makes a
quotation, an example, or an instruction *about* a request fail: `For example:
run .weave/plans/alpha.md`, `Ignore this quoted sample: run …`, `> execute …`,
and ` ```\nrun …\n``` ` all name a plan inside a sample rather than asking for
one. A question mark anywhere, a negation anywhere (`don't run …`, `run the
tests, not …`), and any trailing qualification (`… for example`, `… but only
if it exists`) also set nothing. The grammar is total: every message reaches
either one plan name or one typed rejection, and anything it does not accept
falls back to `/weave:start`, which asks the user explicitly.

A message wrapped in quote or code framing is refused for the same reason:
`'Execute the existing Weave plan at .weave/plans/alpha.md'` shows a request
rather than making one, and so do its `"…"`, `` `…` ``, `‘…’`, `“…”` and
fenced spellings. An apostrophe is admitted only between two letters, where it
spells `let's` and `i'd`, so a quote before the verb is an unknown character
rather than one trimmed off the word. Quoting the **path** is untouched:
`run '.weave/plans/alpha.md'`, `run ".weave/plans/alpha.md"` and
`` run `.weave/plans/alpha.md` `` all name `alpha`.

A parse is still not authority to display: the name must also be in this
root's plan catalog with a readable snapshot.

A plan-path-like mention the parser will not accept rejects the **whole**
message, even when a valid path sits beside it: a traversal, an absolute path,
a nested subdirectory, a different slash or case spelling, an unsafe basename,
an ambiguous tail such as `alpha.md.bak`, or two different plans. Prose about
"the plan", assistant text, system prompts, and tool output never reach this
path at all.

A selection is recorded as one bounded adapter-owned session entry, and a
restart reconstructs the identity from that entry alone — never by re-reading
conversation. The whole envelope is validated (a Pi `custom` entry with this
adapter's `customType` and a strict payload), so an ordinary message that
happens to carry those fields reconstructs nothing, and the reconstructed name
is revalidated against this root's plan catalog before it reaches the rail. A
newer explicit selection supersedes it, a new session clears it, and a plan
with no incomplete task left clears it too. A plan that exists only in another
worktree is not read across roots: the rail shows the agent row alone.

Every one of these observations is guarded by the session generation, the
project root, and one monotonic observation generation, rechecked after each
read. The generation is claimed by **every** interactive submission, before
the text is parsed — ordinary prose, a malformed request, a negation, and a
resubmission of the same plan all supersede a slower predecessor — and an
authoritative `/weave:start` selection claims it too. The marker is a fresh
identity rather than a counter, so a token issued before a session or root
replacement can never compare equal to one issued after it.

Adoption follows a **host turn-start proof**, never intent. A parsed direct
request is held as pending intent and adopted only when Pi's
`before_agent_start` reports that a turn started for **that exact prompt**.
That event is the earliest point where the host itself states it accepted the
submission: input interception is over, skill and template expansion have run,
and the agent loop is about to begin.

The first proof spends the intent, whatever it proves. So the rail does not
move when:

- a running workflow step prompts "pause it and interrupt with this message?"
  and the answer is no, so the message is never submitted;
- another handler answers `handled`, or the host drops the submission;
- no turn ever starts for it;
- a turn starts for a different prompt — an unrelated turn is not a second
  chance to adopt the earlier request, and a later turn quoting the original
  text cannot redeem an intent that is already spent;
- a newer submission superseded it, the session was replaced, or the project
  root changed.

Nothing here reads assistant text, tool output, or model prose: the proof is a
host lifecycle event plus the user's own submitted string.

`/weave:start` is the deliberate exception, because it is the path that submits
the turn itself: it appends and records the identity inside the success arm of
`sendUserMessage`, which is that path's own dispatch proof. A refused dispatch
reports the failure and leaves no rail state and no session entry behind. The
direct path cannot use the same rule, because it does not submit anything — it
only declines to stop a message the host may still refuse.

Progress is re-read when the work can have changed it — after a turn settles
and after the tool completions that can write a plan file — so the task marks,
`┃ now`, and `┗ next` move with the plan's checkboxes. There is no polling
timer; concurrent refreshes coalesce onto one lookup, and the queue keeps the
**latest** request with its own session context, so a refresh from a replaced
session can never drop the work a newer session asked for.

### Alt+T plan-task list

`Alt+T` opens a read-only, scrollable list of the active plan's parent tasks. It reads the same active-plan and recovery source as the Plan Rail, marks each task `[ ]`, `[~]`, or `[x]`, points a cursor at the active task, and opens on that task rather than at the top. The viewport is bounded on both ends, so a small terminal still scrolls and a tall terminal does not become a full-screen takeover; when tasks are hidden the last line says how many.

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

Authorized work enters a FIFO queue per parent and spawns an independent persistent Pi RPC process. The child receives both `--session <validated-file>` and `--session-dir <validated-directory>`; the adapter removes inherited `PI_CODING_AGENT_SESSION_DIR` so Pi settings or environment state cannot redirect it. Each child has its own 256-bit secret, read once from the environment and then erased.

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

A child may request nested delegation only to its own declared targets. Canceling a node cancels queued and live descendants. Live children get a bounded cooperative grace period before force termination. The 60-minute settlement budget is an inactivity timeout: each parser-approved session event or authenticated control envelope renews it, while a silent child still fails with `ChildSettlementMissing`. A separate six-hour absolute runtime budget starts at the spawn boundary and is never renewed by activity; it covers the spawn itself and the post-settlement response drain, so a process that finishes spawning after the budget expired is force-killed and never installed as a live child. When it expires the child is force-killed and the run fails with `ChildRuntimeExceeded`. The failure is retryable and leaves the child's thread and native session intact for explicit recovery.

Children are inspectable and cancellable through the TUI tree, not steerable. Public user-started RPC mode does not activate this private path.

### Child extension selection

`/weave:pi-config` chooses which Pi extensions a delegated child loads. It is TUI-only: outside TUI mode, or when the host offers no custom surface, it reports that instead of opening. It writes durable state, so health-only mode blocks it like every other mutating command, and it needs the generation's open Runtime Store. It writes no `.weave` config file and no Pi settings file.

The default is **inherit-all**. No preference row exists, the spawn argv is byte-identical to a child spawned before this command existed, and the child inherits whatever the host would load. Saving an explicit selection stores an `explicit` record, and the child is then spawned with `--no-extensions` followed by one `-e <absolute path>` per resolved extension. Only absolute paths are emitted; `-e npm:<package>` never is, because Pi would install that package into a temporary directory for every child.

Weave is always first and is never persisted in the record. Its path is derived at spawn time, so a stale stored path can never disable or misdirect the adapter. When that path cannot be derived, the plan falls back to inherit-all rather than spawning a child without Weave. The overlay pins the Weave row as `Weave adapter — always enabled`, never renders it as toggleable, and a save payload that tries to add or remove it is rejected.

Stored entries are matched against the live inventory. An entry the inventory no longer offers is dropped, the surviving entries are kept, and one bounded path-free warning names the count per generation. A renamed or moved extension is indistinguishable from a removed one and is dropped the same way. An `explicit` record whose entries have all disappeared still means explicit: the child loads Weave alone, and it is never promoted back to inherit-all. A malformed record, or one with an unknown schema version, is treated as absent — inherit-all plus a bounded diagnostic — and never fails a spawn. In the overlay, a stored id the live inventory no longer offers is still listed, tagged `unavailable` and `dropped on save`, so a save is never a silent loss. When the inventory is degraded, the overlay opens read-only: it can be read but not saved.

Unselecting a provider extension removes the models and credentials it supplies, so a child may no longer resolve its model. The overlay states this, and it is why inherit-all remains the default.

**Changes apply to children spawned after this session's next start.** They never reapply to a running child, and they do not change the children of the current generation.

Enumeration is best-effort and read-only. The inventory unions three evidence sources: the `sourceInfo` of commands and tools the host already loaded, configured packages with their installed path and `pi.extensions` manifest, and bounded scans of `<agent dir>/extensions` plus, only for a trusted project, `<cwd>/.pi/extensions`. Nothing is loaded, evaluated, installed, or resolved over the network. Two limits follow from that: an extension that registers no command and no tool and lives outside those two directories cannot be enumerated at all, and a configured package is represented by its installed directory rather than by each entry it declares. The inventory is capped at 200 entries, with bounded directory depth and page sizes, and reports truncation instead of silently shortening the list.

The record is stored in the project Runtime Store as one [adapter preference](../reference/runtime.md#adapter-preferences) row under namespace `adapter-pi`, key `child-extensions`. Choosing inherit-all removes the row rather than storing a record that says "default". `weave runtime preferences --namespace adapter-pi` lists it read-only.

### Native child sessions

Every delegated child runs in a persistent native Pi v3 session created through Pi's `SessionManager.create` and reopened through `SessionManager.open`, so recorded child work is real Pi session data rather than an adapter transcript format. Pi supplies the generated path, v3 header, session ID, parent, and working directory. Because Pi defers the first write, the adapter exclusively writes that exact generated header to the validated `0600` leaf, then reopens it and revalidates every identity field before spawn. It never fabricates a v3 or fork header.

Sessions live under `$XDG_DATA_HOME/weave/adapters/pi/sessions/`, defaulting to `~/.local/share/weave/adapters/pi/sessions/`. That root sits outside Pi's default session tree, so child sessions never appear in Pi discovery or `/resume`, while remaining readable through Pi's native open and read APIs. A relative `XDG_DATA_HOME` is a root violation, not a silently ignored value.

The adapter uses its private, trusted path boundary: directories are `0700`, files are `0600`, and traversal, absolute escape, symlinked components, permissive modes, and anything other than canonical immediate-child equality fail closed. No caller, model, engine API, health report, Runtime Store record, lifecycle field, or diagnostic receives a session path. The adapter never copies transcript bytes into its own storage; entry reads return Pi's `getEntries()` output.

A bounded metadata cache lives beside it at `$XDG_DATA_HOME/weave/adapters/pi/cache/child-metadata.sqlite` (schema version 1, same permissions). It stores metadata only — ids, titles, statuses, and timestamps — with no column for any prompt, message, response, thinking block, tool call, tool result, or transcript. It is fully rebuildable from the parent session's child references, and its loss is never fatal: an open failure, permission failure, corruption, or schema mismatch degrades to reading the bounded parent references directly, so delegation, settlement, and the live overlay keep working with no cache at all.

The authoritative record of which children belong to a parent is a custom entry in the parent's own Pi session. Origin authority is the session file's persisted header id when the host exposes `SessionManager.getHeader()` — not the manager's per-process runtime id — so a restart that reopens the same file keeps the refs this session wrote. A reference whose recorded origin does not match that identity — after a fork or clone, for example — is excluded rather than adopted. When the header is absent or unusable, the adapter falls back to the live runtime id for that process only and never invents a prior origin.

#### Cleanup, tombstones, and orphans

Cleanup is explicit only. The adapter runs no retention timer, prunes nothing on a schedule, enforces no byte quota, and deletes no session because it is old, large, or settled. Data disappears only when you ask for it through `/weave:clear-children` or `weave adapter pi children delete <id>`.

Production `children.delete` is available only after the same Pi-native readiness proof used for delegation. The command resolves a selected terminal child through its immutable origin record, removes its verified session, and appends a tombstone record to `tombstones.jsonl` at the session-tree root. The tombstone file is append-only: there is no rewrite or truncate path. A tombstoned child stays listed, marked `tombstoned`, so a removal is visible rather than silent. List, show, doctor, history, and inspect stay read-only.

A child whose parent session is gone becomes an orphan. Orphans stay readable and stay listed; the inspector marks them `read-only — this child was orphaned` and refuses steering, follow-up, retry, and continue. `ChildOrphanReadOnly` is the corresponding failure code. The adapter does not delete orphans.

#### No migration from the JSONL store

Earlier versions kept child history in an adapter-owned JSONL store under `child-history/<parent-session-id>/`. That store is removed, and there is no migration. Weave does not read, convert, quarantine, or delete existing JSONL history — the files are simply left in place and are no longer visible to Weave. Handle them outside Weave if you still want the data. See [ADR 0014](../adr/0014-pi-native-child-sessions.md).

The removed settings `persist_history`, `max_bytes_per_child`, `max_bytes_total`, and `orphan_retention_days` went with the store. The `child_inspection` block is strict, so a config that still sets them fails validation.

### Private child inspection

Pi's optional `settings.adapters.pi.child_inspection` block controls the local inspector for private child sessions. It carries `recovery_enabled` (default `true`), `recovery_countdown_seconds` (default `10`, range `0`–`60`), and the optional `keys` overlay key map. The canonical source for its exact defaults, bounds, storage path and permissions, inspector slots and controls, commands, retention, clear behavior, recovery scope, resume behavior, export fields, and privacy boundary is [Spec 33 §§4–10](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#4-deterministic-child-inspector-state-model). Do not infer these settings from engine configuration.

The inspector is adapter-owned. It reads sensitive raw prompts, responses, and session events from local-only native child sessions; it never places that content in the engine Runtime Store, workflow state, logs, telemetry, proof, network requests, or parent-model results. Clearing removes local records; it is not a workflow or engine-history operation. Export is a bounded diagnostic projection, not a transcript export.

Recovery is deliberately narrow: it may recover an interrupted ordinary top-level child when the canonical evidence permits it. It does not recursively recover nested children, recover a workflow process, or turn `/weave:resume` into automatic workflow continuation. A workflow resume is a fresh engine-authorized attempt, and engine-owned leases and workflow state remain the engine's concern. See [ADR 0013](../adr/0013-pi-private-child-sessions.md) for the ownership decision and [Spec 33 §6](../specs/33-spec-pi-adapter/33-spec-pi-adapter.md#6-child-recovery-contract) for the limits.

The inspection view renders with Pi's own chat components, so a streamed child reads like a native Pi session: user and task blocks, markdown answer text, italic reasoning, and Pi's tool-execution blocks with real diffs and bash output. Tool calls render through Pi's builtin tool definitions, so a row reads `read <path>` rather than a bare tool name. The adapter injects those components through a narrow port (`PiTranscriptComponentFactory`); the transcript reducer and its dependency-free fallback renderer stay pure, and the fallback text still renders when a component cannot be built. Bookkeeping facts Pi never shows — usage, queue, status, retry, extension-UI requests, and unknown events — are suppressed instead of printed as event prose.

The two-row session header names identity and parent context only; every number lives on the Status Matrix rail. Messages sit one blank row apart. Below the header the transcript scrolls: PageUp and PageDown move a page, Shift+Up and Shift+Down a line, Home jumps to the oldest output, and End follows the live tail again. If the newest page still fits the overlay but older history exists, PageUp and Home load that older page and leave live tail so the prepended rows become visible. The overlay matches these keys by identity, so legacy terminal frames, Kitty event-aware frames, and SS3 `ESC O H` / `ESC O F` all work, and it ignores Kitty release frames. While scrolled back, the view says how many newer lines wait below. Escape leaves the view without cancelling anything, and leaving returns the tree editor to the root so typing goes to the parent session again, not to the child.

The session editor is a single shared Pi surface, so Weave never claims it away from another extension. If a foreign editor factory (for example `pi-vim`'s modal editor) is already installed, Weave leaves it in place for the rest of the generation and does not reassert its own on `session_start`, `before_agent_start`, or `agent_start`. If a foreign factory appears after Weave activated, Weave yields on the next lifecycle event instead of reclaiming. Child inspection still works because the overlay carries its own local editor. It never borrows, replaces, or restores the primary session editor during mount or teardown. Root-level child-tree keys are the only optional convenience lost when Weave yields.

#### Delegation card

Each `weave_delegate` run renders one framed **delegation card** in the parent's own Pi transcript. The registered tool draws it through `renderResult` with `renderShell: "self"`, so Pi puts the component in a bare container and no second box or tint is drawn around the card's own frame. The adapter appends no transcript entry and registers no entry renderer for it.

```
╭─ weave_delegate ──────────────────────────────────────────╮
▌ RUNNING │ Rewrite the Pi adapter's user-facing UI docs.
 shuttle   │ ⏵ edit docs/adapters/pi.md
 1m 12s    │
╰─ run 1 · streaming · 1m 12s ─── Ctrl+O expand · Alt+I inspect child ─╯
```

The card is one frame: exactly one top edge, exactly one bottom edge, and no corner glyph inside it. Its collapsed height is four to six rows at every width and does **not** change at settlement.

- **Status-first rail.** A ten-column left rail carries the upper-case state word behind a toned bar, then the child agent name, then elapsed. The drop order is mechanical: the state word and the child name survive every width, elapsed is the only droppable cell, and below the minimum body width identity folds and the rail disappears.
- **Assignment.** The top body row is one imperative sentence in the parent's own words — no provenance prefix, acceptance clause, scope field, or routing rationale. When the parent recorded none, the row reads `no assignment recorded`.
- **Native Line.** Beneath the assignment there is exactly one line: a semantic glyph plus the single most meaningful thing the child has produced. Whitespace-only and control-only fragments are skipped, and reasoning appears as a bounded summary only. The `✓` glyph belongs to the settlement-named output, so a collapsed row can never imply an answer the settlement has not published.
- **Balanced edge footer.** The bottom edge carries the run and the lifecycle phase plus elapsed, tokens, and cost on the left, and `Ctrl+O expand · Alt+I inspect child` on the right. It never prints the status word the rail already owns. The action side is measured first, so an affordance always outlives a number, telemetry never outlives `Ctrl+O`, and `Alt+I` is the last hint standing.

`Ctrl+O` is Pi's own tool-expand action and `Alt+I` is the existing Weave picker action. The card registers **no** keybinding and prints both as hints only. The expand verb is `expand` while running, `details` once settled, and `collapse` while expanded. Expanded, the card adds one interior rule and a fixed-height child viewport: one status strip reading `LIVE · following bottom` while the child can still act and `AT BOTTOM · child settled` once it cannot, plus `↑ N rows above` when scrollback exists, over exactly nine literal bottom transcript rows. Nothing in the viewport is summarized, grouped, or relabelled.

Settlement is **native and authoritative**. The authoritative settlement rewrites the rail state word, the Native Line, and the footer verb, and adds no row, banner, border verdict, or action deck. A `message_end` never produces a completed card or a success glyph, so an ended-but-unsettled assistant message cannot claim completion. The card never offers retry, steer, resume, or cancel, in any state. A failed card prints the already-redacted reason and names recovery only where the failure class is documented as recoverable; a cancelled card names the initiator in safe terms, says the partial work was kept and that nothing was verified, and never claims success.

The card is fail-closed and bounded. The reducer keeps at most 64 runs per thread and 128 items per run, and older runs stay frozen exactly as they last rendered. Its persisted `details` payload is versioned, bounded, and strictly parsed, and a foreign, older, or oversized payload degrades to a bounded four-row card that says `delegation card unavailable`, prints the bounded reason, keeps the `Alt+I` hint, and claims no state, telemetry, or outcome. Re-rendering from persisted details after replay or restart reproduces the final live frame; a render failure never affects the child run. Every child-sourced string is sanitized before it becomes a segment, and box-drawing glyphs are reachable only through the frame primitive, so child text structurally cannot forge a frame. Tool activity is reported as the tool name plus its canonical state — `running`, `done`, or `failed` — derived from the event type. A tool result, partial result, or tool error payload is never read into the card, so no command output, file content, provider body, or exception text can reach the model-visible line or the persisted `details`; that payload stays in the child overlay and the child transcript, which the reader opens deliberately. The card exposes no filesystem path, native session id, or opaque thread id, and the model-visible `content[0].text` stays a bounded activity line with no card chrome. Nested delegation uses the same renderer; each run gets a new card, and a prior run's card is frozen and never rewritten.

Every 64-run bound in the adapter — the card reducer, the overlay descriptor, and the parent child ref — is a bounded newest-last **window**, not a ceiling on how many times a thread may run. A ref carries the cumulative `totalRuns` alongside its window, so run 65 and run 1,001 append normally, the run ordinal keeps counting after a restart, and only the finite one-million ordinal ceiling can refuse an append.

#### Child inspector

Opening a child mounts the **child inspector**: a centered, bordered Pi overlay above the parent UI. The parent stays visible around it. There is exactly one instance — opening another child, including a nested one, swaps the content instead of stacking. The overlay uses Pi's native transcript components and a fresh Weave-owned `CustomEditor`, so it never replaces or borrows the primary editor. Its row budget matches Pi's `86%` maximum-height and margin rules, and Pi hides the overlay instead of corrupting it below 44 columns or 12 rows. On short terminals it reduces transcript rows first, which keeps the draft editor and bottom border visible.

The finalized surface is one high-contrast titled outer frame — ` WEAVE · CHILD INSPECTOR ` — carrying the child's state marker. Nothing is drawn outside it, and no second frame, fake transcript, editor, or footer exists. Inside it, in order:

- **Session header, row 1.** An inverse ` CHILD ` badge, the child agent name, its model, its role, and its bounded task title, all left-aligned. The model sits immediately after the name and appears **exactly once**. The header grows to two rows before it drops the title.
- **Session header, row 2.** `delegated by <PARENT>` followed by the plan › task › subtask breadcrumb, shedding subtask first, then plan.
- **Transcript.** A Pi-native pane on the left: role gutters, understated read / edit / bash calls and results, reasoning as a bounded summary only, and plain streaming and final assistant responses. Raw chain-of-thought is never rendered. Raw reasoning — a `thinking_delta`, a legacy `delta.thinking`, a standalone `thinking` event, or a persisted `thinking` content block — prints a content-free `✻ reasoning` marker and nothing else, and its text is dropped before it reaches transcript state.

A carrier is judged by what it holds, not by what it calls itself. A frame whose `assistantMessageEvent.type` says `text_delta` or `answer` while it buries prose in a `thinking` or `reasoning` member, or in a nested `{ type: "thinking" }` content block, is a raw-reasoning carrier: beside an answer it is rejected outright and moves nothing, and on its own it yields the content-free marker. A reasoning key with no prose under it — for example the numeric `usage.reasoning` token count — declares nothing, and a hostile carrier (a throwing proxy, or one nested deeper or wider than the bounded scan reads) is rejected rather than published.

The **retention boundary** is the same for every path that keeps an event, and it asks one shared question before anything is kept. A frame the carrier classification **rejected** — mixed carriers, conflicting answers, or a payload the bounded descriptor-safe scan could not read — moves nothing and is retained nowhere: not in transcript history, not in an overlay entry or a replay step, not in a rebuild or a search, and not in the durable child-history port. Redaction blanks the prose fields a carrier *declared*, which cannot describe a frame nobody could classify, so a thought parked under an undeclared member such as `assistantMessageEvent.metadata` is refused outright rather than blanked. A frame the classification called **reasoning** is refused in the same spirit, one step short of dropping it: it states one fact a reader renders, so retention keeps a canonical event the adapter builds — `{ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }` — and nothing observed. Blanking declared fields kept the host's own object, and a reasoning frame may state prose in a member no field list names, so no nested member, string, block, `metadata` / `partial` / `usage` subobject, accessor, or unknown field of it survives anywhere. The canonical event classifies as reasoning again, so a rebuild is a fixed point and the reader still learns that the child reasoned. An ordinary answer and pure framing are retained unchanged. The inspection registry hands the transcript reducer and the history port the **same** parser-approved, retained event, and an event the parser refuses is retained nowhere either: history records that a checkpoint happened and carries no payload. Only an explicit host `reasoning_summary` event or `delta.reasoningSummary` field prints prose, under `✻ reasoning · SUMMARY`; no summary is ever derived by truncating or relabelling raw reasoning. The originating prompt comes first, then user messages, assistant text, reasoning summaries, tool calls and results, errors, retry dividers, and images.
- **Status Matrix rail.** An aligned key/value matrix on the right, grouped lifecycle · work · spend, with an inverse alert pair above the matrix when a tool fails. Below the width at which the rail and the transcript minimum both fit, it folds to its compact matrix form rather than disappearing.
- **Prompt panel.** A primary-like bordered editor over one muted key row. A disabled key prints an explicit `✕` rather than only dim colour, so a settled child reads as unactionable on a monochrome terminal. The key row sheds ordinary notes, then the danger note, then whole chips in ladder order — `/ search`, then `Alt+Enter queue`, then `q cancel` — with `Enter` and `Esc` as the floor.

The header carries **no telemetry row and no child ID**: its fact type has no field for either. The child ID appears in exactly one place, the transcript's bootstrap row, and is never a raw opaque ID or a secret.

The local editor owns cursor movement, deletion, multiline text, and draft state. `Enter` steers the active child, and `Alt+Enter` queues a follow-up. Settled and orphan children get the same editor, read-only and caretless, and a cancelled child is settled exactly like a completed one. The overlay owns pagination through recorded history, search, live tail, and per-child draft and scroll state, and it isolates input: while mounted, no key reaches Pi or the primary editor.

The rail is the sole telemetry surface for the focused child: provider, model, context percentage, input and output token counts, elapsed, queue depth, turn, and spend. The values come only from the host's own bounded, parser-approved usage reports; the overlay keeps the latest report per child and never sums runs. Any field the host did not report, or reported outside its pinned bounds, shows `—`. Nothing is estimated, so a missing context window means no percentage rather than `0%`. Queue depth follows the same rule: it shows `—` until an authoritative `queue_change` event or descriptor depth names one, and `0` / `queue empty` only after an authoritative zero.

Settlement adds no chrome at all. The authoritative final response, the safe failure line, the cancellation record, and the retry record are ordinary transcript events; the frame marker and the rail carry the state word. That word is the settlement authority's own verdict — `COMPLETED`, `FAILED`, or `CANCELLED` — carried on the descriptor from the child's terminal status for a live run and from the ref record's status for a historical one. It is never read from assistant text, from reported status prose, or from `message_end`. **Compatibility fallback:** history written before the descriptor carried an outcome proves only that the run ended, so it keeps the generic `SETTLED` word rather than claiming a verdict. There is no banner band, rail verdict section, transcript checkpoint block, or action deck. Failure text reaches the screen only through the sanitizer, which strips ANSI, removes stack frames, redacts credential-shaped tokens and long opaque IDs, and hides absolute paths.

Historical pages adapt native session entries directly through the host's read API, with cursors in both directions, so the overlay never loads an entire large transcript. Live output flows through the same parser and card pipeline as the delegation card, so the two surfaces cannot disagree. The parser treats `type` as authoritative only when it is the event's own enumerable data property holding a bounded primitive string. An accessor, inherited value, non-enumerable field, or non-string never selects a known event kind or the Pi 0.84 `queue_update` normalizer. A terminal assistant `stopReason: "error"` also flows through one bounded sanitizer and renderer: safe 429, 5xx, connection, and timeout facts can appear, while unavailable or unsafe facts show `assistant error · details unavailable`. The card, the live and historical inspector, the fallback path, and the parent-facing summary use the same canonical line, and the rail states the classification rather than repeating that sentence. A later successful assistant terminal event clears a stale error; tool failure alone does not create one. PageUp, PageDown, Shift+Up, Shift+Down, Home, and End scroll the transcript. Scroll keys are matched by key identity rather than by raw bytes, so legacy, Kitty event-aware, and SS3 encodings of the same key all scroll, and a Kitty release frame never repeats a page. Pi does not enable terminal mouse reporting (including SGR-1006 and modes 1002/1003), so mouse-wheel events cannot reach the component. Mouse-wheel scrolling remains unavailable until Pi exposes a mouse input surface.

When the host does not provide the `child-overlay-lifecycle` surface, the overlay degrades to the existing custom-editor inspection path instead of disappearing. Delegation itself is unaffected: overlay gaps never trigger health-only mode.

#### Overlay keys

Overlay controls are named actions with defaults, not fixed bytes:

| Action | Default keys |
| --- | --- |
| `weave.child.picker.open` | `alt+i` |
| `weave.child.slot.1` … `weave.child.slot.9` | `alt+1` … `alt+9` |
| `weave.child.sibling.previous` | `alt+h`, then `alt+left` |
| `weave.child.sibling.next` | `alt+l`, then `alt+right` |

The sibling defaults lead with `alt+h` / `alt+l` on purpose: Pi binds `alt+left` / `alt+right` to its own tree folding and pi-tui binds them to word motion, so the arrow forms are second candidates that conflict detection normally skips and reports. `alt+h` and `alt+l` are the keys you can actually press.

Override them under `settings.adapters.pi.child_inspection.keys`, keyed by action id, with a single key string or up to four keys per action. The map is strict: an unknown action id or malformed key syntax is a validation error, never a silent drop.

Every key is checked against your effective Pi keybindings before it is claimed. A key that is already bound stays with its existing owner; the adapter skips its own binding and reports it once as `weave overlay action <id> skipped key <key>: already bound to <owner>`. Weave never overwrites a binding you or another extension already have, and a skipped affordance is not advertised in the key row.

The rest of the overlay's keys are consumed only while it is mounted and focused. They are never registered as Pi shortcuts, so they keep their ordinary meaning everywhere else:

| Key | While the overlay is mounted |
| --- | --- |
| `Escape` | Leaves search when search is open, dismisses the cancel confirmation when it is open, otherwise closes the overlay |
| `Backspace` | Edits the draft; on an empty draft focuses the parent child or closes the overlay |
| `PageUp`, `PageDown`, `Shift+Up`, `Shift+Down`, `Home`, `End` | Scroll the transcript; `End` re-engages the live tail |
| `Enter` | Steers the focused live child (accepts the match while search is open) |
| `Alt+Enter` | Queues a follow-up for the focused live child |
| `/` | Opens rail search, empty draft only |
| `Ctrl+F` | Opens rail search at any draft, only when the host does not own the key |
| `n`, `N` (aliases `j`, `k`, `Down`, `Up`) | Next and previous match, while search is open |
| `q`, `Q` | Opens the cancel-subtree confirmation, empty draft over a live child only |
| `y`, `n` | Confirm and dismiss, while the cancel confirmation is open |

Escape closes child inspection. One press closes the overlay, returns focus to the parent, and leaves the inspected child running. It never cancels a child and never reaches Pi while the overlay is mounted. In search mode it leaves search instead.

Cancelling is explicit and separate. With an empty overlay draft, `q` or `Q` opens a confirmation whose choices are `Keep running` and `Cancel subtree`, defaulting to `Keep running`. The overlay answers the question itself: while it is open only `y` (confirm), `n` and `Escape` (dismiss) are read, and every other key is swallowed rather than guessed at. Only an explicit `Cancel subtree` cancels; dismissal, an absent choice, or a select failure leaves the child running. With a non-empty draft, `q` types a character as usual, and a settled, orphan, or absent target reports no target instead of prompting for nothing. `q` and `Q` are matched semantically and are never registered as Pi shortcuts, so `q` keeps its ordinary meaning everywhere else.

Backspace edits at the owned editor's cursor when its draft is non-empty. On an empty editor draft it moves focus to the parent child, or closes the overlay when the focused child is already a direct child of the session.

The transcript scrolls with PageUp, PageDown, Shift+Up, Shift+Down, Home, and End, matched by key identity rather than by raw bytes, so legacy, Kitty event-aware, and SS3 encodings of the same key all scroll. `Enter` steers the focused live child and `Alt+Enter` queues a follow-up; a settled or orphan child accepts neither.

Key precedence inside the overlay is stated once and never reordered: **cancel confirmation › search › overlay keys › draft editor**. A key release is dropped before any of it, so one physical press never acts twice.

Two keys are deliberately **not** claimed while the overlay is mounted. `Ctrl+O` is Pi's own tool-expand action for the delegation card; the inspector has one view, so Weave plans no action for it and registers no binding. `Alt+A` and `Alt+T` are Weave's own agent and plan shortcuts, and Pi dispatches extension shortcuts outside a focused `ui.custom` component, so they do not route while the overlay owns input. Closing the overlay restores them.

#### Rail search

Search opens on `/` while the overlay draft is empty. A slash typed into a non-empty steer keeps belonging to the draft; the empty-draft gate is the whole guarantee. `Ctrl+F` is a conflict-safe alias that works whatever the draft holds — but only when the host does not already own the key. The alias is matched by key identity as well as by its legacy `\x06` byte, so a pane that negotiates the Kitty keyboard protocol opens search with `ESC [ 102 ; 5 u` and `ESC [ 102 ; 5 : 1 u` too, and re-opens the committed query for editing with the same press. A key release is not a press and opens nothing. When the host owns the key, every one of those encodings is left alone. Pi normally binds `Ctrl+F` to `tui.editor.cursorRight`, so the alias is usually skipped and reported once as `weave overlay search skipped key ctrl+f: already bound to <owner> (usually tui.editor.cursorRight); / still opens search on an empty draft`. Losing the alias never loses search.

Search is **rail search**. Opening it prepends a SEARCH section to the Status Matrix rail and gives the transcript a two-column marker gutter. Type a query and press `Enter` to run it and latch the anchor; the rail then reports the committed query and the current match position, while a query still being typed is reported as typed. `n` moves to the next match and `N` to the previous one, with `j` / `k` and Down / Up as aliases, and the transcript window follows the rail cursor. `Escape` leaves search only, and the overlay stays mounted. The match list is built from an ANSI-free twin render, so no byte of transcript colour can paint the search rail, and prompt facts cannot reach navigation facts, so the prompt is byte-identical with search open and closed.

Search owns the keyboard while it is open: no key reaches the draft editor, the overlay key actions, or Pi. Control sequences never edit the query, the query is bounded, and a settled or orphan child stays read-only throughout, so search can never steer or follow up. `/`, `n`, and `N` are never registered as Pi shortcuts.

Searching scans every page within the overlay's bounded historical page budget, not just the first page that contains a hit, and merges the matches from all of them in transcript order without duplicates. A match that the bounded window has since trimmed still counts toward the reported total, so the match count is the real total rather than the visible one.

#### Removed surfaces

Four earlier surfaces are gone. If you are upgrading, expect them to be absent rather than hidden behind a setting:

| Removed surface | Replacement |
| --- | --- |
| The three-line compact `weave_delegate` block, with its name/model/level line, activity line, and `run N · action` line. | One framed [delegation card](#delegation-card) per run, with a status-first rail, an assignment row, a Native Line, a balanced edge footer, and a nine-row expanded child viewport. |
| The per-child `full` / `compact` overlay view mode and its in-overlay toggle. | Removed outright. The inspector has one view, and `Ctrl+O` is Pi's own tool-expand action for the card, which Weave never registers. |
| The overlay header's telemetry row (status, model, reasoning level, turn and queue counts, token cost). | The Status Matrix rail, which is the only place child telemetry appears. The header carries identity and parent context only. |
| The duplicate `weave-task` plan-task footer beside the plan widget. | The [Plan Rail](#plan-rail), the single owner of ambient parent context. |

The `child_inspection.keys` map declares no view-toggle action, so a config that names one is a validation error. See the [Weave UI design record](../specs/33-spec-pi-adapter/33-weave-ui-design.md) for why each surface was dropped.

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

Outside the TUI, the same adapter-owned data is reachable through `weave adapter pi children list|show|delete` and `weave adapter pi doctor`. Those commands travel over the engine's opaque adapter-command dispatch: the engine validates the envelope and routes it, while command names, payloads, and results stay adapter-owned. The CLI loads production ports through the thin `@weaveio/weave-adapter-pi/cli` entry and bundles that surface at build time; it does not take a published runtime dependency on the Pi adapter package. Delete resolves the child's immutable origin parent from list metadata (or `--parent-session` when the same child id exists under two parents) and rejects forged parent scopes. List pages are 50 children; entry pages are 100 entries with a cursor. No command returns an absolute session path, with or without `--diagnostic`; `children show --diagnostic` adds only the bounded root-relative session reference. Any other absolute path is replaced with `[path omitted]` unless `--diagnostic` is set. See [CLI](../reference/cli.md#weave-adapter).

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

The [delegation card](#delegation-card) is the tool entry. Its rail names the
child and its state, and its Native Line carries the child's latest meaningful
output. The model and reasoning level come from the same resolution the child's
bootstrap carries, so the card names what the child will actually run on before
it exists.

While a child runs, `weave_delegate` updates the card from Pi's streamed
`message_update` events. Before answer text starts, the Native Line shows the
content-free word `reasoning` so a reasoning child does not look frozen; it
prints `summary · …` only when the host published an explicit
`reasoning_summary`. Raw chain-of-thought never reaches the model-visible line
or the persisted card rows. Once a `text_delta` arrives, answer text replaces
the reasoning line and remains authoritative. Both previews are transient, capped at 4 KiB, and
never persisted. The collapsed Native Line shows the latest whitespace-normalized
240 code points; `Ctrl+O` expands the card to nine literal transcript rows. Spawn failures return the typed code plus the adapter-owned safe message,
closed reason when available, retryability, and recovery hint; raw host errors
and environment values never enter the result.

Pi's `agent_settled` event has no payload. The adapter derives `failed` from the latest assistant `message_end.stopReason` when it is `error` or `aborted`; every other case, including no observed reason, settles as `completed`. Once cancellation is admitted, that child cannot report `completed`.

A `failed` verdict is captured immediately but published on a bounded deferral, because a context-compaction extension can force a threshold compaction by aborting the run and then compacting from its own `agent_settled` handler. Pi awaits extension handlers sequentially, so the adapter returns from `agent_settled` at once instead of blocking that chain. Only the structural compaction lifecycle decides the outcome. `session_before_compact` or `session_compact` is recorded in either handler order: after the abort it moves the captured verdict to a ten-minute resume window, and before the abort it opens a five-second evidence window that sends the next captured verdict straight to that same resume window. The next `turn_start` discards the captured verdict only when compaction evidence was recorded for it; a turn that starts with no such evidence is an unrelated turn, so the captured verdict is published at once and the gate closes, and lifecycle evidence that arrives after that turn began can never adopt it. Error prose is never used to detect compaction.

A captured verdict is therefore terminal unless compaction evidence releases it before the child's next turn starts. If no compaction starts, or compaction starts but the child never resumes, it is published unchanged with its original sanitized reason, and a later settlement of an unrelated run cannot replace it with success. A settlement that follows compaction evidence is the resumed run's own outcome and is reported normally. Cancellation closes the gate before `cancelled` is published, so no armed timer can publish a second verdict afterward. Exactly one settlement is reported, no settlement is lost, and no state is unbounded.

Completed settlement fields have one meaning each: `assistantOutput` is the
bounded parent projection, `completionCandidate` is direct-step structured JSON,
`outputTransferId` references an ACKed private transfer, and
`outputByteLength` is numeric metadata. Output above the 64 KiB projection cap is
transferred before settlement. A failed output transfer still produces one
bounded inline settlement. The inspector/history sink receives full output;
controller, delegation-tool, and workflow results receive only the bounded
projection plus numeric metadata.

Diagnostic prose follows one shared projection policy: 32 KiB of UTF-8, an
explicit truncation marker, and a cut that never splits a code point. It covers
the settlement failure reason and the protocol `cancel` and `error` reasons
alike. Producers project before signing and the schemas admit the projected
value, because rejecting a body over its display text would discard the typed
code that body carries.

The private output capture carries its own provenance, because the four
possible sources are not interchangeable. `transferred-candidate` and
`inline-candidate` are the child's verified structured completion candidate,
`transferred-output` is its complete free-text terminal output, and
`observed-terminal` is only the last terminal assistant message the parent
happened to observe. A direct workflow step persists a candidate source and
nothing else: a capture whose provenance is observed prose, or one that
disagrees with the settled candidate, fails closed instead of durably storing
unrelated assistant text as the step's result.

### Durable results

Complete authoritative output is appended to the child's own native session as
a group of 48 KiB UTF-8 chunks followed by one commit record holding the chunk
count, exact byte total, and SHA-256 digest. Nothing accepts a result before
that commit exists, so an interrupted or refused append leaves no partially
accepted output.

Appends are authorized by immutable identity, not reachability. The caller
supplies the child component, native session id, and origin parent it
provisioned, and all three must still hold on the reopened session, so a
sibling child of the same parent is refused.

Because the host append is path-backed, no check the writer performs can cover
the write itself, so the writer does not decide acceptance. The commit record
*carries* the identity it was authorized against: the child component, native
session id, origin parent, and the `{dev,ino}` of the exact leaf observed under
the held no-follow directory before the first chunk landed. Every reader
recomputes all five. A commit that reached a replaced leaf therefore names a
file it is not in, and no reader accepts that group — a replacement during the
commit leaves no readable committed result, whatever the writer returned. The
write still fails closed as early as it can: chunks, then a re-proof of the
leaf and the live session id, then the commit, then a final leaf check.

Reading is authorized by the same identity. A caller states the exact child,
native session, and origin parent whose result it wants; all three are proven
against the session header before any scan and against the commit before the
group is accepted. Continuation cursors are bound to that identity and to the
exact commit (result id and digest), so a cursor from another child, another
session, or a changed commit fails typed instead of paging unrelated bytes.

Reading is also bounded and paged. Verification makes two passes — one backward
pass that locates the newest commit and its first chunk, one forward pass that
streams chunks in ascending order and hashes incrementally — retaining at most
one requested content window. Each pass gets its own page and byte budget,
derived from the *encoded* maximum: a full 48 KiB chunk where every byte takes
its worst-case six-byte JSON escape, times the chunk count a 64 MiB result can
reach, plus the commit line and a fixed slack. Budgets are per pass because a
shared total would have to be split among the passes, and a group at the
retained cap would exhaust it before the last pass finished.

This is why the 64 MiB result ceiling does not contradict the 8 MiB
whole-session read ceiling: results are never read whole. When a session grows
past that read ceiling, session identity falls back to a bounded header-line
read and thread metadata falls back to bounded pages, so restart recovery keeps
working instead of reporting a healthy large session as corrupt.

A direct workflow step persists its authoritative result *before* it writes any
terminal lifecycle record. A durable `completed` lifecycle asserts that the
step's result is retrievable, so it is never written first and then
contradicted: when persistence fails, the step settles failed and the single
terminal lifecycle record says `failed`.

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

### Host runtime resolution

The package ships two extension files. `dist/extension.js` is a thin loader that imports no Pi package; `dist/extension-impl.js` holds the adapter. Pi awaits the loader's async factory, so the loader completes before `session_start`.

The loader resolves `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and the one subpath the adapter imports directly, `@earendil-works/pi-ai/providers/openai-codex`, to the copies the running host already evaluated. The subpath is proven separately because it resolves to its own file: redirecting the `pi-ai` package entry says nothing about it. Without it, Bun's native import resolves those bare specifiers from the extension's own directory, so a nested copy silently wins and a second Pi runtime is evaluated inside the host process. The loader proves the host package root from the running CLI entry, confirms that root's `package.json` name and version, and installs one exact-path load override per differing specifier that re-exports the host entry. The bare `pi-ai` specifier targets the host's compat entry, matching Pi's own alias table. Only then does the loader import the implementation.

Redirection is fail-open. An unproven host root, a mismatched host package, a missing local copy, a local copy that is already the host copy, an unsafe path, or an unavailable plugin surface skips that specifier with a closed reason and preserves the previous behavior. The extension never fails to load because a redirect did not happen. Setting `WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1` skips every specifier; it is the operator escape hatch and the negative control for verification.

`/weave:health` carries one path-free line: `host runtime: single-copy; redirected <n>`, or `host runtime: duplicate-detected (host-runtime-duplicate); redirected <n>` when the imported `VERSION` disagrees with the proven host `package.json` version. The proven version wins, so every host-version gate reasons about the real host. **Duplicate detection is warning-only.** It never enters health-only mode, because the mismatch removes no declared capability and health-only would break a session mid-upgrade. The compatibility floor above is unchanged.

Consumers that need a specific copy read that outcome as provenance: one specifier is `host` when it was redirected to the host file or already was it, and `unproven` with a bounded reason otherwise. The codex fast provider registration is the first such consumer and refuses to run on anything but `host`.

Setting `WEAVE_PI_HOST_MODULE_PROOF=1` writes exactly one bounded JSON line to stderr with the host root, host version, and per-specifier resolutions. That line carries absolute paths, so it is strictly opt-in and no other surface prints them. `bun run verify:pi-host-singleton` reads it against a real Pi process; see [Adapter Verification](../testing/adapter-verification.md#prove-one-host-runtime-copy-pi).

## Health-only mode

Static capability declarations are ceilings. Activation probes every closed capability ID once. Any missing, failed, degraded, or unsupported required effective capability enters health-only mode; optional gaps warn.

Health-only mode exposes health and safe diagnostics but blocks materialization, workflow mutation, and delegation. Pi/tool-owner authorization remains in force regardless of mode.

## Pi-native path sessions

Pi addresses native sessions by filesystem path. Containment is therefore proven by the adapter, not claimed from the host:

1. The adapter resolves its fixed session root under the trusted XDG data base, creates a private `0700` child directory, and hands that exact directory to `SessionManager.create`.
2. It validates Pi's generated leaf as a canonical immediate child of that directory, never a path prefix, and validates the generated v3 header, session ID, parent link, and `cwd`.
3. Because Pi defers the first write, the adapter exclusively creates the absent `0600` leaf with Pi's exact generated header bytes plus a newline. It never invents, alters, or reorders a header field.
4. It reopens the leaf through `SessionManager.open` and revalidates path, directory, header, session ID, parent, `cwd`, and persistence before any spawn.
5. The session store mints an opaque launch grant for that validated session and for the exact child that will start. A grant is minted only from a session record the store itself validated and returned; provenance is object identity, so a structurally identical record built by a caller, copied, or produced by another store carries no proof and is refused. Before minting, the store reopens the proven reference and revalidates the complete header, and it refuses the grant when the reopened identity differs from the one it validated.
6. The grant is bound to the generation's validated root, the validated child directory, the validated session file, the root-relative reference, the session identity, the child id that will launch, the active leaf, and the optional checkpoint cursor.
7. The RPC child redeems the grant, then receives both `--session <validated file>` and `--session-dir <validated directory>`. The launch environment drops any inherited `PI_CODING_AGENT_SESSION_DIR` so the explicit argument stays the sole authority.

There is no path-carrying spawn mode. A caller that presents an absolute path, a caller-built session record, a hand-built grant look-alike, a grant minted by another generation, or a grant naming another child is refused before the argument vector exists and before any process starts. A store states whether it may launch at all: a read-only store - diagnostics, history, doctor, inspection - cannot mint a grant.

One strict validator checks the complete Pi v3 header on every lifecycle path: create, the reopen that follows the exclusive header write, the host-backed open used by thread and restore paths, the descriptor-safe whole-session read, the bounded paging read, and the grant mint. An unknown, inherited, accessor, symbol-keyed, non-enumerable, wrongly typed, or missing field fails the session closed instead of being dropped, and an exotic prototype is refused outright. The persisted bytes are therefore always exactly the header Pi generated.

Callers, models, and the engine never supply a path, and no path crosses the adapter boundary into Results, logs, health, status, doctor, CLI output, lifecycle metadata, or model content.

Delegation readiness is reported through the required `delegated-specialist-execution` capability. One generation-scoped authority proves three facts and accepts no asserted substitute for any of them:

- Pi's public session API, checked on the host object itself;
- the adapter-owned session root, *proven* by really opening it with `openat(O_NOFOLLOW)` through the production filesystem port and probing it descriptor-relatively, so an absent, uncreatable, symlinked, wrongly typed, permissively moded, or swapped root is a refusal rather than a resolved string. The proof is opaque: a caller cannot read the root off it, and a caller-built look-alike proves nothing;
- the child process launch surface, checked by looking for a callable `spawn` on the launch port rather than trusting a boolean.

That same object feeds capability probing, the session sources, the session store that mints grants, the delegation controller, direct dispatch, and every child launch. It is mandatory everywhere: readiness probing requires a verdict and treats an absent one as unavailable, and thread sources refuse to build storage over a root the authority did not prove. Readiness therefore cannot disagree with launch: a ready generation holds the authority its spawns consume. When any fact is missing, the generation stays health-only before spawn and reports exactly one closed, path-free reason: `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable`. No environment variable or configuration setting can raise it.

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
