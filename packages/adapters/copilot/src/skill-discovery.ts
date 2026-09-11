/**
 * GitHub Copilot CLI skill discovery.
 *
 * Discovers Copilot skill directories that can serve as Weave skills.
 * Scans both project-level and global (personal) skill roots.
 *
 * Root selection: `docs/artifacts/copilot-adapter-research.md` §8 documents
 * `copilot skill --help` output listing multiple project roots
 * (`.github/skills/`, `.agents/skills/`, `.claude/skills/`) and two personal
 * roots (`~/.copilot/skills/` or `~/.agents/skills/`). Since the spike found
 * none of these directories present on the research machine and did not
 * establish a single definitive project root among the three documented
 * options, this module falls back to the `.copilot/skills` convention
 * (mirroring the personal-root's first-listed option) for both project and
 * global scope, consistent with the Claude Code adapter's `.claude/...`
 * scoping pattern.
 */

import { join } from "node:path";
import type { SkillInfo } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";

/**
 * Discovers Copilot skill directories from project and global roots.
 *
 * Scans:
 * - `<projectRoot>/.copilot/skills/<skill-name>/SKILL.md`
 * - `<homeDir>/.copilot/skills/<skill-name>/SKILL.md`
 *
 * Each discovered `SKILL.md` is returned as a `SkillInfo` with:
 * - `name`: the skill directory name
 * - `metadata.scope`: "project" or "global"
 * - `metadata.path`: absolute path to the `SKILL.md` file
 *
 * Missing directories are skipped silently, mirroring the Claude Code
 * skill-discovery pattern.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param homeDir - Absolute path to the user's home directory.
 * @param readDir - Injectable directory reader for testability.
 * @param readFile - Injectable file reader for testability.
 */
export function discoverCopilotSkills(
  projectRoot: string,
  homeDir: string,
  readDir: (path: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string>,
): ResultAsync<SkillInfo[], Error> {
  return ResultAsync.fromPromise(
    discoverSkillsImpl(projectRoot, homeDir, readDir, readFile),
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );
}

async function discoverSkillsImpl(
  projectRoot: string,
  homeDir: string,
  readDir: (path: string) => Promise<string[]>,
  readFile: (path: string) => Promise<string>,
): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  const roots: Array<{ path: string; scope: "project" | "global" }> = [
    { path: join(projectRoot, ".copilot", "skills"), scope: "project" },
    { path: join(homeDir, ".copilot", "skills"), scope: "global" },
  ];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readDir(root.path);
    } catch {
      // Directory doesn't exist or isn't readable — skip silently
      continue;
    }

    for (const skillName of entries) {
      const skillMdPath = join(root.path, skillName, "SKILL.md");

      try {
        // Confirm the SKILL.md file exists / is readable before including it.
        await readFile(skillMdPath);
      } catch {
        // No SKILL.md for this entry — skip it
        continue;
      }

      skills.push({
        name: skillName,
        metadata: {
          scope: root.scope,
          path: skillMdPath,
        },
      });
    }
  }

  return skills;
}
