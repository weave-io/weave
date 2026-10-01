/**
 * Scenarios in `tests/adapters/opencode2-model-updates.scenario.test.ts`
 * cover what a user observes: a promoted list reaching Loom without a
 * restart, and no fetch with `mode off`.
 *
 * Kept: the background trigger's single flight and its guards, which a
 * scenario cannot race; which reloads count as a recommendation change; the
 * notice text; and the RPC schema bounds for `modelUpdates` and
 * `models.changed`.
 */

import { describe, expect, it } from "bun:test";
import type {
  RefreshError,
  RefreshOutcome,
  RefreshRequest,
} from "@weaveio/weave-config";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { WeaveRpc } from "../rpc.js";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import { buildOpenCode2Health } from "../v2/health.js";
import {
  formatIssuedDate,
  modelUpdateNotice,
} from "../v2/model-update-notice.js";
import {
  type OpenCode2ModelRecommendationsRefresher,
  type OpenCode2ModelUpdates,
  OpenCode2ModelUpdatesTrigger,
  recommendedModelChanges,
} from "../v2/model-updates.js";
import type { OpenCode2AgentProjection } from "../v2/translate-agent.js";
import { catalog, MODEL_UPDATES_OFF, projection } from "./v2-fixtures.js";

class StubRefresher implements OpenCode2ModelRecommendationsRefresher {
  readonly requests: RefreshRequest[] = [];
  private release?: () => void;
  constructor(
    private readonly result: () => ResultAsync<
      RefreshOutcome,
      RefreshError
    > = () => okAsync({ type: "Off" }),
    private readonly hold = false,
  ) {}
  refresh(request: RefreshRequest) {
    this.requests.push(request);
    if (!this.hold) return this.result();
    const gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return ResultAsync.fromSafePromise(gate).andThen(() => this.result());
  }
  finish(): void {
    this.release?.();
  }
}

describe("OpenCode2ModelUpdatesTrigger", () => {
  it("never refreshes without an opt-in or with mode off", () => {
    const refresher = new StubRefresher();
    new OpenCode2ModelUpdatesTrigger(refresher, () => undefined).trigger();
    new OpenCode2ModelUpdatesTrigger(refresher, () => ({
      mode: "off",
    })).trigger();
    expect(refresher.requests).toEqual([]);
  });

  it("refreshes with the published settings, one at a time", async () => {
    const refresher = new StubRefresher(undefined, true);
    const trigger = new OpenCode2ModelUpdatesTrigger(refresher, () => ({
      mode: "auto",
      channel: "next",
    }));
    trigger.trigger();
    trigger.trigger();
    expect(refresher.requests).toEqual([
      { settings: { mode: "auto", channel: "next" } },
    ]);
    refresher.finish();
    await trigger.settled();
    trigger.trigger();
    expect(refresher.requests).toHaveLength(2);
  });

  it("returns before the refresh finishes", () => {
    const refresher = new StubRefresher(undefined, true);
    const trigger = new OpenCode2ModelUpdatesTrigger(refresher, () => ({
      mode: "notify",
    }));
    let returned = false;
    trigger.trigger();
    returned = true;
    expect(returned).toBe(true);
    expect(refresher.requests).toHaveLength(1);
  });

  it("starts nothing once disposed", () => {
    const refresher = new StubRefresher();
    const trigger = new OpenCode2ModelUpdatesTrigger(refresher, () => ({
      mode: "auto",
    }));
    trigger.dispose();
    trigger.trigger();
    expect(refresher.requests).toEqual([]);
  });

  it("absorbs a failed refresh and a refresher that throws", async () => {
    const failing = new OpenCode2ModelUpdatesTrigger(
      new StubRefresher(() =>
        errAsync({
          type: "CheckFailed",
          channel: "stable",
          failure: { type: "Network", message: "offline" },
        }),
      ),
      () => ({ mode: "auto" }),
    );
    failing.trigger();
    await failing.settled();

    const throwing = new OpenCode2ModelUpdatesTrigger(
      {
        refresh: () => {
          throw new Error("boom");
        },
      },
      () => ({ mode: "auto" }),
    );
    expect(() => throwing.trigger()).not.toThrow();
    await throwing.settled();
  });
});

const APPLIED_1: OpenCode2ModelUpdates = {
  settings: { mode: "auto" },
  mode: "auto",
  channel: "stable",
  state: "applied",
  issued: "2026-09-30T09:00:00Z",
  agents: ["loom", "tapestry"],
};
const APPLIED_2: OpenCode2ModelUpdates = {
  ...APPLIED_1,
  issued: "2026-10-01T09:00:00Z",
};

