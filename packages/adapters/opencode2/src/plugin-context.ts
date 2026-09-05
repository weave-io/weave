/**
 * Narrow facade over the V2 plugin `Context`.
 *
 * This module — together with `./sdk-types` — is the seam that keeps the
 * rest of the V2 adapter testable without a live `opencode2` process.
 * Downstream adapter modules (C4–C12) must depend on `PluginContextFacade`,
 * never on `V2Context` or any other type re-exported from `./sdk-types`
 * directly. All V2 type references in this file flow through `./sdk-types`,
 * per the sealed-SDK-boundary rule documented there.
 *
 * ## Envelope unwrap (A4 finding)
 *
 * The underlying V2 RPC list APIs (`ctx.agent.list`, `ctx.catalog.provider.list`,
 * `ctx.catalog.model.list`, `ctx.catalog.model.default`, `ctx.skill.list`) do
 * not return a bare array/value — they return an envelope shaped
 * `{ location, data }`. This facade unwraps `.data` for ergonomics so every
 * downstream module works with plain arrays (or, for `model.default`, a
 * single nullable value) instead of re-deriving the envelope shape at every
 * call site.
 *
 * ## Lazy `transform` effects (A4/A5 finding)
 *
 * `agent.transform` and `catalog.transform` editor callbacks are **not**
 * guaranteed to have applied their effect synchronously by the time the
 * transform's own returned `Promise<V2Registration>` resolves. Callers that
 * need to observe the effect must re-query via `agent.list()` /
 * `catalog.*` accessors afterward — this facade does not, and must not,
 * attempt to force synchronous visibility.
 *
 * `command.transform` is the one domain observed (A4) to apply its effect
 * immediately and visibly via a subsequent `command.list()`-style read, but
 * this facade does not expose `command.list()` (not needed by the adapter
 * yet) — only `command.transform`.
 *
 * ## Cancellation
 *
 * `event.subscribe` accepts only an optional `{ signal? }` and returns a
 * plain `AsyncIterable<V2Event>`. There is no `Registration`-style dispose
 * handle for event subscriptions — cancel by aborting the provided
 * `AbortSignal`.
 */

import type {
  V2AgentDomain,
  V2AgentEditor,
  V2AgentInfo,
  V2CatalogEditor,
  V2CatalogModelInfo,
  V2CatalogProviderInfo,
  V2CommandEditor,
  V2Context,
  V2Event,
  V2EventDomain,
  V2Registration,
  V2SessionDomain,
  V2SkillEditor,
  V2SkillInfo,
} from "./sdk-types.js";

/**
 * `ctx.agent` sub-domain, narrowed to what the adapter uses. `list()` is
 * unwrapped to a plain array (see header). `reload()` is confirmed present
 * on the real V2 `AgentDomain` type (A4/C3 verification) — it is not
 * speculative.
 */
export interface PluginContextAgentFacade {
  readonly transform: (
    callback: (editor: V2AgentEditor) => void,
  ) => Promise<V2Registration>;
  readonly reload: V2AgentDomain["reload"];
  readonly list: () => Promise<readonly V2AgentInfo[]>;
}

/**
 * `ctx.catalog` sub-domain, narrowed to what the adapter uses. `provider.list`,
 * `model.list`, and `model.default` are unwrapped to plain values (see
 * header).
 */
export interface PluginContextCatalogFacade {
  readonly provider: {
    readonly list: () => Promise<readonly V2CatalogProviderInfo[]>;
  };
  readonly model: {
    readonly list: () => Promise<readonly V2CatalogModelInfo[]>;
    readonly default: () => Promise<V2CatalogModelInfo | null>;
  };
  readonly transform: (
    callback: (editor: V2CatalogEditor) => void,
  ) => Promise<V2Registration>;
}

/** `ctx.skill` sub-domain, narrowed to what the adapter uses. */
export interface PluginContextSkillFacade {
  readonly list: () => Promise<readonly V2SkillInfo[]>;
  readonly transform: (
    callback: (editor: V2SkillEditor) => void,
  ) => Promise<V2Registration>;
}

/** `ctx.command` sub-domain, narrowed to what the adapter uses. */
export interface PluginContextCommandFacade {
  readonly transform: (
    callback: (editor: V2CommandEditor) => void,
  ) => Promise<V2Registration>;
}

