import { describe, expect, it } from "bun:test";
import type { ConfigLoadDiagnostic } from "@weaveio/weave-config";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { chooseHarness } from "../harness.js";
import {
  listChanges,
  renderListChanges,
  validateSummaryLines,
} from "../report.js";
import { attributeModels } from "../sources.js";

function config(source: string): WeaveConfig {
  return parseConfig(source)._unsafeUnwrap();
}

const NOTIFY = config(
  "settings {\n  model_updates {\n    mode notify\n  }\n}\n",
);
const PATH =
  "/home/user/.weave/cache/model-recommendations/stable/applied.json";

describe("validateSummaryLines", () => {
  it("adds nothing for a config without model_updates", () => {
    expect(validateSummaryLines(config(""), [])).toEqual([]);
  });

  it("says off for an explicit mode off", () => {
    const off = config("settings {\n  model_updates {\n    mode off\n  }\n}\n");
    expect(validateSummaryLines(off, [])).toEqual(["model_updates: off"]);
  });

  it("names the reason a layer was skipped", () => {
    const skipped: ConfigLoadDiagnostic = {
      type: "ModelRecommendationsSkipped",
      channel: "stable",
      harness: "opencode2",
      path: PATH,
      reason: {
        type: "Expired",
        expires: "2026-10-01T00:00:00Z",
        now: "2026-10-02T00:00:00Z",
      },
    };
    expect(validateSummaryLines(NOTIFY, [skipped])).toEqual([
      "model_updates: notify (channel stable)",
      "model_recommendations: skipped, the list expired at 2026-10-01T00:00:00Z (now 2026-10-02T00:00:00Z); agents use their builtin models",
    ]);
  });

  it("lists agents the applied list names that this version skips", () => {
    const applied: ConfigLoadDiagnostic = {
      type: "ModelRecommendationsApplied",
      channel: "next",
      harness: "pi",
      section: "default",
      path: PATH,
      issued: "2026-10-01T09:00:00Z",
      expires: "2026-12-01T09:00:00Z",
      evidence: "https://tryweave.io/evals/runs/1",
      agents: ["loom"],
      skippedAgents: ["new-agent"],
    };
    const next = config(
      "settings {\n  model_updates {\n    mode auto\n    channel next\n  }\n}\n",
    );
    expect(validateSummaryLines(next, [applied])).toEqual([
      "model_updates: auto (channel next)",
      "model_recommendations: applied, issued 2026-10-01T09:00:00Z, expires 2026-12-01T09:00:00Z (pi, section default)",
      "model_recommendations: skipped agents this version does not define: new-agent",
    ]);
  });
});

describe("listChanges", () => {
  it("reports only agents whose list changed, by name", () => {
    const before = {
      issued: "a",
      section: "default" as const,
      agents: { weft: ["x"], loom: ["a"], thread: ["t"] },
    };
    const after = {
      issued: "b",
      section: "default" as const,
      agents: { loom: ["b"], thread: ["t"], shuttle: ["s"] },
    };
    const changes = listChanges(before, after);
    expect(changes).toEqual([
      { agent: "loom", before: ["a"], after: ["b"] },
      { agent: "shuttle", after: ["s"] },
      { agent: "weft", before: ["x"] },
    ]);
    expect(renderListChanges([], "pi")).toEqual([
      "  No change to the pi lists.",
    ]);
  });
});

describe("attributeModels", () => {
  it("gives each merged entry the first layer that lists it", () => {
    const builtin = config('agent loom {\n  models ["b1", "b2"]\n}\n');
    const global = config('agent loom {\n  models ["g", "r"]\n}\n');
    const project = config('agent loom {\n  models ["p"]\n}\n');
    const merged = config(
      'agent loom {\n  models ["p", "g", "r", "b1", "b2"]\n}\n',
    );
    expect(
      attributeModels(
        merged,
        { builtin, global, project, recommended: { loom: ["r", "b1"] } },
        ["loom", "missing"],
      ),
    ).toEqual({
      loom: [
        { model: "p", source: "project" },
        { model: "g", source: "global" },
        { model: "r", source: "global" },
        { model: "b1", source: "recommended" },
        { model: "b2", source: "builtin" },
      ],
    });
  });
});

describe("chooseHarness", () => {
  it("defaults to OpenCode 2", () => {
    expect(chooseHarness(undefined)._unsafeUnwrap()).toEqual({
      type: "supported",
      harness: "opencode2",
    });
  });

  it("knows OpenCode V1 and Copilot CLI take no recommendations", () => {
    expect(chooseHarness("opencode")._unsafeUnwrap().type).toBe("unsupported");
    expect(chooseHarness("copilot")._unsafeUnwrap().type).toBe("unsupported");
  });

  it("rejects other names", () => {
    expect(chooseHarness("emacs")._unsafeUnwrapErr().type).toBe("InvalidArgs");
  });
});
