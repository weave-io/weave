import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProjectWeavePlugins,
  isWeavePluginSpec,
  mergeConfigs,
  readGlobalConfig,
  useDevPlugin,
} from "../dev/opencode-config.js";

const DEV = "file:///repo/packages/adapters/opencode/dist/plugin.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "weave-dev-opencode-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("isWeavePluginSpec", () => {
  it.each([
    "@weaveio/weave-adapter-opencode",
    "@weaveio/weave-adapter-opencode@0.1.2",
    "@weaveio/weave-adapter-opencode@next",
    "@opencode_weave/weave",
    "@opencode_weave/weave@0.8.1",
    "file:///home/me/source/weave/packages/adapters/opencode/dist/plugin.js",
    "file:///home/me/source/opencode-weave/dist/index.js",
  ])("matches %s", (spec) => {
    expect(isWeavePluginSpec(spec)).toBe(true);
  });

  it.each([
    "opencode-wakatime",
    "@weaveio/weave-adapter-opencode2",
    "@weaveio/weave-adapter-opencode-extra",
    "file:///home/me/plugins/other.js",
  ])("ignores %s", (spec) => {
    expect(isWeavePluginSpec(spec)).toBe(false);
  });
});

describe("useDevPlugin", () => {
  it("replaces every Weave plugin with the dev build and keeps the rest in order", () => {
    const { config, replaced } = useDevPlugin(
      {
        model: "anthropic/claude-sonnet-4-5",
        plugin: [
          "opencode-wakatime",
          "@weaveio/weave-adapter-opencode@0.1.2",
          ["@opencode_weave/weave", { debug: true }],
          "other-plugin",
        ],
      },
      DEV,
    );
    expect(config.plugin).toEqual(["opencode-wakatime", "other-plugin", DEV]);
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
    expect(replaced).toEqual([
      "@weaveio/weave-adapter-opencode@0.1.2",
      "@opencode_weave/weave",
    ]);
  });

  it("adds the dev build when there is no plugin list", () => {
    expect(useDevPlugin({}, DEV)).toEqual({
      config: { plugin: [DEV] },
      replaced: [],
    });
  });
});

describe("mergeConfigs", () => {
  it("merges objects, concatenates plugin lists, and lets later values win", () => {
    expect(
      mergeConfigs([
        { plugin: ["a"], model: "x", provider: { anthropic: { apiKey: "1" } } },
        { plugin: ["b"], model: "y", provider: { openai: { apiKey: "2" } } },
      ]),
    ).toEqual({
      plugin: ["a", "b"],
      model: "y",
      provider: { anthropic: { apiKey: "1" }, openai: { apiKey: "2" } },
    });
  });
});

describe("readGlobalConfig", () => {
  it("reads config.json, opencode.json, and opencode.jsonc (with comments and trailing commas)", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ plugin: ["@weaveio/weave-adapter-opencode@0.1.2"] }),
    );
    writeFileSync(
      join(dir, "opencode.jsonc"),
      '{\n  // mine\n  "plugin": ["opencode-wakatime",],\n}\n',
    );
    expect(readGlobalConfig(dir)).toEqual({
      plugin: ["@weaveio/weave-adapter-opencode@0.1.2", "opencode-wakatime"],
    });
  });

  it("returns an empty config when the directory has no config files", () => {
    expect(readGlobalConfig(tempDir())).toEqual({});
  });
});

describe("findProjectWeavePlugins", () => {
  it("finds Weave plugins in project config up to the git root", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".opencode"));
    mkdirSync(join(root, "app", "src"), { recursive: true });
    writeFileSync(
      join(root, ".opencode", "opencode.json"),
      JSON.stringify({ plugin: ["@opencode_weave/weave"] }),
    );
    writeFileSync(
      join(root, "app", "opencode.jsonc"),
      '{ "plugin": ["other", "@weaveio/weave-adapter-opencode@0.2.0",] }',
    );

    expect(findProjectWeavePlugins(join(root, "app", "src"))).toEqual([
      {
        file: join(root, "app", "opencode.jsonc"),
        spec: "@weaveio/weave-adapter-opencode@0.2.0",
      },
      {
        file: join(root, ".opencode", "opencode.json"),
        spec: "@opencode_weave/weave",
      },
    ]);
  });
});