/**
 * `ctx.session` sub-domain, narrowed to exactly the methods the adapter
 * uses. Signatures are re-derived from `V2SessionDomain` so the facade
 * cannot silently drift from the real SDK shape.
 */
export interface PluginContextSessionFacade {
  readonly create: V2SessionDomain["create"];
  readonly get: V2SessionDomain["get"];
  readonly prompt: V2SessionDomain["prompt"];
  readonly wait: V2SessionDomain["wait"];
  readonly generate: V2SessionDomain["generate"];
  readonly switchAgent: V2SessionDomain["switchAgent"];
  readonly switchModel: V2SessionDomain["switchModel"];
  readonly interrupt: V2SessionDomain["interrupt"];
  readonly rename: V2SessionDomain["rename"];
}

/**
 * `ctx.event` sub-domain. `subscribe` returns a plain `AsyncIterable<V2Event>`
 * cancelled only via `AbortSignal` (see header).
 */
export interface PluginContextEventFacade {
  readonly subscribe: V2EventDomain["subscribe"];
}

/**
 * `ctx.tool` sub-domain. Not used by the V2 adapter yet — kept as an empty,
 * explicitly-typed placeholder so future tasks can extend it without
 * widening the facade's import surface today.
 */
export type PluginContextToolFacade = Record<string, never>;

/**
 * Narrow facade over the V2 plugin `Context`, exposing only the sub-domains
 * the `@weaveio/weave-adapter-opencode2` package uses. See module header for
 * the envelope-unwrap and lazy-transform rules that govern this shape.
 */
export interface PluginContextFacade {
  readonly agent: PluginContextAgentFacade;
  readonly catalog: PluginContextCatalogFacade;
  readonly skill: PluginContextSkillFacade;
  readonly command: PluginContextCommandFacade;
  readonly session: PluginContextSessionFacade;
  readonly event: PluginContextEventFacade;
  readonly tool: PluginContextToolFacade;
}

/**
 * Adapts a real V2 plugin `ctx` (delivered to `Plugin.define({ setup(ctx) })`
 * or obtained via `OpenCode.create` embedding) into `PluginContextFacade`.
 */
export function fromLiveContext(ctx: V2Context): PluginContextFacade {
  return {
    agent: {
      transform: (callback) => ctx.agent.transform(callback),
      reload: () => ctx.agent.reload(),
      // The RPC-facing `AgentInfo` (client-generated, plain `string` id) and
      // the schema-facing `V2AgentInfo` (`Agent.Info`, branded `Agent.ID`)
      // are structurally identical at runtime but nominally distinct types
      // — the brand is a compile-time-only marker. Safe to assert here.
      list: async () =>
        (await ctx.agent.list()).data as unknown as readonly V2AgentInfo[],
    },
    catalog: {
      provider: {
        list: async () => (await ctx.catalog.provider.list()).data,
      },
      model: {
        list: async () => (await ctx.catalog.model.list()).data,
        default: async () => (await ctx.catalog.model.default()).data,
      },
      transform: (callback) => ctx.catalog.transform(callback),
    },
    skill: {
      // Same brand-only mismatch as `agent.list` above (`Skill.ID`).
      list: async () =>
        (await ctx.skill.list()).data as unknown as readonly V2SkillInfo[],
      transform: (callback) => ctx.skill.transform(callback),
    },
    command: {
      transform: (callback) => ctx.command.transform(callback),
    },
    session: {
      create: (input, requestOptions) =>
        ctx.session.create(input, requestOptions),
      get: (input, requestOptions) => ctx.session.get(input, requestOptions),
      prompt: (input, requestOptions) =>
        ctx.session.prompt(input, requestOptions),
      wait: (input, requestOptions) => ctx.session.wait(input, requestOptions),
      generate: (input, requestOptions) =>
        ctx.session.generate(input, requestOptions),
      switchAgent: (input, requestOptions) =>
        ctx.session.switchAgent(input, requestOptions),
      switchModel: (input, requestOptions) =>
        ctx.session.switchModel(input, requestOptions),
      interrupt: (input, requestOptions) =>
        ctx.session.interrupt(input, requestOptions),
      rename: (input, requestOptions) =>
        ctx.session.rename(input, requestOptions),
    },
    event: {
      subscribe: (options) => ctx.event.subscribe(options),
    },
    tool: {},
  };
}

export type { V2Event };
