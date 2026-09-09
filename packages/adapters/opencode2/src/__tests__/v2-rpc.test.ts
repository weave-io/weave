import { describe, expect, it } from "bun:test";
import type {
  PlanTaskSnapshot,
  PlanTaskSnapshotReader,
} from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import { OpenCode2CatalogController } from "../v2/config-refresh.js";
import type { OpenCode2Context } from "../v2/host-types.js";
import {
  OpenCode2PlanSessionState,
  selectionFromSnapshot,
} from "../v2/plan-session-state.js";
import {
  createOpenCode2RpcHandlers,
  type OpenCode2RpcDependencies,
} from "../v2/rpc-handlers.js";
import { catalog, projection } from "./v2-fixtures.js";

class MemoryStorage {
  readonly values = new Map<
    string,
    Awaited<ReturnType<OpenCode2Context["storage"]["get"]>>
  >();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(
    key: string,
    value: Parameters<OpenCode2Context["storage"]["set"]>[1],
  ) {
    this.values.set(key, value);
  }
  async remove(key: string) {
    this.values.delete(key);
  }
}

const snapshot: PlanTaskSnapshot = {
  planName: "release",
  contentRevision: "a".repeat(64),
  format: "canonical",
  parents: [{ id: "1", title: "Build", state: "pending", children: [] }],
  totalParentCount: 1,
  totalTaskCount: 1,
  completedTaskCount: 0,
  complete: false,
};

async function harness(
  directory = "/project",
  planSnapshot: PlanTaskSnapshot = snapshot,
) {
  const value = catalog(new Map([["tapestry", projection("tapestry")]]));
  const controller = new OpenCode2CatalogController(0, {
    build: () => okAsync(value),
    reload: async () => undefined,
  });
  await controller.initialize();
  const storage = new MemoryStorage();
  const plans = new OpenCode2PlanSessionState(storage);
  await plans.set(
    selectionFromSnapshot("session", directory, "workspace", planSnapshot),
  );
  const reader: PlanTaskSnapshotReader = {
    readSnapshot: () => okAsync(planSnapshot),
  };
  const dependencies = {
    location: "/project",
    workspaceID: "workspace",
    session: {
      get: async () => ({
        location: { directory, workspaceID: "workspace" },
        agent: "tapestry",
      }),
    },
    catalog: controller,
    plans,
    ownsAgent: (agent: string) => agent === "tapestry",
    reader,
    registration: () => ({
      requestIntent: true,
      foregroundPlans: true,
      planDisplay: true,
    }),
  } as unknown as OpenCode2RpcDependencies;
  return { handlers: createOpenCode2RpcHandlers(dependencies), plans };
}

const context = {
  error: (type: string, message: string, data: unknown) => ({
    type,
    message,
    data,
  }),
};

describe("OpenCode 2 RPC handlers", () => {
  it("returns bounded readiness and echoes only the opaque scope token", async () => {
    const { handlers } = await harness();
    const output = await handlers.status(
      {
        sessionID: "session",
        directory: "/project",
        workspaceID: "workspace",
        scopeToken: "token",
      },
      context as never,
    );
    expect(output).toMatchObject({
      scope: { sessionID: "session", scopeToken: "token" },
      agentCount: 1,
      readiness: { durableWorkflows: false },
    });
    expect(JSON.stringify(output)).not.toContain("/project");
  });

  it("returns read-only plan progress from the injected reader", async () => {
    const { handlers } = await harness();
    const output = await handlers.plan(
      {
        sessionID: "session",
        directory: "/project",
        workspaceID: "workspace",
        scopeToken: "token",
      },
      context as never,
    );
    expect(output).toMatchObject({
      state: "ready",
      plan: { name: "release", completed: 0, total: 1, current: { id: "1" } },
    });
  });

  it("returns JSON-safe completed plans without undefined fields", async () => {
    const completed: PlanTaskSnapshot = {
      ...snapshot,
      parents: [{ id: "1", title: "Build", state: "completed", children: [] }],
      completedTaskCount: 1,
      complete: true,
    };
    const { handlers } = await harness("/project", completed);
    const output = await handlers.plan(
      {
        sessionID: "session",
        directory: "/project",
        workspaceID: "workspace",
        scopeToken: "token",
      },
      context as never,
    );
    expect(output).toMatchObject({
      state: "completed",
      plan: { completed: 1, total: 1 },
    });
    expect(JSON.stringify(output)).not.toContain("undefined");
    expect((output as { plan: object }).plan).not.toHaveProperty("current");
    expect((output as { plan: object }).plan).not.toHaveProperty("next");
  });

  it("rejects wrong-location sessions without returning controller state", async () => {
    const { handlers } = await harness("/other");
    const output = await handlers.status(
      {
        sessionID: "session",
        directory: "/other",
        workspaceID: "workspace",
        scopeToken: "token",
      },
      context as never,
    );
    expect(output).toMatchObject({
      type: "wrong_location",
      data: { code: "wrong_location" },
    });
  });
});
