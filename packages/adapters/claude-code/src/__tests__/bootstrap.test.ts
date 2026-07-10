import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { getBootstrapDir, BOOTSTRAP_FILES } from "../bootstrap.js";

describe("getBootstrapDir", () => {
  it("returns a path that exists", async () => {
    const dir = getBootstrapDir();
    // Bun.file().exists() returns false for directories, so list the dir instead
    const entries = await Bun.file(join(dir, ".claude-plugin", "plugin.json")).exists();
    expect(entries).toBe(true);
  });

  it("returns a path ending with 'bootstrap'", () => {
    const dir = getBootstrapDir();
    expect(dir.endsWith("bootstrap")).toBe(true);
  });
});

describe("BOOTSTRAP_FILES", () => {
  it("all entries exist within the bootstrap directory", async () => {
    const dir = getBootstrapDir();
    for (const rel of BOOTSTRAP_FILES) {
      const full = join(dir, rel);
      const exists = await Bun.file(full).exists();
      expect(exists, `expected ${rel} to exist at ${full}`).toBe(true);
    }
  });
});

describe("plugin.json", () => {
  it("parses as valid JSON with name 'weave-bootstrap'", async () => {
    const { join: pathJoin } = await import("node:path");
    const pluginPath = pathJoin(getBootstrapDir(), ".claude-plugin", "plugin.json");
    const content = await Bun.file(pluginPath).text();
    const json = JSON.parse(content);
    expect(json.name).toBe("weave-bootstrap");
  });
});

describe("hooks.json", () => {
  it("contains a SessionStart hook", async () => {
    const { join: pathJoin } = await import("node:path");
    const hooksPath = pathJoin(getBootstrapDir(), "hooks", "hooks.json");
    const content = await Bun.file(hooksPath).text();
    const json = JSON.parse(content);
    expect(json.hooks).toBeDefined();
    expect(Array.isArray(json.hooks.SessionStart)).toBe(true);
    expect(json.hooks.SessionStart.length).toBeGreaterThan(0);
  });
});


describe("plugin.json", () => {
  it("parses as valid JSON with name 'weave-bootstrap'", async () => {
    const { join: pathJoin } = await import("node:path");
    const pluginPath = pathJoin(getBootstrapDir(), ".claude-plugin", "plugin.json");
    const content = await Bun.file(pluginPath).text();
    const json = JSON.parse(content);
    expect(json.name).toBe("weave-bootstrap");
  });
});

describe("hooks.json", () => {
  it("contains a SessionStart hook", async () => {
    const { join: pathJoin } = await import("node:path");
    const hooksPath = pathJoin(getBootstrapDir(), "hooks", "hooks.json");
    const content = await Bun.file(hooksPath).text();
    const json = JSON.parse(content);
    expect(json.hooks).toBeDefined();
    expect(Array.isArray(json.hooks.SessionStart)).toBe(true);
    expect(json.hooks.SessionStart.length).toBeGreaterThan(0);
  });
});
