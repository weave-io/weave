# Task A5 — `AgentEditor` create-agent findings

Pinned versions: `@opencode-ai/plugin@0.0.0-beta-19151` (Bun cache key
`0.0.0-b66b2aad47cbb505`), matching `@opencode-ai/sdk`, `@opencode-ai/client`,
`@opencode-ai/cli` at the same pin. Evidence gathered against the container
image built from `.weave/feasibility/opencode2/Containerfile`.

## 1. Verbatim pinned `.d.ts` — `AgentEditor`

Both the promise and effect flavors of `@opencode-ai/plugin` agree on the
`AgentEditor` surface (only the `Agent.Info` mutability wrapper type differs):

`node_modules/@opencode-ai/plugin/dist/promise/agent.d.ts`:

```ts
import type { AgentApi } from "@opencode-ai/client/promise/api";
import type { Agent } from "@opencode-ai/schema/agent";
import type { Transform } from "./registration.js";
import type { DeepMutable } from "./types.js";
export interface AgentEditor {
  list(): readonly DeepMutable<Agent.Info>[];
  get(id: string): DeepMutable<Agent.Info> | undefined;
  default(id: string | undefined): void;
  update(id: string, update: (agent: DeepMutable<Agent.Info>) => void): void;
  remove(id: string): void;
}
export interface AgentDomain extends AgentApi {
  readonly transform: Transform<AgentEditor>;
  readonly reload: () => Promise<void>;
}
```

`node_modules/@opencode-ai/plugin/dist/effect/agent.d.ts` is the same shape
(`Types.DeepMutable<Agent.Info>` instead of the promise flavor's local
`DeepMutable<Agent.Info>`, and `Effect.Effect<void>` instead of
`Promise<void>` for `reload`).

**Discrepancy vs. V2 docs**: `https://opencode.ai/v2/docs/build/` documents
`update` / `remove` / `default` but is silent on how to create a brand-new
agent. The pinned type has **no** `add()`, `create()`, `insert()`, or
`set()` method — creation is not a distinct named operation in the type
system at all.

## 2. RPC surface (`ctx.agent` itself, not the editor) has no create either

`AgentDomain extends AgentApi = Client["agent"]`, and the generated RPC
client (`@opencode-ai/client/dist/promise/client.d.ts`) only exposes:

```ts
agent: {
  list: (...) => Promise<AgentListOutput>;
  get: (...) => Promise<AgentGetOutput>;
};
```

No RPC-level `agent.create()` exists either. Any creation must happen
through the synchronous in-process `AgentEditor` inside `transform()`.

## 3. The schema's `Agent.Info.default(id)` helper is the key hint

`@opencode-ai/schema/agent` (`dist/agent.d.ts`) exports `Info` as an Effect
`Schema.Struct` augmented with a static-like helper:

```ts
export declare const Info: Schema.Struct<{ ... }> & {
  default: (id: ID) => {
    id: string & Brand<"Agent.ID">;
    name: string & Brand<"Agent.Name">;
    request: { settings: {}; headers: {}; body: {} };
    mode: "primary";
    hidden: false;
    permissions: [...];
  };
};
```

This is a strong hint that the runtime `AgentEditor.update()` implementation
seeds a fresh draft from `Agent.Info.default(id)` when `id` is not already
present, applies the caller's update callback to that draft, and commits it
as a new agent — i.e. `update()` has **upsert** semantics rather than
"update-or-no-op". This hypothesis was confirmed empirically (§4).

## 4. Runtime confirmation — `update()` is the create method

`plugin/agent-create-plugin.ts`, run via `scripts/proof-agent-create.ts`
inside the pinned container, dumped `typeof` for every plausible method name
on the live `AgentEditor` instance:

```json
{
  "list": "function",
  "get": "function",
  "default": "function",
  "update": "function",
  "remove": "function",
  "add": "undefined",
  "create": "undefined",
  "insert": "undefined",
  "set": "undefined"
}
```

