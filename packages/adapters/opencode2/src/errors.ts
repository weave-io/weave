/**
 * V2-only discriminated error union for `@weaveio/weave-adapter-opencode2`.
 *
 * These variants are derived independently from Phase A feasibility
 * findings (`.weave/learnings/opencode2-adapter.md`) and Spec 33 §5–§6, not
 * mirrored from `packages/adapters/opencode/`'s error union. Overlap with V1
 * variant names, if any, is coincidental — each variant here exists because
 * a specific V2-only failure mode was identified during Phase A probing or
 * is required by Spec 33's reconciliation policy.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) or from `@opencode-ai/*` directly — only plain types are defined
 * here, with any SDK-shaped context fields typed via `./sdk-types` aliases.
 *
 * Every fallible V2 adapter module (Phase C) should return
 * `Result<T, OpenCode2AdapterError>` / `ResultAsync<T, OpenCode2AdapterError>`
 * using variants from this union.
 */

import type { V2AgentInfo } from "./sdk-types.js";

/**
 * The plugin context facade could not be constructed or activated —
 * `OpenCode.create()` / `Host.resolve()` threw, or the mandatory
 * `awaitActivation()` call (A3 finding: setup effects are NOT applied
 * synchronously by `OpenCode.create`) failed or timed out.
 */
export interface PluginContextInitError {
  readonly type: "PluginContextInitError";
  readonly stage: "create" | "resolve" | "awaitActivation";
  readonly cause?: unknown;
}

/**
 * `ctx.agent.transform()` rejected, or the post-await verification read
 * (`ctx.agent.list()`) needed because transform effects are applied lazily
 * (A4/A5 finding) did not reflect the expected agent state.
 */
export interface AgentReconciliationError {
  readonly type: "AgentReconciliationError";
  readonly agentId: string;
  readonly stage: "transform" | "verify";
  readonly cause?: unknown;
}

/**
 * A foreign (non-Weave-owned) agent already occupies the id Weave wants to
 * register. Spec 33's default reconciliation policy is a hard error rather
 * than silent overwrite or rename.
 */
export interface ForeignAgentCollision {
  readonly type: "ForeignAgentCollision";
  readonly agentId: string;
  readonly foreignAgent?: V2AgentInfo;
}

/**
 * A subagent declared an explicit model id that is not present in the
 * catalog returned by `ctx.catalog.model.list()`.
 */
export interface MissingCatalogEntry {
  readonly type: "MissingCatalogEntry";
  readonly agentId: string;
  readonly modelId: string;
}

/**
 * `ctx.catalog.provider.list()` / `ctx.catalog.model.list()` /
 * `ctx.catalog.model.default()` rejected or returned a malformed envelope.
 */
export interface CatalogUnavailable {
  readonly type: "CatalogUnavailable";
  readonly stage: "provider.list" | "model.list" | "model.default";
  readonly cause?: unknown;
}

/** `ctx.skill.list()` rejected or returned a malformed envelope. */
export interface SkillListError {
  readonly type: "SkillListError";
  readonly cause?: unknown;
}

/** `ctx.skill.transform()` rejected while registering a skill. */
export interface SkillRegistrationError {
  readonly type: "SkillRegistrationError";
  readonly skillName: string;
  readonly cause?: unknown;
}

/** `ctx.command.transform()` rejected while registering a command. */
export interface CommandRegistrationError {
  readonly type: "CommandRegistrationError";
  readonly commandName: string;
  readonly cause?: unknown;
}

/**
 * One of `ctx.session.create/get/prompt/wait/generate/switchAgent/switchModel/interrupt/rename` rejected.
 */
export interface SessionOperationError {
  readonly type: "SessionOperationError";
  readonly operation:
    | "create"
    | "get"
    | "prompt"
    | "wait"
    | "generate"
    | "switchAgent"
    | "switchModel"
    | "interrupt"
    | "rename";
  readonly sessionId?: string;
  readonly cause?: unknown;
}

/**
 * `ctx.event.subscribe()` failed to establish, or the `AsyncIterable`
 * iteration itself threw. Recall (A4 finding) there is no `Registration`
 * handle here — cancellation is purely `AbortSignal`-driven, so this
 * variant covers subscription/iteration failures only, not dispose errors.
 */
export interface EventSubscriptionError {
  readonly type: "EventSubscriptionError";
  readonly cause?: unknown;
}

/**
 * `Registration.dispose()` (returned by `agent.transform` / `catalog.transform`
 * / `skill.transform` / `command.transform`) rejected or threw during
 * adapter teardown.
 */
export interface RegistrationDisposeError {
  readonly type: "RegistrationDisposeError";
  readonly domain: "agent" | "catalog" | "skill" | "command";
  readonly cause?: unknown;
}

/**
 * Discriminated union of every failure mode a Phase C V2 adapter module can
 * surface. Discriminate on `type`.
 */
export type OpenCode2AdapterError =
  | PluginContextInitError
  | AgentReconciliationError
  | ForeignAgentCollision
  | MissingCatalogEntry
  | CatalogUnavailable
  | SkillListError
  | SkillRegistrationError
  | CommandRegistrationError
  | SessionOperationError
  | EventSubscriptionError
  | RegistrationDisposeError;

export function pluginContextInitError(
  stage: PluginContextInitError["stage"],
  cause?: unknown,
): PluginContextInitError {
  return { type: "PluginContextInitError", stage, cause };
}

export function agentReconciliationError(
  agentId: string,
  stage: AgentReconciliationError["stage"],
  cause?: unknown,
): AgentReconciliationError {
  return { type: "AgentReconciliationError", agentId, stage, cause };
}

export function foreignAgentCollision(
  agentId: string,
  foreignAgent?: V2AgentInfo,
): ForeignAgentCollision {
  return { type: "ForeignAgentCollision", agentId, foreignAgent };
}

export function missingCatalogEntry(
  agentId: string,
  modelId: string,
): MissingCatalogEntry {
  return { type: "MissingCatalogEntry", agentId, modelId };
}

export function catalogUnavailable(
  stage: CatalogUnavailable["stage"],
  cause?: unknown,
): CatalogUnavailable {
  return { type: "CatalogUnavailable", stage, cause };
}

export function skillListError(cause?: unknown): SkillListError {
  return { type: "SkillListError", cause };
}

export function skillRegistrationError(
  skillName: string,
  cause?: unknown,
): SkillRegistrationError {
  return { type: "SkillRegistrationError", skillName, cause };
}

export function commandRegistrationError(
  commandName: string,
  cause?: unknown,
): CommandRegistrationError {
  return { type: "CommandRegistrationError", commandName, cause };
}

export function sessionOperationError(
  operation: SessionOperationError["operation"],
  sessionId?: string,
  cause?: unknown,
): SessionOperationError {
  return { type: "SessionOperationError", operation, sessionId, cause };
}

export function eventSubscriptionError(
  cause?: unknown,
): EventSubscriptionError {
  return { type: "EventSubscriptionError", cause };
}

export function registrationDisposeError(
  domain: RegistrationDisposeError["domain"],
  cause?: unknown,
): RegistrationDisposeError {
  return { type: "RegistrationDisposeError", domain, cause };
}
