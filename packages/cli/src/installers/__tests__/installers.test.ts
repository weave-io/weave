import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { ClaudeCodeInstaller } from "../claude-code.js";
import { installAllSupported, installerRegistry } from "../index.js";
import { OpenCodeInstaller } from "../opencode.js";
import { OpenCode2Installer } from "../opencode2.js";

function opencodeConfig() {
  return "/home/user/.config/opencode/opencode.json";
}

describe("harness installers", () => {
  const local = {
    harness: "opencode" as const,
    configPath: "/unused",
    selectedModules: [],
    force: false,
    scope: "local" as const,
  };

  it("adds the pinned OpenCode adapter to a new project plugin list", async () => {
    const fs = new MemoryFileSystem({}, "/project", "/home/user");
    const result = await new OpenCodeInstaller(fs, "0.2.0").install(local);
    expect(result._unsafeUnwrap().changed).toBe(true);
    expect(
      JSON.parse(fs.snapshot()["/project/opencode.jsonc"] ?? "{}"),
    ).toEqual({ plugin: ["@weaveio/weave-adapter-opencode@0.2.0"] });
  });

  it("appends to an existing OpenCode plugin list and is byte-idempotent", async () => {
    const path = "/project/opencode.json";
    const fs = new MemoryFileSystem(
      { [path]: '{\n  // keep\n  "plugin": ["other-plugin"]\n}\n' },
      "/project",
      "/home/user",
    );
    const installer = new OpenCodeInstaller(fs, "0.2.0");
    expect((await installer.install(local))._unsafeUnwrap().changed).toBe(true);
    const once = fs.snapshot()[path] ?? "";
    expect(once).toContain("// keep");
    expect(once).toContain('"other-plugin"');
    expect(once).toContain('"@weaveio/weave-adapter-opencode@0.2.0"');
    expect((await installer.install(local))._unsafeUnwrap().changed).toBe(
      false,
    );
    expect(fs.snapshot()[path]).toBe(once);
  });

  it("replaces the legacy OpenCode Weave plugin entry", async () => {
    const path = "/project/opencode.json";
    const fs = new MemoryFileSystem(
      { [path]: '{ "plugin": ["@opencode_weave/weave@0.8.1"] }\n' },
      "/project",
      "/home/user",
    );
    const result = await new OpenCodeInstaller(fs, "0.2.0").install(local);
    expect(result._unsafeUnwrap().messages.join("\n")).toContain(
      "Replaced the legacy plugin entry @opencode_weave/weave@0.8.1",
    );
    expect(JSON.parse(fs.snapshot()[path] ?? "{}").plugin).toEqual([
      "@weaveio/weave-adapter-opencode@0.2.0",
    ]);
  });

  it("removes the legacy entry when the adapter is already listed", async () => {
    const path = "/project/opencode.json";
    const fs = new MemoryFileSystem(
      {
        [path]:
          '{ "plugin": ["@weaveio/weave-adapter-opencode@0.2.0", "@opencode_weave/weave"] }\n',
      },
      "/project",
      "/home/user",
    );
    const result = await new OpenCodeInstaller(fs, "0.2.0").install(local);
    expect(result._unsafeUnwrap().messages[0]).toContain(
      "Removed the legacy plugin entry @opencode_weave/weave",
    );
    expect(JSON.parse(fs.snapshot()[path] ?? "{}").plugin).toEqual([
      "@weaveio/weave-adapter-opencode@0.2.0",
    ]);
  });

  it("keeps an adapter entry that names the plugin subpath", async () => {
    const path = "/project/opencode.json";
    const source = '{ "plugin": ["@weaveio/weave-adapter-opencode/plugin"] }\n';
    const fs = new MemoryFileSystem(
      { [path]: source },
      "/project",
      "/home/user",
    );
    const result = await new OpenCodeInstaller(fs, "0.2.0").install(local);
    expect(result._unsafeUnwrap().changed).toBe(false);
    expect(fs.snapshot()[path]).toBe(source);
  });

  it("adds both OpenCode generations' entries to one shared config file", async () => {
    const path = "/project/opencode.json";
    const fs = new MemoryFileSystem({ [path]: "{}" }, "/project", "/home/user");
    await new OpenCodeInstaller(fs, "0.2.0").install(local);
    await new OpenCode2Installer(fs, "0.2.0").install({
      ...local,
      harness: "opencode2",
    });
    expect(JSON.parse(fs.snapshot()[path] ?? "{}")).toEqual({
      plugin: ["@weaveio/weave-adapter-opencode@0.2.0"],
      plugins: ["@weaveio/weave-adapter-opencode2@0.2.0"],
    });
  });

  it("composes the Claude Code plugin for a project", async () => {
    let composed = 0;
    const installer = new ClaudeCodeInstaller(() => {
      composed += 1;
      return okAsync(0);
    });
    const result = await installer.install({
      ...local,
      harness: "claude-code",
    });
    expect(composed).toBe(1);
    expect(result._unsafeUnwrap().messages).toEqual([
      "Composed the Claude Code plugin.",
    ]);
  });

  it("reports a failed Claude Code compose", async () => {
    const installer = new ClaudeCodeInstaller(() => okAsync(1));
    const result = await installer.install({
      ...local,
      harness: "claude-code",
    });
    expect(result._unsafeUnwrapErr().type).toBe("InstallFailed");
  });

  it("tells a global Claude Code install to compose per project", async () => {
    let composed = 0;
    const installer = new ClaudeCodeInstaller(() => {
      composed += 1;
      return okAsync(0);
    });
    const result = await installer.install({
      ...local,
      harness: "claude-code",
      scope: "global",
    });
    expect(composed).toBe(0);
    expect(result._unsafeUnwrap().messages.join("\n")).toContain(
      "weave compose --adapter claude-code --init",
    );
  });

  it("returns unsupported explicit harness errors", async () => {
    const fs = new MemoryFileSystem();
    const installer = installerRegistry(fs).pi;
    const result = await installer.install({
      harness: "pi",
      configPath: "/home/user/.pi/config.json",
      selectedModules: [],
      force: false,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnsupportedHarness");
  });

  it("bulk install skips unsupported harnesses", async () => {
    const fs = new MemoryFileSystem({ [opencodeConfig()]: "{}" });
    const result = await installAllSupported({
      fs,
      harnesses: [
        { id: "opencode", configPath: opencodeConfig() },
        { id: "pi", configPath: "/home/user/.pi/config.json" },
      ],
      force: false,
    });
    const messages = result
      ._unsafeUnwrap()
      .flatMap((entry) => entry.messages)
      .join("\n");
    expect(messages).toContain("Skipped pi");
  });

  it("installs OpenCode 2 with JSONC comments intact and is byte-idempotent", async () => {
    const path = "/project/opencode.jsonc";
    const fs = new MemoryFileSystem({
      [path]: '{\n  // keep\n  "model": "provider/model",\n}\n',
    });
    const installer = installerRegistry(fs).opencode2;
    const request = {
      harness: "opencode2" as const,
      configPath: path,
      selectedModules: [],
      force: false,
      scope: "local" as const,
    };
    expect((await installer.install(request))._unsafeUnwrap().changed).toBe(
      true,
    );
    const once = fs.snapshot()[path];
    expect(once).toContain("// keep");
    expect(once).toContain("@weaveio/weave-adapter-opencode2");
    expect((await installer.install(request))._unsafeUnwrap().changed).toBe(
      false,
    );
    expect(fs.snapshot()[path]).toBe(once);
  });

  it("pins the OpenCode 2 adapter version released with the CLI", async () => {
    const path = "/project/opencode.jsonc";
    const fs = new MemoryFileSystem({});
    const result = await new OpenCode2Installer(fs, "0.2.0-next.2").install({
      harness: "opencode2",
      configPath: path,
      selectedModules: [],
      force: false,
      scope: "local",
    });
    expect(result._unsafeUnwrap().changed).toBe(true);
    expect(JSON.parse(fs.snapshot()[path] ?? "{}").plugins).toEqual([
      "@weaveio/weave-adapter-opencode2@0.2.0-next.2",
    ]);
  });

  it("writes the unpinned OpenCode 2 adapter name from a source checkout", async () => {
    const path = "/project/opencode.jsonc";
    const fs = new MemoryFileSystem({});
    await new OpenCode2Installer(fs, undefined).install({
      harness: "opencode2",
      configPath: path,
      selectedModules: [],
      force: false,
      scope: "local",
    });
    expect(JSON.parse(fs.snapshot()[path] ?? "{}").plugins).toEqual([
      "@weaveio/weave-adapter-opencode2",
    ]);
  });

  it("leaves an existing OpenCode 2 adapter entry at the version the user chose", async () => {
    const path = "/project/opencode.json";
    const source =
      '{ "plugins": ["@weaveio/weave-adapter-opencode2@0.1.0"] }\n';
    const fs = new MemoryFileSystem({ [path]: source });
    const result = await new OpenCode2Installer(fs, "0.2.0-next.2").install({
      harness: "opencode2",
      configPath: path,
      selectedModules: [],
      force: false,
      scope: "local",
    });
    expect(result._unsafeUnwrap().changed).toBe(false);
    expect(fs.snapshot()[path]).toBe(source);
  });

  it("appends to the OpenCode 2 plugin array without replacing its comments or options", async () => {
    const path = "/project/opencode.jsonc";
    const source = `{
  "plugins": [
    // keep plugin comment
    {
      "package": "existing-plugin",
      "options": {
        // keep option comment
        "enabled": true,
      },
    },
  ],
}\n`;
    const fs = new MemoryFileSystem({ [path]: source });
    const result = await installerRegistry(fs).opencode2.install({
      harness: "opencode2",
      configPath: path,
      selectedModules: [],
      force: false,
      scope: "local",
    });
    expect(result._unsafeUnwrap().changed).toBe(true);
    const installed = fs.snapshot()[path];
    expect(installed).toContain("// keep plugin comment");
    expect(installed).toContain("// keep option comment");
    expect(installed).toContain('"enabled": true');
    expect(installed).toContain("@weaveio/weave-adapter-opencode2");
  });

  it("uses XDG global config and rejects ambiguous native config files", async () => {
    const fs = new MemoryFileSystem(
      {
        "/xdg/opencode/opencode.json": "{}",
        "/xdg/opencode/opencode.jsonc": "{}",
      },
      "/project",
      "/home/user",
      "/xdg",
    );
    const result = await installerRegistry(fs).opencode2.install({
      harness: "opencode2",
      configPath: "/unused",
      selectedModules: [],
      force: true,
      scope: "global",
    });
    expect(result.isErr()).toBe(true);
    expect(fs.snapshot()["/xdg/opencode/opencode.json"]).toBe("{}");
  });
});
