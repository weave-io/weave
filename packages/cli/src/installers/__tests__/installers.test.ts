import { describe, expect, it } from "bun:test";
import { MemoryFileSystem } from "../../fs/file-system.js";
import { installAllSupported, installerRegistry } from "../index.js";

function opencodeConfig() {
  return "/home/user/.config/opencode/config.json";
}

describe("harness installers", () => {
  it("installs supported OpenCode integration", async () => {
    const fs = new MemoryFileSystem({ [opencodeConfig()]: "{}" });
    const installer = installerRegistry(fs).opencode;
    const result = await installer.install({
      harness: "opencode",
      configPath: opencodeConfig(),
      selectedModules: [],
      force: false,
    });
    expect(result._unsafeUnwrap().changed).toBe(true);
    expect(fs.snapshot()[opencodeConfig()]).toContain("weave:init");
  });

  it("installs optional adapter modules", async () => {
    const fs = new MemoryFileSystem({ [opencodeConfig()]: "{}" });
    const installer = installerRegistry(fs).opencode;
    const result = await installer.install({
      harness: "opencode",
      configPath: opencodeConfig(),
      selectedModules: ["agents"],
      force: false,
    });
    expect(result._unsafeUnwrap().messages.join("\n")).toContain(
      "agent module",
    );
    expect(
      fs.snapshot()["/home/user/.config/opencode/weave-agents.json"],
    ).toContain("@weaveio/weave-cli");
  });

  it("is idempotent without force", async () => {
    const fs = new MemoryFileSystem({ [opencodeConfig()]: "{}" });
    const installer = installerRegistry(fs).opencode;
    await installer.install({
      harness: "opencode",
      configPath: opencodeConfig(),
      selectedModules: [],
      force: false,
    });
    const second = await installer.install({
      harness: "opencode",
      configPath: opencodeConfig(),
      selectedModules: [],
      force: false,
    });
    expect(second._unsafeUnwrap().changed).toBe(false);
    const matches = fs.snapshot()[opencodeConfig()].match(/weave:init/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("allows forced reinstall marker", async () => {
    const fs = new MemoryFileSystem({
      [opencodeConfig()]: "{}\n// weave:init:install\n",
    });
    const installer = installerRegistry(fs).opencode;
    const result = await installer.install({
      harness: "opencode",
      configPath: opencodeConfig(),
      selectedModules: [],
      force: true,
    });
    expect(result._unsafeUnwrap().changed).toBe(true);
    expect(fs.snapshot()[opencodeConfig()]).toContain("weave:init:force");
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
