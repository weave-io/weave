import { describe, expect, it } from "bun:test";
import {
  type EvalRunInputs,
  KNOWN_EVAL_AGENTS,
  KNOWN_EVAL_AGENTS_SORTED,
  parseEvalRunRequest,
} from "../input-validation.js";
import { EVAL_AGENT_FILTERS, EVAL_SUITE_REGISTRY } from "../types.js";

// Helper: build a clean non-CI env map
function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...overrides };
}

// Helper: build inputs with no-CI env as default
function inputs(
  overrides: Partial<EvalRunInputs> & {
    envOverrides?: Record<string, string | undefined>;
  } = {},
): EvalRunInputs {
  const { envOverrides, ...rest } = overrides;
  return {
    env: env(envOverrides),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Happy path — empty/minimal inputs
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — happy paths", () => {
  it("returns ok with all undefined filters and defaults when inputs are empty", () => {
    const result = parseEvalRunRequest(inputs());
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.case).toBeUndefined();
    expect(req.dryRun).toBe(false);
    expect(req.rawArtifacts).toBe(false);
  });

  it("passes through valid agent, model, and case filters", () => {
    const result = parseEvalRunRequest(
      inputs({ agent: "loom", model: "claude-sonnet-4-5", case: "case-01" }),
    );
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBe("loom");
    expect(req.model).toBe("claude-sonnet-4-5");
    expect(req.case).toBe("case-01");
  });

  it("accepts identifiers with dots and slashes in model/case (not agent — agent has allowlist)", () => {
    const result = parseEvalRunRequest(
      inputs({ agent: "tapestry", model: "provider/model-id:v1" }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts identifiers with @ symbol", () => {
    const result = parseEvalRunRequest(
      inputs({ model: "openai/gpt-4o@latest" }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().model).toBe("openai/gpt-4o@latest");
  });

  it("sets dryRun=true when passed", () => {
    const result = parseEvalRunRequest(inputs({ dryRun: true }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().dryRun).toBe(true);
  });

  it("sets rawArtifacts=true in non-CI env when passed", () => {
    const result = parseEvalRunRequest(inputs({ rawArtifacts: true }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().rawArtifacts).toBe(true);
  });

  it("merges env variable filters when no CLI flag is supplied", () => {
    const result = parseEvalRunRequest(
      inputs({
        envOverrides: {
          WEAVE_EVAL_AGENT: "loom",
          WEAVE_EVAL_MODEL: "claude-sonnet-4-5",
          WEAVE_EVAL_CASE: "case-02",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBe("loom");
    expect(req.model).toBe("claude-sonnet-4-5");
    expect(req.case).toBe("case-02");
  });

  it("treats empty env filter values as absent", () => {
    const result = parseEvalRunRequest(
      inputs({
        envOverrides: {
          WEAVE_EVAL_AGENT: "",
          WEAVE_EVAL_MODEL: "",
          WEAVE_EVAL_CASE: "",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.case).toBeUndefined();
  });

  it("allows publish mode with blank CI env filters", () => {
    const result = parseEvalRunRequest(
      inputs({
        envOverrides: {
          CI: "true",
          WEAVE_EVAL_PUBLISH_MODE: "publish",
          WEAVE_EVAL_AGENT: "",
          WEAVE_EVAL_MODEL: "",
          WEAVE_EVAL_CASE: "",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.case).toBeUndefined();
  });

  it("treats whitespace-only env filter values as absent", () => {
    const result = parseEvalRunRequest(
      inputs({
        envOverrides: {
          WEAVE_EVAL_AGENT: "   ",
          WEAVE_EVAL_MODEL: "\t",
          WEAVE_EVAL_CASE: "\n",
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    const req = result._unsafeUnwrap();
    expect(req.agent).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.case).toBeUndefined();
  });

  it("lets a CLI flag override an empty env filter value", () => {
    const result = parseEvalRunRequest(
      inputs({
        agent: "loom",
        envOverrides: { WEAVE_EVAL_AGENT: "" },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("loom");
  });

  it("collapses identical duplicate values silently", () => {
    const result = parseEvalRunRequest(
      inputs({
        agent: "loom",
        envOverrides: { WEAVE_EVAL_AGENT: "loom" },
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("loom");
  });
});

// ---------------------------------------------------------------------------
// EmptyFilterValue errors
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — empty filter values", () => {
  it("rejects empty agent filter", () => {
    const result = parseEvalRunRequest(inputs({ agent: "" }));
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("EmptyFilterValue");
    if (e.type === "EmptyFilterValue") {
      expect(e.filter).toBe("agent");
    }
    expect(e.message).toContain("--agent");
  });

  it("rejects whitespace-only agent filter", () => {
    const result = parseEvalRunRequest(inputs({ agent: "   " }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("EmptyFilterValue");
  });

  it("rejects empty model filter", () => {
    const result = parseEvalRunRequest(inputs({ model: "" }));
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("EmptyFilterValue");
    if (e.type === "EmptyFilterValue") {
      expect(e.filter).toBe("model");
    }
  });

  it("rejects empty case filter", () => {
    const result = parseEvalRunRequest(inputs({ case: "" }));
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("EmptyFilterValue");
    if (e.type === "EmptyFilterValue") {
      expect(e.filter).toBe("case");
    }
  });
});

// ---------------------------------------------------------------------------
// InvalidFilterIdentifier errors
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — invalid identifier characters", () => {
  it("rejects agent with space", () => {
    const result = parseEvalRunRequest(inputs({ agent: "my agent" }));
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFilterIdentifier");
    if (e.type === "InvalidFilterIdentifier") {
      expect(e.filter).toBe("agent");
      expect(e.message).toContain("my agent");
    }
  });

  it("rejects agent with shell-special characters ($)", () => {
    const result = parseEvalRunRequest(inputs({ agent: "shuttle$name" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidFilterIdentifier");
  });

  it("rejects model with control character", () => {
    const result = parseEvalRunRequest(inputs({ model: "model\nid" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidFilterIdentifier");
  });

  it("rejects case with semicolons (potential injection risk)", () => {
    const result = parseEvalRunRequest(inputs({ case: "case;drop-db" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidFilterIdentifier");
  });

  it("rejects case with regex-special characters (.*)", () => {
    const result = parseEvalRunRequest(inputs({ case: "case.*" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("InvalidFilterIdentifier");
  });

  it("rejects unknown WEAVE_EVAL_* env vars", () => {
    const result = parseEvalRunRequest(
      inputs({ envOverrides: { WEAVE_EVAL_AGNET: "loom" } }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("InvalidFilterIdentifier");
    if (e.type === "InvalidFilterIdentifier") {
      expect(e.filter).toBe("WEAVE_EVAL_AGNET");
      expect(e.message).toContain("Unknown eval env var");
      expect(e.message).toContain("WEAVE_EVAL_PUBLISH_MODE");
    }
  });
});

// ---------------------------------------------------------------------------
// RawArtifactsInCI errors
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — rawArtifacts CI guard", () => {
  it("rejects rawArtifacts when CI=true", () => {
    const result = parseEvalRunRequest(
      inputs({ rawArtifacts: true, envOverrides: { CI: "true" } }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("RawArtifactsInCI");
    expect(e.message).toContain("--raw-artifacts");
  });

  it("rejects rawArtifacts when CI=1", () => {
    const result = parseEvalRunRequest(
      inputs({ rawArtifacts: true, envOverrides: { CI: "1" } }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("RawArtifactsInCI");
  });

  it("allows rawArtifacts when CI is not set", () => {
    const result = parseEvalRunRequest(inputs({ rawArtifacts: true }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().rawArtifacts).toBe(true);
  });

  it("allows rawArtifacts when CI=false", () => {
    const result = parseEvalRunRequest(
      inputs({ rawArtifacts: true, envOverrides: { CI: "false" } }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("allows rawArtifacts when CI=0", () => {
    const result = parseEvalRunRequest(
      inputs({ rawArtifacts: true, envOverrides: { CI: "0" } }),
    );
    expect(result.isOk()).toBe(true);
  });

  it("does not reject dryRun in CI", () => {
    const result = parseEvalRunRequest(
      inputs({ dryRun: true, envOverrides: { CI: "true" } }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DuplicateConflictingInput errors
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — duplicate conflicting inputs", () => {
  it("rejects conflicting agent from CLI and env", () => {
    const result = parseEvalRunRequest(
      inputs({
        agent: "loom",
        envOverrides: { WEAVE_EVAL_AGENT: "shuttle" },
      }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("DuplicateConflictingInput");
    if (e.type === "DuplicateConflictingInput") {
      expect(e.filter).toBe("agent");
      expect(e.message).toContain("loom");
      expect(e.message).toContain("shuttle");
    }
  });

  it("rejects conflicting model from CLI and env", () => {
    const result = parseEvalRunRequest(
      inputs({
        model: "model-a",
        envOverrides: { WEAVE_EVAL_MODEL: "model-b" },
      }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("DuplicateConflictingInput");
    if (e.type === "DuplicateConflictingInput") {
      expect(e.filter).toBe("model");
    }
  });

  it("rejects conflicting case from CLI and env", () => {
    const result = parseEvalRunRequest(
      inputs({
        case: "case-01",
        envOverrides: { WEAVE_EVAL_CASE: "case-02" },
      }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("DuplicateConflictingInput");
    if (e.type === "DuplicateConflictingInput") {
      expect(e.filter).toBe("case");
    }
  });
});

// ---------------------------------------------------------------------------
// UnknownAgentFilter errors — agent allowlist validation
// ---------------------------------------------------------------------------

describe("parseEvalRunRequest — agent allowlist validation", () => {
  it("rejects an unknown agent value (fails closed before any execution)", () => {
    const result = parseEvalRunRequest(
      inputs({ agent: "unknown-shuttle-agent" }),
    );
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("UnknownAgentFilter");
    if (e.type === "UnknownAgentFilter") {
      expect(e.value).toBe("unknown-shuttle-agent");
      expect(e.allowedValues).toEqual(
        expect.arrayContaining(["loom", "tapestry"]),
      );
      expect(e.message).toContain("unknown-shuttle-agent");
      expect(e.message).toContain("loom");
    }
  });

  it("rejects 'org/shuttle.v2' (not in allowlist even if valid identifier syntax)", () => {
    const result = parseEvalRunRequest(inputs({ agent: "org/shuttle.v2" }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnknownAgentFilter");
  });

  it("accepts 'loom' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "loom" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("loom");
  });

  it("accepts 'tapestry' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "tapestry" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("tapestry");
  });

  it("accepts 'loom-routing' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "loom-routing" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("loom-routing");
  });

  it("accepts 'tapestry-execution' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "tapestry-execution" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("tapestry-execution");
  });

  it("accepts 'shuttle' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "shuttle" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("shuttle");
  });

  it("accepts 'shuttle-execution' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "shuttle-execution" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("shuttle-execution");
  });

  it("accepts 'spindle' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "spindle" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("spindle");
  });

  it("accepts 'spindle-tools' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "spindle-tools" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("spindle-tools");
  });

  it("accepts 'pattern' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "pattern" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("pattern");
  });

  it("accepts 'pattern-planning' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "pattern-planning" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("pattern-planning");
  });

  it("accepts 'weft' — known eval agent", () => {
    const result = parseEvalRunRequest(inputs({ agent: "weft" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("weft");
  });

  it("accepts 'weft-review' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "weft-review" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("weft-review");
  });

  it("accepts 'warp' — known eval agent for warp-security", () => {
    const result = parseEvalRunRequest(inputs({ agent: "warp" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("warp");
  });

  it("accepts 'warp-security' — known eval suite name", () => {
    const result = parseEvalRunRequest(inputs({ agent: "warp-security" }));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBe("warp-security");
  });

  it("rejects unknown agent from env variable (WEAVE_EVAL_AGENT)", () => {
    const result = parseEvalRunRequest(
      inputs({ envOverrides: { WEAVE_EVAL_AGENT: "unknown-agent-xyz" } }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnknownAgentFilter");
  });

  it("error message includes the allowed values list", () => {
    const result = parseEvalRunRequest(inputs({ agent: "bad-agent" }));
    const e = result._unsafeUnwrapErr();
    if (e.type === "UnknownAgentFilter") {
      for (const allowed of KNOWN_EVAL_AGENTS_SORTED) {
        expect(e.message).toContain(allowed);
      }
    }
  });

  it("undefined agent is not validated against the allowlist (pass-through)", () => {
    // No --agent filter = all suites run
    const result = parseEvalRunRequest(inputs({}));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KNOWN_EVAL_AGENTS exports
// ---------------------------------------------------------------------------

describe("KNOWN_EVAL_AGENTS — exported constants", () => {
  it("KNOWN_EVAL_AGENTS is sourced from the shared eval suite registry", () => {
    expect([...KNOWN_EVAL_AGENTS].sort()).toEqual(
      [...EVAL_AGENT_FILTERS].sort(),
    );
  });

  it("shared registry contributes unique short agent filters and all suite IDs, deduplicated", () => {
    // KNOWN_EVAL_AGENTS is the union of all shortAgentFilters and all suiteIds,
    // with duplicates removed (e.g. "tapestry" appears once even though two
    // suites share that shortAgentFilter).
    const expectedValues = [
      ...new Set([
        ...EVAL_SUITE_REGISTRY.map((suite) => suite.shortAgentFilter),
        ...EVAL_SUITE_REGISTRY.map((suite) => suite.suiteId),
      ]),
    ].sort();
    expect(KNOWN_EVAL_AGENTS_SORTED).toEqual(expectedValues);
    // Size is the union size, not 2 * suite count when filters are shared.
    expect(KNOWN_EVAL_AGENTS_SORTED.length).toBe(expectedValues.length);
  });

  it("tapestry shortAgentFilter appears once in KNOWN_EVAL_AGENTS while both tapestry suite IDs are present", () => {
    // Two suites share shortAgentFilter "tapestry"; the set deduplicates it.
    const tapestryCount = [...KNOWN_EVAL_AGENTS].filter(
      (v) => v === "tapestry",
    ).length;
    expect(tapestryCount).toBe(1);
    // Both suite IDs must be individually present.
    expect(
      KNOWN_EVAL_AGENTS.has(
        "tapestry-execution" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
    expect(
      KNOWN_EVAL_AGENTS.has(
        "tapestry-category-routing" as Parameters<
          (typeof KNOWN_EVAL_AGENTS)["has"]
        >[0],
      ),
    ).toBe(true);
  });

  it("KNOWN_EVAL_AGENTS contains shuttle and shuttle-execution", () => {
    expect(
      KNOWN_EVAL_AGENTS.has(
        "shuttle" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
    expect(
      KNOWN_EVAL_AGENTS.has(
        "shuttle-execution" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
  });

  it("KNOWN_EVAL_AGENTS contains spindle and spindle-tools", () => {
    expect(
      KNOWN_EVAL_AGENTS.has(
        "spindle" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
    expect(
      KNOWN_EVAL_AGENTS.has(
        "spindle-tools" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
  });

  it("KNOWN_EVAL_AGENTS contains warp and warp-security", () => {
    expect(
      KNOWN_EVAL_AGENTS.has(
        "warp" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
    expect(
      KNOWN_EVAL_AGENTS.has(
        "warp-security" as Parameters<(typeof KNOWN_EVAL_AGENTS)["has"]>[0],
      ),
    ).toBe(true);
  });

  it("KNOWN_EVAL_AGENTS_SORTED is sorted alphabetically", () => {
    const sorted = [...KNOWN_EVAL_AGENTS_SORTED].sort();
    expect(KNOWN_EVAL_AGENTS_SORTED).toEqual(sorted);
  });
});
