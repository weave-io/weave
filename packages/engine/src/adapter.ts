import type { ResultAsync } from "neverthrow";
import type { AgentDescriptor } from "./compose.js";
import type { SkillInfo } from "./skill-resolution.js";

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
   * normalized Weave intent can be materialised. Called exactly once by the
   * bootstrap entry point before any other adapter method (see
   * `docs/adapter-bootstrap.md`).
   */
  init(): Promise<void>;

  /**
   * Materialise a new sub-agent from the provided normalized descriptor.
   *
   * The adapter owns concrete harness translation (display names, prompt/model
   * fields, tool names, and feature-gap emulation).
   *
   * Returns `ok(undefined)` on success or `err(error)` on failure. Adapters
   * must not throw — all failure paths must be captured in the returned
   * `ResultAsync`.
   *
   * @param descriptor - Full normalized agent descriptor to materialise.
   */
  spawnSubagent(descriptor: AgentDescriptor): ResultAsync<void, Error>;

  /**
   * Return the list of skills available in this harness instance.
   *
   * The engine calls this once during the bootstrap sequence — after `init()`
   * and before agent materialisation (see `docs/adapter-bootstrap.md`) — to
   * obtain the adapter-provided skill context used for skill resolution. The
   * engine matches each agent's declared
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
