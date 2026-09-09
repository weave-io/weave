/**
 * Sealed V2 SDK boundary.
 *
 * This is the server SDK boundary in `@weaveio/weave-adapter-opencode2`, permitted to
 * import from `@opencode-ai/plugin`, `@opencode-ai/sdk`, or
 * `@opencode-ai/client`. All other adapter modules MUST import the
 * Weave-local `V2*` aliases re-exported from this module instead of reaching
 * into the SDK directly. This insulates the rest of the adapter from V2 SDK
 * version churn and keeps the harness boundary auditable at a glance (one
 * `grep` for server SDK imports outside this file should return nothing).
 * The optional UI runtime is isolated in sdk-ui.ts so server imports never load it.
 *
 * This file MUST NOT import anything from `packages/adapters/opencode/`
 * (the V1 adapter). The V1 and V2 adapters are independent, parallel
 * implementations — see `docs/specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md`.
 *
 * Only types the V2 adapter actively consumes (per Spec 34, tasks C3-C12)
 * are re-exported here. Unused SDK surface is intentionally omitted to keep
 * this boundary minimal and reviewable.
 */

import type {
  Agent as AgentNamespace,
  Command as CommandNamespace,
  Plugin as PluginModule,
  Skill as SkillNamespace,
} from "@opencode-ai/plugin";

export type {
  OpenCodeEvent as V2OpenCodeEvent,
  SkillInfo as V2NativeSkillInfo,
} from "@opencode-ai/client";
export {
  Agent as V2Agent,
  Model as V2Model,
  /**
   * Namespace-style export of the `Plugin` module (`Plugin.define`,
   * `Plugin.Context`, `Plugin.Plugin`, `Plugin.Cleanup`) — re-exported under
   * a Weave-local name so call sites never import `@opencode-ai/plugin`
   * directly.
   */
  Plugin as V2PluginModule,
  Provider as V2Provider,
  Skill as V2Skill,
} from "@opencode-ai/plugin";
export type {
  RpcHandlers as V2RpcHandlers,
  RpcRegistration as V2RpcRegistration,
} from "@opencode-ai/plugin/promise/rpc";
export { Rpc as V2Rpc } from "@opencode-ai/plugin/rpc";
export type { Context as V2TuiContext } from "@opencode-ai/plugin/tui/context";

/**
 * The plugin definition shape passed to `Plugin.define()` — used when the
 * adapter registers itself as an OpenCode V2 plugin.
 */
export type V2PluginDefinition = PluginModule.Plugin;

/**
 * The `setup(context)` callback's context object — the root of the V2
 * plugin API surface (`agent`, `session`, `catalog`, `event`, `skill`,
 * `command`, `permission`, `rpc`, etc).
 */
export type V2Context = PluginModule.Context;

/**
 * Return type of a plugin's `setup()` function — an optional teardown
 * callback invoked when the plugin is deactivated.
 */
export type V2Cleanup = PluginModule.Cleanup;

/**
 * Agent descriptor as returned by `ctx.agent.list()` / `ctx.agent.get()` and
 * mutated via the `AgentEditor` inside `ctx.agent.transform()`.
 */
export type V2AgentInfo = AgentNamespace.Info;

/**
 * Command descriptor as returned by `ctx.command.list()` and added via the
 * `CommandEditor` inside `ctx.command.transform()`.
 */
export type V2CommandInfo = CommandNamespace.Info;

/**
 * Skill descriptor as returned by `ctx.skill.list()` / `ctx.skill.get()` and
 * mutated via the `SkillEditor` inside `ctx.skill.transform()`.
 */
export type V2SkillInfo = SkillNamespace.Info;

