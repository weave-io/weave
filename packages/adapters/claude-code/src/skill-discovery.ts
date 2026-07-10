/**
 * Claude Code skill discovery.
 *
 * Discovers Claude Code command files that can serve as Weave skills.
 * Scans both project-level and global command directories.
 */

import { join } from "node:path";
import { ResultAsync } from "neverthrow";
import type { SkillInfo } from "@weaveio/weave-engine";

/**
 * Discovers Claude Code command files from project and global directories.
 *
 * Scans:
 * - `<projectRoot>/.claude/commands/*.md`
 * - `<homeDir>/.claude/commands/*.md`
 *
 * Each discovered `.md` file is returned as a `SkillInfo` with:
 * - `name`: the filename without extension
 * - `description`: first line of the file content (if readable)
 * - `metadata.scope`: "project" or "global"
 * - `metadata.path`: absolute file path
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param homeDir - Absolute path to the user's home directory.
 * @param readDir - Injectable directory reader for testability.
 * @param readFile - Injectable file reader for testability.
 */
export function discoverClaudeCodeSkills(
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

  const dirs: Array<{ path: string; scope: "project" | "global" }> = [
    { path: join(projectRoot, ".claude", "commands"), scope: "project" },
    { path: join(homeDir, ".claude", "commands"), scope: "global" },
  ];

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readDir(dir.path);
    } catch {
      // Directory doesn't exist or isn't readable — skip silently
      continue;
    }

    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      const filePath = join(dir.path, file);
      const name = file.replace(/\.md$/, "");

      let description: string | undefined;
      try {
        const content = await readFile(filePath);
        const firstLine = content.split("\n")[0]?.trim();
        if (firstLine && !firstLine.startsWith("#")) {
          description = firstLine;
        } else if (firstLine?.startsWith("# ")) {
          description = firstLine.slice(2);
        }
      } catch {
        // Can't read file — still include with no description
      }

      skills.push({
        name,
        metadata: {
          description,
          scope: dir.scope,
          path: filePath,
        },
      });
    }
  }

  return skills;
}
