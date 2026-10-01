import { describe, expect, it } from "bun:test";
import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  configModeApplies,
  DEFAULT_EVAL_CONFIG_MODE,
  EvalConfigLoader,
  isEvalConfigMode,
  SUITES_INDEPENDENT_OF_CONFIG_MODE,
} from "../config-mode.js";
import { TAPESTRY_CATEGORY_ROUTING_SUITE } from "../tapestry-category-routing-runner.js";

const PROJECT_ROOT = "/fixture-repo";
const PROJECT_CONFIG = `${PROJECT_ROOT}/.weave/config.weave`;

/** Serves one project config that adds an agent; records every path asked. */
class RecordingReader implements FileReader {
  readonly asked: string[] = [];

  exists(path: string): Promise<boolean> {
    this.asked.push(path);
    return Promise.resolve(path === PROJECT_CONFIG);
  }

  read(path: string): ResultAsync<string, ConfigLoadError> {
    this.asked.push(path);
    if (path !== PROJECT_CONFIG) {
      return errAsync({ type: "FileReadError", path, cause: "not a fixture" });
    }
    return okAsync('agent repo-helper {\n  prompt "Help with this repo."\n}\n');
  }
}

describe("EvalConfigLoader", () => {
  it("loads the builtins without asking for a single config file in builtin mode", async () => {
    const reader = new RecordingReader();

    const config = (
      await new EvalConfigLoader({
        projectRoot: PROJECT_ROOT,
        fileReader: reader,
      }).load("builtin")
    )._unsafeUnwrap();

    expect(reader.asked).toEqual([]);
    expect(config.agents.shuttle).toBeDefined();
    expect(config.agents["repo-helper"]).toBeUndefined();
  });

  it("merges the project config over the builtins in project mode", async () => {
    const reader = new RecordingReader();

    const config = (
      await new EvalConfigLoader({
        projectRoot: PROJECT_ROOT,
        fileReader: reader,
      }).load("project")
    )._unsafeUnwrap();

    expect(reader.asked).toContain(PROJECT_CONFIG);
    expect(config.agents["repo-helper"]).toBeDefined();
    expect(config.agents.shuttle).toBeDefined();
  });
});

describe("eval config modes", () => {
  it("default to builtin, so a run scores the prompts users get", () => {
    expect(DEFAULT_EVAL_CONFIG_MODE).toBe("builtin");
  });

  it.each([
    ["builtin", true],
    ["project", true],
    ["global", false],
    ["", false],
  ] as const)("recognise %p: %p", (value, known) => {
    expect(isEvalConfigMode(value)).toBe(known);
  });
});

describe("configModeApplies", () => {
  it("names the category-routing suite as independent of the mode", () => {
    expect(SUITES_INDEPENDENT_OF_CONFIG_MODE).toEqual([
      TAPESTRY_CATEGORY_ROUTING_SUITE,
    ]);
  });

  it.each([
    [null, ["shuttle-execution"], true],
    ["text", ["loom-routing"], true],
    [null, ["tapestry-category-routing", "weft-review"], true],
    ["trajectory", ["loom-routing"], false],
    [null, ["tapestry-category-routing"], false],
  ] as const)("track %p, suites %p: %p", (track, suites, applies) => {
    expect(configModeApplies({ track, suites })).toBe(applies);
  });
});