function onModels(
  models: Record<string, string | undefined>,
  modelUpdates: OpenCode2ModelUpdates,
  extra: Partial<OpenCode2AgentProjection> = {},
): OpenCode2CatalogCandidate {
  const projections = new Map<string, OpenCode2AgentProjection>(
    Object.entries(models).map(([name, model]) => [
      name,
      {
        ...projection(name),
        ...extra,
        ...(model === undefined
          ? {}
          : { model: { providerID: "anthropic", id: model } as never }),
      },
    ]),
  );
  return { ...catalog(projections), modelUpdates };
}

describe("recommendedModelChanges", () => {
  it("names each agent a newly applied list moved to another model", () => {
    const notice = recommendedModelChanges(
      onModels({ loom: "opus-5-5", tapestry: "sonnet-5" }, APPLIED_1),
      onModels({ loom: "opus-5-6", tapestry: "sonnet-5" }, APPLIED_2),
    );
    expect(notice).toEqual({
      issued: "2026-10-01T09:00:00Z",
      agents: [{ agent: "loom", providerID: "anthropic", model: "opus-5-6" }],
    });
  });

  it("counts the first applied list after nothing was applied", () => {
    const pending = { ...MODEL_UPDATES_OFF, mode: "auto", state: "pending" };
    const notice = recommendedModelChanges(
      onModels({ loom: undefined }, pending as OpenCode2ModelUpdates),
      onModels({ loom: "opus-5-6" }, APPLIED_2),
    );
    expect(notice?.agents.map((agent) => agent.agent)).toEqual(["loom"]);
  });

  it("carries a display name when the agent has one", () => {
    const notice = recommendedModelChanges(
      onModels({ loom: "opus-5-5" }, APPLIED_1),
      onModels({ loom: "opus-5-6" }, APPLIED_2, { displayName: "Loom" }),
    );
    expect(notice?.agents[0]?.displayName).toBe("Loom");
  });

  it("ignores a reload when the applied list did not change", () => {
    expect(
      recommendedModelChanges(
        onModels({ loom: "opus-5-5" }, APPLIED_2),
        onModels({ loom: "opus-5-6" }, APPLIED_2),
      ),
    ).toBeUndefined();
  });

  it("ignores agents the list does not set, and a skipped list", () => {
    expect(
      recommendedModelChanges(
        onModels({ shuttle: "a" }, APPLIED_1),
        onModels({ shuttle: "b" }, APPLIED_2),
      ),
    ).toBeUndefined();
    expect(
      recommendedModelChanges(
        onModels({ loom: "opus-5-6" }, APPLIED_2),
        onModels({ loom: "opus-5-5" }, { ...APPLIED_2, state: "unavailable" }),
      ),
    ).toBeUndefined();
  });

  it("credits nothing to the list when the user's config or the inventory changed in the same reload", () => {
    const edited = {
      ...onModels({ loom: "opus-5-6" }, APPLIED_2),
      baseRevision: "c".repeat(64),
    };
    expect(
      recommendedModelChanges(
        onModels({ loom: "opus-5-5" }, APPLIED_1),
        edited,
      ),
    ).toBeUndefined();
  });

  it("names the variant when only the variant moved", () => {
    const withVariant = onModels({ loom: "opus-5-5" }, APPLIED_2);
    const loom = withVariant.agents.get("loom");
    const next = {
      ...withVariant,
      agents: new Map([
        [
          "loom",
          {
            ...(loom as OpenCode2AgentProjection),
            model: { providerID: "anthropic", id: "opus-5-5", variant: "high" },
          } as OpenCode2AgentProjection,
        ],
      ]),
    };
    expect(
      recommendedModelChanges(onModels({ loom: "opus-5-5" }, APPLIED_1), next)
        ?.agents,
    ).toEqual([
      {
        agent: "loom",
        providerID: "anthropic",
        model: "opus-5-5",
        variant: "high",
      },
    ]);
  });

  it("leaves out a display name the event cannot carry", () => {
    for (const displayName of ["", "x".repeat(129)]) {
      const notice = recommendedModelChanges(
        onModels({ loom: "opus-5-5" }, APPLIED_1),
        onModels({ loom: "opus-5-6" }, APPLIED_2, { displayName }),
      );
      expect(notice?.agents[0]).toEqual({
        agent: "loom",
        providerID: "anthropic",
        model: "opus-5-6",
      });
    }
  });

  it("ignores a list that left every model where it was", () => {
    expect(
      recommendedModelChanges(
        onModels({ loom: "opus-5-5" }, APPLIED_1),
        onModels({ loom: "opus-5-5" }, APPLIED_2),
      ),
    ).toBeUndefined();
  });
});

