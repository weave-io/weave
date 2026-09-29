import { describe, expect, it } from "bun:test";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import { buildOpenCode2Health } from "../v2/health.js";

function catalogWithIssues(count: number): OpenCode2CatalogCandidate {
  return {
    revision: "a".repeat(64),
    agents: new Map(),
    runtime: new Map(),
    issues: Array.from({ length: count }, (_, index) => ({
      code: "model_unavailable" as const,
      agentName: `agent-${index}`,
      details: [],
    })),
    sources: [],
    heldAgents: [],
  };
}

describe("buildOpenCode2Health", () => {
  it("reports config_invalid first while the refresh is failed on an invalid config", () => {
    const health = buildOpenCode2Health(catalogWithIssues(2), {
      state: "failed",
      lastErrorCode: "config_invalid",
    });

    expect(health.issues[0]).toEqual({ code: "config_invalid" });
    expect(health.issues).toHaveLength(3);
  });

  it("keeps config_invalid when the catalog's own issues already fill the list", () => {
    const health = buildOpenCode2Health(catalogWithIssues(64), {
      state: "failed",
      lastErrorCode: "config_invalid",
    });

    expect(health.issues[0]).toEqual({ code: "config_invalid" });
    expect(health.issues).toHaveLength(64);
  });

  it("does not report config_invalid for other refresh failures", () => {
    const health = buildOpenCode2Health(catalogWithIssues(0), {
      state: "failed",
      lastErrorCode: "catalog_unavailable",
    });

    expect(health.issues).toEqual([]);
  });
});
