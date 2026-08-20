import type { SkillInfo, SkillResolutionResult } from "@weaveio/weave-engine";
import { resolveSkillsForAgent } from "@weaveio/weave-engine";
import type { Result } from "neverthrow";
import type { PiSkillInfo } from "./types.js";

/**
 * Maps one real Pi skill entry (`before_agent_start`'s
 * `event.systemPromptOptions.skills`, shape `{name, filePath, sourceInfo}`)
 * into the engine's harness-neutral `SkillInfo`. `filePath`/`sourceInfo` are
 * carried through as opaque `metadata` — the engine only requires `name`
 * for matching (Pi adapter contract) and never reads skill file contents itself.
 */
export function toEngineSkillInfo(skill: PiSkillInfo): SkillInfo {
  return {
    name: skill.name,
    metadata: { filePath: skill.filePath, sourceInfo: skill.sourceInfo },
  };
}

/**
 * Pi-owned skill discovery context (Pi adapter contract `PiSkillCatalog`,).
 *
 * Pi owns skill discovery, trust, precedence, collision handling, and
 * provenance (docs/skills.md); Weave never scans Pi's skill directories
 * itself (docs/architecture/adapter-boundary.md). This class only holds the adapter's
 * current snapshot of Pi's already-discovered skill catalog — sourced from
 * `before_agent_start`'s `systemPromptOptions.skills`, the earliest point
 * Pi exposes it — and delegates exact, case-sensitive matching to the
 * engine's `resolveSkillsForAgent`.
 *
 * Per-agent resolution is used because activation needs one descriptor's
 * available skills and warnings. A missing requested skill never disables the
 * descriptor or affects another agent.
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

  /** Resolves available skills and non-fatal warnings for one descriptor. */
  resolveForAgent(
    agentName: string,
    agentSkills: readonly string[] | undefined,
    disabledSkills: readonly string[] = [],
  ): Result<SkillResolutionResult, never> {
    return resolveSkillsForAgent({
      agentName,
      agentSkills: agentSkills === undefined ? undefined : [...agentSkills],
      availableSkills: [...this.availableSkills],
      disabledSkills: [...disabledSkills],
    });
  }
}