describe("modelUpdateNotice", () => {
  it("says which model the agent now runs on and which list did it", () => {
    expect(
      modelUpdateNotice({
        issued: "2026-10-01T09:00:00Z",
        agents: [{ agent: "loom", model: "claude-opus-5.6" }],
      }),
    ).toBe(
      "Loom now runs on claude-opus-5.6 (model recommendations of 1 Oct 2026)",
    );
  });

  it("names three agents and counts the rest", () => {
    expect(
      modelUpdateNotice({
        issued: "2026-12-31T23:00:00Z",
        agents: [
          { agent: "loom", model: "a" },
          { agent: "tapestry", displayName: "The Tapestry", model: "b" },
          { agent: "shuttle", model: "c" },
          { agent: "weft", model: "d" },
          { agent: "warp", model: "e" },
        ],
      }),
    ).toBe(
      "Loom now runs on a, The Tapestry on b, Shuttle on c and 2 more agents (model recommendations of 31 Dec 2026)",
    );
  });

  it("writes a variant the way a models entry does", () => {
    expect(
      modelUpdateNotice({
        issued: "2026-10-01T09:00:00Z",
        agents: [{ agent: "loom", model: "gpt-6-sol", variant: "high" }],
      }),
    ).toBe(
      "Loom now runs on gpt-6-sol#high (model recommendations of 1 Oct 2026)",
    );
  });

  it("shows an unparseable date as it came", () => {
    expect(formatIssuedDate("soon")).toBe("soon");
  });
});

describe("model updates in the RPC contract", () => {
  const scope = { sessionID: "session", scopeToken: "token" };

  it("reports the applied list in a status the schema accepts", () => {
    const health = buildOpenCode2Health(
      { ...catalog(), modelUpdates: APPLIED_2 },
      { state: "fresh" },
    );
    expect(health.modelUpdates).toEqual({
      mode: "auto",
      channel: "stable",
      state: "applied",
      issued: "2026-10-01T09:00:00Z",
    });
    expect(
      WeaveRpc.methods.status.output.safeParse({ scope, ...health }).success,
    ).toBe(true);
  });

  it("reports model updates off, and nothing before a catalog exists", () => {
    expect(
      buildOpenCode2Health(catalog(), { state: "fresh" }).modelUpdates,
    ).toEqual({ mode: "off", channel: "stable", state: "off" });
    expect(
      buildOpenCode2Health(undefined, { state: "initializing" }).modelUpdates,
    ).toBeUndefined();
  });

  it("rejects an unbounded or unknown modelUpdates field", () => {
    const status = (modelUpdates: unknown) =>
      WeaveRpc.methods.status.output.safeParse({
        scope,
        refresh: "fresh",
        agentCount: 0,
        issues: [],
        readiness: {
          nativeAgents: false,
          requestIntent: false,
          foregroundPlans: false,
          planDisplay: false,
          nativeDelegation: false,
          durableWorkflows: false,
        },
        modelUpdates,
      }).success;
    const valid = { mode: "auto", channel: "next", state: "pending" };
    expect(status(valid)).toBe(true);
    expect(status({ ...valid, state: "stale" })).toBe(false);
    expect(status({ ...valid, evidence: "https://example.test" })).toBe(false);
    expect(status({ ...valid, issued: "2026-10-01T09:00:00Z" })).toBe(false);
    const applied = {
      ...valid,
      state: "applied",
      issued: "2026-10-01T09:00:00Z",
    };
    expect(status(applied)).toBe(true);
    expect(status({ ...applied, issued: undefined })).toBe(false);
    expect(status({ ...applied, issued: "x".repeat(65) })).toBe(false);
  });

  it("bounds the models.changed event", () => {
    const schema = WeaveRpc.events["models.changed"].schema;
    const agent = { agent: "loom", providerID: "anthropic", model: "opus" };
    expect(
      schema.safeParse({ issued: "2026-10-01T09:00:00Z", agents: [agent] })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ issued: "2026-10-01T09:00:00Z", agents: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        issued: "2026-10-01T09:00:00Z",
        agents: Array.from({ length: 65 }, () => agent),
      }).success,
    ).toBe(false);
  });
});
