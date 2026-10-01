import { describe, expect, it } from "bun:test";
import { WeaveRpc } from "../rpc.js";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import { buildOpenCode2Health } from "../v2/health.js";
import { MODEL_UPDATES_OFF } from "./v2-fixtures.js";

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
    modelUpdates: MODEL_UPDATES_OFF,
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

  it("reports a skipped model recommendations layer in a status the RPC schema accepts", () => {
    const catalog: OpenCode2CatalogCandidate = {
      ...catalogWithIssues(0),
      issues: [{ code: "model_updates_unavailable" }],
    };
    const health = buildOpenCode2Health(catalog, { state: "fresh" });

    expect(health.issues).toEqual([
      { code: "model_updates_unavailable", agentName: undefined },
    ]);
    const parsed = WeaveRpc.methods.status.output.safeParse({
      scope: { sessionID: "session", scopeToken: "token" },
      ...health,
    });
    expect(parsed.success).toBe(true);
  });
});