`Object.keys(editor)` (own enumerable keys) = `default,get,list,remove,update`
— confirming the pinned `.d.ts` is complete and no undocumented runtime-only
method exists.

Calling `editor.update("weave-a5-probe", (agent) => { agent.name = ...;
agent.description = ...; agent.mode = "subagent"; agent.hidden = false; })`
for an id that did **not** previously exist:

- did not throw,
- `editor.get("weave-a5-probe")` returned the fully-populated agent
  **inside the same transform callback**, immediately after `update()`,
- after the transform settled, `ctx.agent.list()` (the async RPC) showed the
  new agent with the exact fields set via the callback.

**Verdict**: `editor.update(id, updateFn)` is the correct — and only —
`AgentEditor` call sequence for creating a brand-new agent. There is no
separate `add`/`create` method; V2 docs should be corrected to state that
`update()` upserts.

## 5. Foreign same-named agent — read-only classification

**First approach tried, and why it failed**: seeding the foreign agent via
static `config.content` (`OpenCode.create({ config: { content: '{"agent":
{"weave-a5-foreign": {...}}}' } })`). Debug probe (`/tmp/debug-agent2.ts`,
not checked in) showed:

- `ctx.agent.list()` (async RPC) **does** include the config-declared
  `weave-a5-foreign` agent merged in alongside builtins.
- `editor.list()` **inside** `ctx.agent.transform()` does **NOT** include
  it — even after an intervening `await ctx.agent.list()` flush. Only
  builtins (`build`, `general`, `explore`, `compaction`, `title`, `summary`,
  `plan`) appeared in the editor draft.

**Discrepancy vs. assumption**: config-declared agents are not merged into
the synchronous `AgentEditor` draft that `transform()` callbacks observe;
they only ever surface through the async RPC read path. This means a
plugin cannot classify a *config-only* agent as "foreign" from inside
`editor.list()`/`editor.get()` — it would need to cross-reference the async
`ctx.agent.list()` result separately. This is a material finding for Spec
33's reconciliation design (`reconcile-agent.ts` per the plan) — foreign
detection inside `transform()` alone only sees other **transform-registered**
agents (builtins and other plugins), not config-declared ones.

**Working approach**: seed the foreign agent via an independent plugin's own
`agent.transform()` call (`plugin/foreign-agent-seed-plugin.ts`), activated
before the probe plugin in the host's `plugins` array, with an explicit
`await ctx.agent.list()` flush in between to guarantee ordering. This
simulates a real foreign registrant (another plugin/tool), which is the
scenario Spec 33's ownership-marker reconciliation actually needs to defend
against, and it correctly appears in the probe's `editor.list()`.

Result: inside the probe plugin's `ctx.agent.transform()` callback,
`editor.list()` included `weave-a5-foreign` (verified before any mutation
was attempted on Weave's own agent), and after the whole transform settled,
`ctx.agent.list()` showed `weave-a5-foreign` with **identical** `description`
/ `mode` / `hidden` fields to the pre-transform snapshot — confirming it was
read but never mutated.

## 6. Summary / `results.json.agentEditor`

```json
{
  "create": {
    "supported": true,
    "method": "editor.update(id, (agent) => { ...mutate... }) — upsert semantics..."
  },
  "foreignAgentClassification": {
    "observedWithoutMutation": true,
    "unchangedAfterTransform": true
  }
}
```

**Hard-blocker verdict: PASS.** `AgentEditor.update()` supports creation via
upsert, and foreign same-named agents (registered via another plugin's own
`transform()`) can be classified read-only without mutation. Phase B may
proceed on this point, with the caveat recorded in §5 that config-only
foreign agents require cross-referencing `ctx.agent.list()` rather than
relying solely on `editor.list()` inside `transform()` — this must be
reflected in Spec 33's `reconcile-agent.ts` design (Task C7).
