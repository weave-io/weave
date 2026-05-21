import type { AgentDescriptor } from "./compose.js";
import type { SkillInfo } from "./skill-resolution.js";

// ---------------------------------------------------------------------------
// Transitional adapter-boundary types
//
// These interfaces predate the explicit engine/adapter boundary documented in
// docs/adapter-boundary.md. They are kept so the current package compiles, but
// they are not architectural precedent for new APIs.
//
// Future specs should move harness-owned context (skills, lifecycle events,
// available models, selected model state) into adapter-supplied inputs for pure
// engine composition helpers rather than making the engine discover or register
// concrete harness resources directly.
// ---------------------------------------------------------------------------

/**
 * Transitional configuration for a lifecycle hook registered with the harness.
 *
 * TODO(#9): replace/reframe this around an abstract lifecycle policy surface
 * where adapters map concrete harness events into engine-owned policy handlers.
 */
export interface HookConfig {
  name: string;
  enabled: boolean;
  event: string;
}

/**
 * Transitional configuration for a skill loadable by the harness.
 *
 * @deprecated Use `loadAvailableSkills()` instead. Skill discovery/loading is
 * adapter-owned; the engine receives adapter-provided `SkillInfo` values and
 * resolves them against `AgentConfig.skills` and `disabled.skills`.
 */
export interface SkillConfig {
  name: string;
  path?: string;
  scope: "global" | "project";
}

/**
 * The `HarnessAdapter` interface abstracts harness-specific materialisation
 * behind a uniform contract. Each supported agent harness (OpenCode, Pi,
 * Claude Code, …) ships its own implementation of this interface.
 *
 * Boundary rule: the engine may pass normalized Weave intent through this
 * interface, but it must not make harness-specific assumptions such as where
 * skills live, how lifecycle hooks are registered, or how selected model state
 * is queried. Adapters own those details and provide explicit context to engine
 * composition helpers.
 */
export interface HarnessAdapter {
  /**
   * Perform any one-time initialisation required by the harness before
   * normalized Weave intent can be materialised. Called exactly once by
   * `WeaveRunner.run()` before any other adapter method.
   */
  init(): Promise<void>;

  /**
   * Materialise a new sub-agent from the provided normalized descriptor.
   *
   * The adapter owns concrete harness translation (display names, prompt/model
   * fields, tool names, and feature-gap emulation).
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   */
  spawnSubagent(descriptor: AgentDescriptor): Promise<void>;

  /**
   * Register a lifecycle hook with the harness so that it fires at the
   * appropriate point in the agent's execution lifecycle.
   *
   * @deprecated **Superseded** by the Execution Lifecycle Surface in
   * `execution-lifecycle.ts`. Adapters should map concrete harness events into
   * the 7 typed engine lifecycle functions instead of registering hooks through
   * this method:
   *
   * - `observeSession`      — adapter reports a normalized session observation
   * - `startExecution`      — adapter signals a new workflow execution begins
   * - `resumeExecution`     — adapter signals a paused execution resumes
   * - `handleUserInterrupt` — adapter signals a user-initiated interrupt
   * - `dispatchStep`        — adapter requests dispatch of the next workflow step
   * - `completeStep`        — adapter signals that a step has finished
   * - `beforeTool`          — adapter signals that a tool call is about to execute
   *
   * The lifecycle surface accepts a `RuntimeStore` and returns typed
   * `ResultAsync<Output, LifecycleError>` values — no concrete hook
   * registration, no harness-specific callback wiring.
   *
   * This method will be removed once all adapters have migrated to the
   * execution lifecycle surface.
   *
   * @param hook - The hook configuration to register.
   */
  registerHook(hook: HookConfig): Promise<void>;

  /**
   * Load a skill into the harness so that it becomes available to any
   * agent that references it in its `AgentConfig.skills` list.
   *
   * @deprecated Transitional method. Use `loadAvailableSkills()` instead.
   * Skill discovery/loading is adapter-owned; the engine should receive
   * adapter-provided SkillInfo values and resolve them against
   * `AgentConfig.skills` and `disabled.skills`.
   * @param skill - The skill configuration to load.
   */
  loadSkill(skill: SkillConfig): Promise<void>;

  /**
   * Return the list of skills available in this harness instance.
   *
   * The engine calls this once during `WeaveRunner.run()` — after `init()` and
   * before agent materialisation — to obtain the adapter-provided skill context
   * used for skill resolution. The engine matches each agent's declared
   * `skills [...]` entries against `SkillInfo.name` values in the returned
   * list.
   *
   * Adapters own all discovery: filesystem scanning, scope resolution, content
   * loading, and harness-specific mounting details. The engine only uses
   * `SkillInfo.name` for matching; all other fields are adapter-owned
   * pass-through metadata preserved in `ResolvedSkill.skillInfo`.
   *
   * Return an empty array when no skills are available or when the harness does
   * not support skills.
   */
  loadAvailableSkills(): Promise<SkillInfo[]>;
}
