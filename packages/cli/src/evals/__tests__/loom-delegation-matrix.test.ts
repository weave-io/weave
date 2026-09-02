/**
 * Tests for `loom-delegation-matrix.ts`.
 *
 * Proves:
 *   - `resolveLoomDelegationTargets` derives eligibility exclusively from the
 *     fully composed Loom `AgentDescriptor.delegationTargets` — not a
 *     hardcoded agent-name array — including disabled-agent exclusion,
 *     primary-mode exclusion, `delegate: deny` exclusion, and an
 *     added-category target appearing once configured.
 *   - `validateLoomDelegationMatrixCoverage` fails closed unless every
 *     composed target has at least one `polarity:positive` and one
 *     `polarity:boundary` tagged case, and flags any case still targeting a
 *     removed/renamed agent.
 *   - `runLoomDelegationMatrixPreflight` composes both steps and surfaces a
 *     single typed error before any model call would occur.
 *
 * All dependencies (config loading, composition, case loading) are injected
 * via `ResultAsync`-returning stubs — no real filesystem discovery, no
 * project `.weave/config.weave` overrides, no real eval fixture reads.
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import { composeAgentDescriptor } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  DELEGATION_MATRIX_BOUNDARY_TAG,
  DELEGATION_MATRIX_POSITIVE_TAG,
  type DelegationMatrixConfigLoader,
  resolveLoomDelegationTargets,
  runLoomDelegationMatrixPreflight,
  validateLoomDelegationMatrixCoverage,
} from "../loom-delegation-matrix.js";
import type { EvalCase, FixtureSchemaError } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture config builders — real `.weave` DSL parsed via `parseConfig`, no
// hand-built AST/schema objects, so composition exercises the real pipeline.
// ---------------------------------------------------------------------------

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) {
    throw new Error(`parseConfig failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const BASE_SOURCE = `
agent loom {
  description "Primary orchestrator"
  prompt "You are Loom."
  models ["anthropic/claude-sonnet-4-5"]
  mode primary

  tool_policy {
    delegate allow
  }

  routing {
    delegation_exclude ["reviewer-only"]
  }

  triggers []
}

agent tapestry {
  description "Category orchestrator"
  prompt "You are Tapestry."
  models ["anthropic/claude-sonnet-4-5"]
  mode primary

  tool_policy {
    delegate allow
  }
}

agent shuttle {
  description "Generalist implementer"
  prompt "You are Shuttle."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent

  tool_policy {
    delegate deny
  }

  triggers [
    { domain "General" trigger "General implementation work" }
  ]
}

agent warp {
  description "Security auditor"
  prompt "You are Warp."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent

  tool_policy {
    delegate deny
  }

  triggers [
    { domain "Security" trigger "Security-sensitive changes" }
  ]
}

agent reviewer-only {
  description "Non-delegating reviewer, excluded via routing.delegation_exclude"
  prompt "You review."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent

  tool_policy {
    delegate deny
  }

  triggers [
    { domain "Review" trigger "Post-change review" }
  ]
}
`;

function makeConfigLoader(source: string): DelegationMatrixConfigLoader {
  return () => okAsync(cfg(source));
}

// ---------------------------------------------------------------------------
// resolveLoomDelegationTargets — eligibility comes from full composition
// ---------------------------------------------------------------------------

describe("resolveLoomDelegationTargets", () => {
  it("returns descriptor.delegationTargets for the base config (shuttle + warp are eligible; reviewer-only is explicitly excluded)", async () => {
    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const names = result.value.map((t) => t.name).sort();
    expect(names).toContain("shuttle");
    expect(names).toContain("warp");
    // reviewer-only is excluded via loom's routing.delegation_exclude — see
    // the dedicated delegation-exclusion test below for the isolated proof.
    expect(names).not.toContain("reviewer-only");
    // Primary-mode agents (loom itself, tapestry) must never appear.
    expect(names).not.toContain("loom");
    expect(names).not.toContain("tapestry");
  });

  it("excludes a disabled agent from the composed target set (disabled-agent case)", async () => {
    const source = `${BASE_SOURCE}\ndisable agents ["warp"]\n`;

    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(source),
      composer: composeAgentDescriptor,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const names = result.value.map((t) => t.name);
    expect(names).not.toContain("warp");
    expect(names).toContain("shuttle");
  });

  it("excludes a primary-mode agent from the composed target set (primary-mode case)", async () => {
    // tapestry is mode primary in BASE_SOURCE; assert it is never a target
    // regardless of any tool_policy — composition, not a hardcoded filter,
    // is what excludes it.
    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.map((t) => t.name)).not.toContain("tapestry");
  });

  it("excludes an agent listed in loom's routing.delegation_exclude (delegation-exclusion case)", async () => {
    // reviewer-only has delegate:deny and real triggers (so it would
    // otherwise be eligible), but loom's own routing.delegation_exclude
    // names it explicitly — composition must still exclude it.
    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.map((t) => t.name)).not.toContain("reviewer-only");
  });

  it("includes a newly added agent with triggers once configured (added-category case)", async () => {
    const sourceWithAddedAgent = `${BASE_SOURCE}
agent shuttle-frontend {
  description "Frontend category specialist"
  prompt "You are the frontend shuttle."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent

  tool_policy {
    delegate deny
  }

  triggers [
    { domain "Frontend" trigger "UI and styling work" }
  ]
}
`;

    const before = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
    });
    const after = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(sourceWithAddedAgent),
      composer: composeAgentDescriptor,
    });

    expect(before.isOk()).toBe(true);
    expect(after.isOk()).toBe(true);
    if (!before.isOk() || !after.isOk()) return;

    expect(before.value.map((t) => t.name)).not.toContain("shuttle-frontend");
    expect(after.value.map((t) => t.name)).toContain("shuttle-frontend");
  });

  it("returns ConfigLoadFailed when the config loader fails", async () => {
    const result = await resolveLoomDelegationTargets({
      configLoader: () => errAsync([{ message: "boom" }]),
      composer: composeAgentDescriptor,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("ConfigLoadFailed");
  });

  it("returns LoomAgentNotFound when the resolved config has no loom agent", async () => {
    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(`
agent shuttle {
  prompt "You are Shuttle."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent
  tool_policy { delegate deny }
  triggers [{ domain "General" trigger "General work" }]
}
`),
      composer: composeAgentDescriptor,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("LoomAgentNotFound");
  });

  it("returns ComposeFailed when the injected composer fails", async () => {
    const result = await resolveLoomDelegationTargets({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: () =>
        errAsync({
          type: "TemplateContextBuildError",
          agentName: "loom",
          message: "stub composer failure",
        }),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("ComposeFailed");
  });
});

// ---------------------------------------------------------------------------
// validateLoomDelegationMatrixCoverage — fail-closed polarity coverage
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    description: "test case",
    suite: "loom-routing",
    allowed_agents: ["loom"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: { kind: "agent_routing", target_agent: "loom", via: [] },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

describe("validateLoomDelegationMatrixCoverage", () => {
  it("passes when every composed target has a positive and a boundary case", () => {
    const result = validateLoomDelegationMatrixCoverage(
      ["shuttle", "warp"],
      [
        makeCase({
          id: "shuttle-positive",
          tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
        }),
        makeCase({
          id: "shuttle-boundary",
          tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
        }),
        makeCase({
          id: "warp-positive",
          tags: ["target:warp", DELEGATION_MATRIX_POSITIVE_TAG],
        }),
        makeCase({
          id: "warp-boundary",
          tags: ["target:warp", DELEGATION_MATRIX_BOUNDARY_TAG],
        }),
      ],
    );

    expect(result.isOk()).toBe(true);
  });

  it("fails when a composed target has no positive case", () => {
    const result = validateLoomDelegationMatrixCoverage(
      ["shuttle"],
      [
        makeCase({
          id: "shuttle-boundary",
          tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
        }),
      ],
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(
      result.error.some(
        (issue) =>
          issue.type === "MissingPositiveCase" && issue.target === "shuttle",
      ),
    ).toBe(true);
  });

  it("fails when a composed target has no boundary case", () => {
    const result = validateLoomDelegationMatrixCoverage(
      ["shuttle"],
      [
        makeCase({
          id: "shuttle-positive",
          tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
        }),
      ],
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(
      result.error.some(
        (issue) =>
          issue.type === "MissingBoundaryCase" && issue.target === "shuttle",
      ),
    ).toBe(true);
  });

  it("fails when a case targets an agent removed from the composed set", () => {
    // "warp" was removed (e.g. renamed/disabled) — no longer in composed targets —
    // but a fixture case still authoritatively targets it.
    const result = validateLoomDelegationMatrixCoverage(
      ["shuttle"],
      [
        makeCase({
          id: "shuttle-positive",
          tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
        }),
        makeCase({
          id: "shuttle-boundary",
          tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
        }),
        makeCase({
          id: "warp-stale",
          tags: ["target:warp", DELEGATION_MATRIX_POSITIVE_TAG],
        }),
      ],
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(
      result.error.some(
        (issue) =>
          issue.type === "CaseTargetsRemovedAgent" &&
          issue.target === "warp" &&
          issue.caseId === "warp-stale",
      ),
    ).toBe(true);
  });

  it("accumulates all issues in a single call rather than stopping at the first", () => {
    const result = validateLoomDelegationMatrixCoverage(
      ["shuttle", "warp"],
      [],
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    // Both targets missing both polarities: 4 issues, no removed-agent issues.
    expect(result.error).toHaveLength(4);
  });

  it("passes trivially with no composed targets and no cases", () => {
    const result = validateLoomDelegationMatrixCoverage([], []);
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runLoomDelegationMatrixPreflight — combined resolve + load + validate
// ---------------------------------------------------------------------------

describe("runLoomDelegationMatrixPreflight", () => {
  it("passes when composed targets and injected cases satisfy full coverage", async () => {
    const result = await runLoomDelegationMatrixPreflight({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
      caseLoader: () =>
        okAsync([
          makeCase({
            id: "shuttle-positive",
            tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
          makeCase({
            id: "shuttle-boundary",
            tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
          }),
          makeCase({
            id: "warp-positive",
            tags: ["target:warp", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
          makeCase({
            id: "warp-boundary",
            tags: ["target:warp", DELEGATION_MATRIX_BOUNDARY_TAG],
          }),
        ]),
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.map((t) => t.name).sort()).toEqual(["shuttle", "warp"]);
  });

  it("fails closed (CoverageFailed) when a composed target addition has no matching cases yet", async () => {
    // Adding shuttle-frontend as a new composed target with zero fixture
    // coverage must fail the preflight before any model call.
    const sourceWithAddedAgent = `${BASE_SOURCE}
agent shuttle-frontend {
  prompt "You are the frontend shuttle."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent
  tool_policy { delegate deny }
  triggers [{ domain "Frontend" trigger "UI and styling work" }]
}
`;

    const result = await runLoomDelegationMatrixPreflight({
      configLoader: makeConfigLoader(sourceWithAddedAgent),
      composer: composeAgentDescriptor,
      caseLoader: () =>
        okAsync([
          makeCase({
            id: "shuttle-positive",
            tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
          makeCase({
            id: "shuttle-boundary",
            tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
          }),
          makeCase({
            id: "warp-positive",
            tags: ["target:warp", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
          makeCase({
            id: "warp-boundary",
            tags: ["target:warp", DELEGATION_MATRIX_BOUNDARY_TAG],
          }),
        ]),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("CoverageFailed");
    if (result.error.type !== "CoverageFailed") return;
    expect(
      result.error.issues.some((issue) => issue.target === "shuttle-frontend"),
    ).toBe(true);
  });

  it("fails closed (CoverageFailed) when a composed target is removed but a stale case still targets it", async () => {
    const sourceWithoutWarp = `${BASE_SOURCE}\ndisable agents ["warp"]\n`;

    const result = await runLoomDelegationMatrixPreflight({
      configLoader: makeConfigLoader(sourceWithoutWarp),
      composer: composeAgentDescriptor,
      caseLoader: () =>
        okAsync([
          makeCase({
            id: "shuttle-positive",
            tags: ["target:shuttle", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
          makeCase({
            id: "shuttle-boundary",
            tags: ["target:shuttle", DELEGATION_MATRIX_BOUNDARY_TAG],
          }),
          makeCase({
            id: "warp-stale-positive",
            tags: ["target:warp", DELEGATION_MATRIX_POSITIVE_TAG],
          }),
        ]),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("CoverageFailed");
    if (result.error.type !== "CoverageFailed") return;
    expect(
      result.error.issues.some(
        (issue) =>
          issue.type === "CaseTargetsRemovedAgent" && issue.target === "warp",
      ),
    ).toBe(true);
  });

  it("propagates CaseLoadFailed without attempting coverage validation", async () => {
    const caseLoadError: FixtureSchemaError = {
      type: "FixtureFileNotFound",
      file: "/nonexistent/loom-routing/case.json",
      message: "not found",
    };

    const result = await runLoomDelegationMatrixPreflight({
      configLoader: makeConfigLoader(BASE_SOURCE),
      composer: composeAgentDescriptor,
      caseLoader: () => errAsync(caseLoadError),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("CaseLoadFailed");
  });

  it("propagates target-resolution failures (e.g. LoomAgentNotFound) before case loading is attempted", async () => {
    let caseLoaderCalled = false;

    const result = await runLoomDelegationMatrixPreflight({
      configLoader: makeConfigLoader(`
agent shuttle {
  prompt "You are Shuttle."
  models ["anthropic/claude-sonnet-4-5"]
  mode subagent
  tool_policy { delegate deny }
  triggers [{ domain "General" trigger "General work" }]
}
`),
      composer: composeAgentDescriptor,
      caseLoader: () => {
        caseLoaderCalled = true;
        return okAsync([]);
      },
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("LoomAgentNotFound");
    expect(caseLoaderCalled).toBe(false);
  });
});
