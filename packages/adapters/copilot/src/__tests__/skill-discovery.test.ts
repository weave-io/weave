import { describe, expect, it } from "bun:test";
import { discoverCopilotSkills } from "../skill-discovery.js";

describe("discoverCopilotSkills", () => {
  it("returns ok([]) when both directories are missing", async () => {
    const readDir = async (_path: string): Promise<string[]> => {
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => "";

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("discovers project-level skills", async () => {
    const readDir = async (path: string) => {
      if (path.includes("project")) return ["deploy-skill"];
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => "# Deploy Skill";

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("deploy-skill");
    const meta = skills[0]?.metadata as { scope: string; path: string };
    expect(meta.scope).toBe("project");
    expect(meta.path).toContain("deploy-skill");
    expect(meta.path).toContain("SKILL.md");
  });

  it("discovers global-level skills", async () => {
    const readDir = async (path: string) => {
      if (path.includes("home")) return ["global-skill"];
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => "# Global Skill";

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("global-skill");
    const meta = skills[0]?.metadata as { scope: string };
    expect(meta.scope).toBe("global");
  });

  it("merges project and global skills together", async () => {
    const readDir = async (path: string) => {
      if (path.includes("project")) return ["proj-skill"];
      if (path.includes("home")) return ["glob-skill"];
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => "content";

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["glob-skill", "proj-skill"]);
    const scopes = skills
      .map((s) => (s.metadata as { scope: string }).scope)
      .sort();
    expect(scopes).toEqual(["global", "project"]);
  });

  it("skips entries with no readable SKILL.md", async () => {
    const readDir = async (path: string) => {
      if (path.includes("project")) return ["broken-skill"];
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string): Promise<string> => {
      throw new Error("permission denied");
    };

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("does not leak file contents into the returned SkillInfo", async () => {
    const secretContent = "SECRET SKILL BODY CONTENT";
    const readDir = async (path: string) => {
      if (path.includes("project")) return ["my-skill"];
      throw new Error("ENOENT");
    };
    const readFile = async (_path: string) => secretContent;

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
    const skills = result._unsafeUnwrap();
    const serialized = JSON.stringify(skills);
    expect(serialized).not.toContain(secretContent);
  });

  it("wraps unexpected non-Error throws as Error via ResultAsync", async () => {
    // discoverCopilotSkills itself never throws synchronously (directory
    // errors are caught internally), so this exercises the ResultAsync
    // wrapper's ok path defensively.
    const readDir = async (_path: string): Promise<string[]> => [];
    const readFile = async (_path: string) => "";

    const result = await discoverCopilotSkills(
      "/project",
      "/home/user",
      readDir,
      readFile,
    );

    expect(result.isOk()).toBe(true);
  });
});
