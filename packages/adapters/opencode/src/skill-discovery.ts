/**
 * Adapter-local skill validation for the OpenCode adapter.
 *
 * This module provides helpers for working with harness-provided skill data.
 * It does NOT perform filesystem scanning — skill discovery is owned by the
 * OpenCode harness (SDK/runtime), which tells the adapter which skills are
 * available. The adapter's role is to:
 *
 * 1. Accept the harness-provided `SkillInfo[]` list (injected at construction
 *    time or supplied by the SDK at runtime).
 * 2. Validate declared skill names against that list.
 * 3. Surface missing declared skills as hard errors so the engine's
 *    `resolveSkillsForAgent()` can emit `MissingSkill` errors.
 *
 * ## Adapter / Harness Boundary
 *
 * - **Harness-owned**: which skills exist, where their files live, how they
 *   are loaded and mounted into an agent's context. The OpenCode SDK/runtime
 *   provides this information.
 * - **Adapter-owned**: receiving the harness-provided list, forwarding it to
 *   the engine, and validating declared skill names against it.
 * - **Engine-owned**: matching declared skill names against `SkillInfo.name`
 *   values and emitting `MissingSkill` errors for unresolved names.
 *
 * ## Hard-error semantics
 *
 * Missing declared skills are hard errors (not silent skips). When an agent's
 * `skills [...]` declaration references a skill that is not in the
 * harness-provided list, `validateDeclaredSkills()` returns
 * `err(MissingSkillsError)` with the missing names. Callers must not suppress
 * those errors.
 *
 * Boundary rule: this module must not import from `@opencode-ai/sdk` directly.
 * All SDK type imports flow through `./sdk-types`.
 */

import type { SkillInfo } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Discriminated error returned by `validateDeclaredSkills()` when one or more
 * declared skill names are absent from the harness-provided available list.
 */
export interface MissingSkillsError {
  readonly type: "MissingSkillsError";
  /** Names of the skills that were declared but not found in the available list. */
  readonly missingSkills: string[];
}

// ---------------------------------------------------------------------------
// Primary export: build a SkillInfo[] from harness-provided data
// ---------------------------------------------------------------------------

/**
 * Build a `SkillInfo[]` list from an explicit list of skill names.
 *
 * Use this when the harness SDK provides skill names as strings and you need
 * to construct the `SkillInfo[]` list expected by the engine.
 *
 * @param names - Skill names provided by the harness.
 * @returns `SkillInfo[]` with no adapter metadata.
 */
export function buildSkillInfoList(names: string[]): SkillInfo[] {
  return names.map((name) => ({ name }));
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate that all declared skill names are present in the harness-provided
 * available list.
 *
 * Returns `ok(void)` when all declared skills are available, or
 * `err(MissingSkillsError)` with the names of missing skills.
 *
 * This is a convenience helper for adapters that want to validate skill
 * availability before calling the engine's `resolveSkillsForAgent()`.
 *
 * @param declaredSkills - Skill names declared by the agent.
 * @param availableSkills - Skills provided by the harness to the adapter.
 * @param disabledSkills - Skill names that are globally disabled (skipped).
 * @returns `ok(void)` when all non-disabled declared skills are available.
 */
export function validateDeclaredSkills(
  declaredSkills: string[],
  availableSkills: SkillInfo[],
  disabledSkills: string[] = [],
): Result<void, MissingSkillsError> {
  const availableNames = new Set(availableSkills.map((s) => s.name));
  const missing: string[] = [];

  for (const skill of declaredSkills) {
    if (disabledSkills.includes(skill)) continue;
    if (!availableNames.has(skill)) {
      missing.push(skill);
    }
  }

  if (missing.length > 0) {
    return err({ type: "MissingSkillsError", missingSkills: missing });
  }
  return ok(undefined);
}
