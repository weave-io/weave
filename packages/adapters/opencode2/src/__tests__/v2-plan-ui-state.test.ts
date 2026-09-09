import { describe, expect, it } from "bun:test";
import {
  PlanUiController,
  type PlanUiRpcResponse,
  type PlanUiState,
  taskDialogOptions,
} from "../v2/plan-ui-state.js";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
    reject: (error: unknown) => reject?.(error),
  };
}

describe("PlanUiController", () => {
  it("discards responses for an old session", async () => {
    const published: PlanUiState[] = [];
    const first = deferred<PlanUiRpcResponse>();
    const second = deferred<PlanUiRpcResponse>();
    const controller = new PlanUiController({
      supported: true,
      getSession: (sessionID) => ({ sessionID, directory: `/${sessionID}` }),
      syncSession: async () => undefined,
      fetchPlan: (scope) =>
        scope.sessionID === "one" ? first.promise : second.promise,
      publish: (state) => published.push(state),
    });
    const firstLoad = controller.load("one");
    const secondLoad = controller.load("two");
    first.resolve({
      scope: { sessionID: "one", scopeToken: "1" },
      state: "no_plan",
    });
    second.resolve({
      scope: { sessionID: "two", scopeToken: "2" },
      state: "no_plan",
    });
    await Promise.all([firstLoad, secondLoad]);
    expect(published.at(-1)).toEqual({
      type: "no_plan",
      scope: { sessionID: "two", directory: "/two" },
      refreshFailed: false,
    });
  });

  it("preserves a visible failed-refresh signal with the last valid plan", async () => {
    const published: PlanUiState[] = [];
    const controller = new PlanUiController({
      supported: true,
      getSession: (sessionID) => ({ sessionID, directory: "/project" }),
      syncSession: async () => undefined,
      fetchPlan: async (_scope, scopeToken) => ({
        scope: { sessionID: "session", scopeToken },
        state: "ready",
        refreshFailed: true,
        plan: {
          name: "release",
          revision: "a".repeat(64),
          completed: 0,
          total: 1,
          tasks: [],
        },
      }),
      publish: (state) => published.push(state),
    });
    await controller.load("session");
    expect(published.at(-1)).toMatchObject({
      type: "ready",
      refreshFailed: true,
    });
  });

  it("distinguishes unavailable RPC failures from disconnected transport", async () => {
    const published: PlanUiState[] = [];
    let failure: unknown = { type: "plan_unavailable", message: "missing" };
    const controller = new PlanUiController({
      supported: true,
      getSession: (sessionID) => ({ sessionID, directory: "/project" }),
      syncSession: async () => undefined,
      fetchPlan: async () => {
        throw failure;
      },
      publish: (state) => published.push(state),
    });
    await controller.load("session");
    expect(published.at(-1)?.type).toBe("unavailable");
    failure = new Error("network down");
    await controller.load("session");
    expect(published.at(-1)?.type).toBe("disconnected");
  });

  it("publishes an explicit unsupported-host state", () => {
    const published: PlanUiState[] = [];
    const controller = new PlanUiController({
      supported: false,
      getSession: () => undefined,
      syncSession: async () => undefined,
      fetchPlan: async () => {
        throw new Error("not called");
      },
      publish: (state) => published.push(state),
    });
    void controller.load("session");
    expect(published).toEqual([{ type: "unsupported_host" }]);
  });
});

describe("taskDialogOptions", () => {
  it("renders current, completed, child, and pending markers read-only", () => {
    const options = taskDialogOptions({
      name: "release",
      revision: "a".repeat(64),
      completed: 1,
      total: 3,
      current: { id: "2", title: "Current", state: "in_progress", depth: 0 },
      tasks: [
        { id: "1", title: "Done", state: "completed", depth: 0 },
        { id: "2", title: "Current", state: "in_progress", depth: 0 },
        { id: "2.a", title: "Next", state: "pending", depth: 1 },
      ],
    });
    expect(options.map((option) => option.title)).toEqual([
      "[x] 1. Done",
      "[>] 2. Current",
      "  [ ] 2.a. Next",
    ]);
  });
});
