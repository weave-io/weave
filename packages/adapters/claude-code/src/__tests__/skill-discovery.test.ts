import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { discoverClaudeCodeSkills } from "../skill-discovery.js";

const claudeCodeSkillMetadataSchema = z.object({
  description: z.string().optional(),
  scope: z.enum(["project", "global"]),
  path: z.string(),
});

describe("discoverClaudeCodeSkills", () => {
  it("discovers project-level command files", async () => {
    const readDir = async (path: string) => {
      if (path.includes("project"))
        return ["deploy.md", "test.md", "readme.txt"];
      throw new Error("not found");
    };
    const readFile = async (_path: string) =>
      "# Deploy\nDeploy the application.";

    const result = await discoverClaudeCodeSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    // Only .md files
    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("deploy");
    const parsedMetadata = claudeCodeSkillMetadataSchema.safeParse(
      skills[0]?.metadata,
    );
    expect(parsedMetadata.success).toBe(true);
    if (!parsedMetadata.success) return;
    expect(parsedMetadata.data.description).toBe("Deploy");
    expect(parsedMetadata.data.scope).toBe("project");
    expect(parsedMetadata.data.path).toContain("deploy.md");
  });

  it("discovers global command files", async () => {
    const readDir = async (path: string) => {
      if (path.includes("user")) return ["global-cmd.md"];
      throw new Error("not found");
    };
    const readFile = async (_path: string) => "A global command description";

    const result = await discoverClaudeCodeSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("global-cmd");
    const parsedMetadata = claudeCodeSkillMetadataSchema.safeParse(
      skills[0]?.metadata,
    );
    expect(parsedMetadata.success).toBe(true);
    if (!parsedMetadata.success) return;
    expect(parsedMetadata.data.description).toBe(
      "A global command description",
    );
    expect(parsedMetadata.data.scope).toBe("global");
  });

  it("returns empty array when no directories exist", async () => {
    const readDir = async (_path: string): Promise<string[]> => {
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => "";

    const result = await discoverClaudeCodeSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("includes skill even when file is unreadable", async () => {
    const readDir = async (_path: string) => ["broken.md"];
    const readFile = async (_path: string): Promise<string> => {
      throw new Error("permission denied");
    };

    const result = await discoverClaudeCodeSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    // Both project and global return "broken.md" → 2 skills
    expect(skills.length).toBe(2);
    expect(skills[0]?.name).toBe("broken");
    const parsedMetadata = claudeCodeSkillMetadataSchema.safeParse(
      skills[0]?.metadata,
    );
    expect(parsedMetadata.success).toBe(true);
    if (!parsedMetadata.success) return;
    expect(parsedMetadata.data.description).toBeUndefined();
  });
});