export type {
  /** Output of the model-default RPC. */
  ModelDefaultOutput as V2CatalogModelDefaultOutput,
  /** Model descriptor as read from `ctx.catalog.model.get()`. */
  ModelInfo as V2CatalogModelInfo,
  /** Output of the model-list RPC. */
  ModelListOutput as V2CatalogModelListOutput,
  /** A permission evaluation in flight inside a `ctx.permission.hook()` callback. */
  PermissionAsked as V2PermissionAsked,
  /** Emitted once a permission request has been answered. */
  PermissionReplied as V2PermissionReplied,
  /**
   * A single permission rule (`{ action, resource, effect }`) as read from
   * or written to session/agent permission configuration.
   */
  PermissionRule as V2Rule,
  /** An ordered list of `V2Rule` entries. */
  PermissionRuleset as V2Ruleset,
  /** Provider descriptor as read from `ctx.catalog.provider.list()`. */
  ProviderInfo as V2CatalogProviderInfo,
  /** Output of the provider-list RPC. */
  ProviderListOutput as V2CatalogProviderListOutput,
  /** Input accepted by `ctx.session.generate()`. */
  SessionGenerateInput as V2SessionGenerateInput,
  /** Output produced by `ctx.session.generate()`. */
  SessionGenerateOutput as V2SessionGenerateOutput,
  /** Session descriptor as returned by `ctx.session.get()` / list RPCs. */
  SessionInfo as V2SessionInfo,
  /** Input accepted by `ctx.session.prompt()`. */
  SessionPromptInput as V2SessionPromptInput,
  /** Output produced by `ctx.session.prompt()`. */
  SessionPromptOutput as V2SessionPromptOutput,
  /**
   * The full discriminated union of every V2 event payload delivered via
   * `ctx.event.subscribe()` / `event.subscribe()`.
   */
  V2Event,
} from "@opencode-ai/client";
export type {
  /** The `ctx.agent` sub-API surface. */
  AgentDomain as V2AgentDomain,
  /** Agent-list/get editor exposed inside `ctx.agent.transform()`. */
  AgentEditor as V2AgentEditor,
} from "@opencode-ai/plugin/promise/agent";
export type {
  /** The `ctx.catalog` sub-API surface. */
  CatalogDomain as V2CatalogDomain,
  /** Catalog editor exposed inside `ctx.catalog.transform()`. */
  CatalogEditor as V2CatalogEditor,
  /** A single provider + its models as seen inside `CatalogEditor`. */
  CatalogProviderRecord as V2CatalogProviderRecord,
} from "@opencode-ai/plugin/promise/catalog";
export type {
  /** A command definition added via `CommandEditor.add()`. */
  CommandDefinition as V2CommandDefinition,
  /** The `ctx.command` sub-API surface. */
  CommandDomain as V2CommandDomain,
  /** Command editor exposed inside `ctx.command.transform()`. */
  CommandEditor as V2CommandEditor,
  /** Input passed to a `CommandDefinition.execute()` callback. */
  CommandInvocation as V2CommandInvocation,
} from "@opencode-ai/plugin/promise/command";
export type {
  /** The `ctx.event` sub-API surface (`event.subscribe()`). */
  EventDomain as V2EventDomain,
} from "@opencode-ai/plugin/promise/event";
export type {
  /** The `ctx.permission` sub-API surface. */
  PermissionDomain as V2PermissionDomain,
  /** Permission evaluation payload delivered to `ctx.permission.hook("evaluate", ...)`. */
  PermissionEvaluation as V2PermissionEvaluation,
} from "@opencode-ai/plugin/promise/permission";
export type {
  /**
   * A registration handle returned by hook/transform registration calls
   * (`ctx.agent.transform`, `ctx.session.hook`, `ctx.rpc.register`, etc).
   * `dispose()` removes only the effect owned by that registration.
   */
  Registration as V2Registration,
} from "@opencode-ai/plugin/promise/registration";
export type {
  /** Hook payload delivered to a `ctx.session.hook("context", ...)` callback. */
  SessionContext as V2SessionContext,
  /** The `ctx.session` sub-API surface. */
  SessionDomain as V2SessionDomain,
  /** Hook payload for `ctx.session.hook("http.request", ...)`. */
  SessionHttpRequest as V2SessionHttpRequest,
  /** Hook payload for `ctx.session.hook("http.response", ...)`. */
  SessionHttpResponse as V2SessionHttpResponse,
  /** Hook payload for `ctx.session.hook("model.request", ...)`. */
  SessionModelRequest as V2SessionModelRequest,
  /** Hook payload delivered to a `ctx.session.hook("prompt", ...)` callback. */
  SessionPrompt as V2SessionPrompt,
  /** Discriminates why a Session model request is being made. */
  SessionRequestKind as V2SessionRequestKind,
  /** Hook payload for `ctx.session.hook("retry", ...)`. */
  SessionRetry as V2SessionRetry,
  /** Retry decision produced by `ctx.session.hook("retry", ...)`. */
  SessionRetryDecision as V2SessionRetryDecision,
} from "@opencode-ai/plugin/promise/session";
export type {
  /** The `ctx.skill` sub-API surface. */
  SkillDomain as V2SkillDomain,
  /** Skill editor exposed inside `ctx.skill.transform()`. */
  SkillEditor as V2SkillEditor,
} from "@opencode-ai/plugin/promise/skill";
export type {
  /** Tool call identifier. */
  CallID as V2ToolCallID,
  /** A registered tool definition. */
  Info as V2ToolInfo,
  /** Tool execution metadata (progress updates). */
  Metadata as V2ToolMetadata,
  /** Tool definition options. */
  Options as V2ToolOptions,
  /** Tool execution result. */
  Result as V2ToolResult,
  /** Execution context passed to a tool's `execute()` callback. */
  ToolContext as V2ToolContext,
  /** The `ctx.tool` sub-API surface. */
  ToolDomain as V2ToolDomain,
  /** Tool editor exposed inside `ctx.tool.transform()`. */
  ToolEditor as V2ToolEditor,
} from "@opencode-ai/plugin/promise/tool";
export { Error as V2ToolError } from "@opencode-ai/plugin/promise/tool";

import type { OpenCode } from "@opencode-ai/client";

export type {
  /** The generated V2 SDK client factory return type. */
  OpenCodeClient as V2OpenCodeClient,
} from "@opencode-ai/client";

/**
 * Client configuration options — used when constructing a standalone V2
 * SDK client (outside the plugin `Context`).
 */
export type V2ClientOptions = Parameters<typeof OpenCode.make>[0];
