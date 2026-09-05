/**
 * V2 `ctx.skill` integration — adapts V2 skill records into the engine's
 * harness-agnostic `SkillInfo` shape, and registers Weave-managed skills back
 * into the V2 skill registry via `ctx.skill.transform()`.
 *
 * `loadAvailableSkillsV2()` implements the read side of `HarnessAdapter.
 * loadAvailableSkills()` (`packages/engine/src/adapter.ts`): it must never
 * throw and must return `Promise<SkillInfo[]>` (not a `Result`), matching the
 * engine's adapter contract. Failures are logged and degrade to `[]` rather
 * than aborting bootstrap.
 *
 * `registerWeaveManagedSkills()` is adapter-owned, V2-only surface (not part
 * of `HarnessAdapter`) used to push Weave-declared skills into the V2 skill
 * registry so they are visible to `ctx.skill.list()` / session prompts. It
 * returns `ResultAsync<V2Registration, OpenCode2AdapterError>` per the
 * neverthrow convention for fallible adapter modules (see `./errors.ts`).
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see Spec 33 and `./errors.ts` header for the independent V2
 * error union rationale.
 */

import { logger, type SkillInfo } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import {
  type OpenCode2AdapterError,
  skillListError,
  skillRegistrationError,
} from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";
import type { V2Registration, V2SkillInfo } from "./sdk-types.js";

const log = logger.child({ module: "adapter-opencode2/skill-discovery" });

/**
 * Adapts a single V2 skill record (`ctx.skill.list()` entry) into the
 * engine's `SkillInfo` shape. Only `name` is engine-required; every other
 * V2 field is preserved as adapter-owned pass-through `metadata` so
 * downstream adapter code (e.g. registration, prompt composition) can still
 * read the original V2 record without the engine ever inspecting it.
 */
function toSkillInfo(skill: V2SkillInfo): SkillInfo {
  return {
    name: skill.name,
    metadata: skill,
  };
}

/**
 * Reads `facade.skill.list()` and adapts the result into the engine's
 * `SkillInfo[]` shape.
 *
 * Matches `HarnessAdapter.loadAvailableSkills()`'s contract: never throws,
 * returns `Promise<SkillInfo[]>` directly (not a `Result`). On failure the
 * error is logged and an empty array is returned — an adapter that cannot
 * discover skills degrades to "no skills available" rather than aborting
 * bootstrap.
 */
export async function loadAvailableSkillsV2(
  facade: PluginContextFacade,
): Promise<SkillInfo[]> {
  const result = await ResultAsync.fromPromise(facade.skill.list(), (cause) =>
    skillListError(cause),
  );

  if (result.isErr()) {
    log.error({ err: result.error }, "Failed to list V2 skills");
    return [];
  }

  return result.value.map(toSkillInfo);
}

/**
 * Registers Weave-managed skills into the V2 skill registry via
 * `ctx.skill.transform()`, using each `SkillInfo`'s adapter-owned
 * `metadata` (a `V2SkillInfo`, when present) to seed the editor entry, or a
 * minimal synthesized record otherwise.
 *
 * Returns the `V2Registration` handle so callers can `dispose()` the
 * registration during adapter teardown.
 */
export function registerWeaveManagedSkills(
  facade: PluginContextFacade,
  skills: SkillInfo[],
): ResultAsync<V2Registration, OpenCode2AdapterError> {
  return ResultAsync.fromPromise(
    facade.skill.transform((editor) => {
      for (const skill of skills) {
        const v2Skill = toV2SkillInfo(skill);
        editor.add(v2Skill);
      }
    }),
    (cause) => skillRegistrationError(skills[0]?.name ?? "unknown", cause),
  );
}

/**
 * Builds a `V2SkillInfo`-shaped record for `editor.add()` from a
 * Weave-declared `SkillInfo`. Reuses the adapter-owned `metadata` V2 record
 * when the skill originated from `loadAvailableSkillsV2()`; otherwise
 * synthesizes a minimal record with empty `location`/`content` fields (the
 * adapter has no filesystem discovery duties per the boundary rules — see
 * `docs/adapter-boundary.md`).
 */
function toV2SkillInfo(skill: SkillInfo): V2SkillInfo {
  const metadata = skill.metadata as Partial<V2SkillInfo> | undefined;
  if (metadata !== undefined && metadata.id !== undefined) {
    return metadata as V2SkillInfo;
  }

  return {
    id: skill.name,
    name: skill.name,
    location: "",
    content: "",
  } as unknown as V2SkillInfo;
}
