import type {
  ResolvedSkill,
  SkillInfo,
  SkillResolutionError,
} from "@weaveio/weave-engine";
import { resolveSkillsForAgent } from "@weaveio/weave-engine";
import type { Result } from "neverthrow";
import type { PiSkillInfo } from "./types.js";

/**
 * Maps one real Pi skill entry (`before_agent_start`'s
 * `event.systemPromptOptions.skills`, shape `{name, filePath, sourceInfo}`)
 * into the engine's harness-neutral `SkillInfo`. `filePath`/`sourceInfo` are
 * carried through as opaque `metadata` — the engine only requires `name`
 * for matching (Spec 33 §9.1) and never reads skill file contents itself.
 */
export function toEngineSkillInfo(skill: PiSkillInfo): SkillInfo {
  return {
    name: skill.name,
    metadata: { filePath: skill.filePath, sourceInfo: skill.sourceInfo },
  };
}

/**
 * Pi-owned skill discovery context (Spec 33 §6 `PiSkillCatalog`, §9.1).
 *
 * Pi owns skill discovery, trust, precedence, collision handling, and
 * provenance (docs/skills.md); Weave never scans Pi's skill directories
 * itself (docs/adapter-boundary.md). This class only holds the adapter's
 * current snapshot of Pi's already-discovered skill catalog — sourced from
 * `before_agent_start`'s `systemPromptOptions.skills`, the earliest point
 * Pi exposes it — and delegates exact, case-sensitive matching to the
 * engine's `resolveSkillsForAgent`.
 *
 * Per-agent resolution (not the batch `resolveSkillsForConfig`) is used
 * deliberately: `resolveSkillsForConfig` fails globally the moment any one
 * agent has a missing skill, which would violate Spec 33 §8.1's requirement
 * that a missing requested skill disable only the one affected descriptor.
 */
export class PiSkillCatalog {
  private availableSkills: readonly SkillInfo[];

  constructor(availableSkills: readonly PiSkillInfo[] = []) {
    this.availableSkills = availableSkills.map(toEngineSkillInfo);
  }

  /**
   * Replaces the discovery snapshot with a fresh read of Pi's real skill
   * catalog. Called whenever the adapter observes one (e.g. from
   * `before_agent_start`'s `systemPromptOptions.skills`).
   */
  refresh(availableSkills: readonly PiSkillInfo[]): void {
    this.availableSkills = availableSkills.map(toEngineSkillInfo);
  }

  /** The current discovery snapshot, for diagnostics. */
  getAvailableSkills(): readonly SkillInfo[] {
    return this.availableSkills;
  }

  /**
   * Resolves one descriptor's requested skills against the current
   * snapshot. A missing skill isolates only this agent's result — it MUST
   * NOT be escalated into a config-wide failure.
   */
  resolveForAgent(
    agentName: string,
    agentSkills: readonly string[] | undefined,
    disabledSkills: readonly string[] = [],
  ): Result<ResolvedSkill[], SkillResolutionError[]> {
    return resolveSkillsForAgent({
      agentName,
      agentSkills: agentSkills === undefined ? undefined : [...agentSkills],
      availableSkills: [...this.availableSkills],
      disabledSkills: [...disabledSkills],
    });
  }
}
