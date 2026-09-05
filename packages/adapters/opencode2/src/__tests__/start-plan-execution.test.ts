import { describe, expect, it } from "bun:test";

import { startPlanExecution } from "../start-plan-execution.js";
import { MockPluginContext } from "./mock-plugin-context.js";

describe("startPlanExecution", () => {
  it("calls facade.session.prompt with the loom-activation payload and default delivery", async () => {
    const facade = new MockPluginContext();

    const result = await startPlanExecution(facade, {
      sessionID: "session-1",
      planName: "feature-auth",
    });

    expect(result.isOk()).toBe(true);

    const promptCalls = facade.calls.filter(
      (c) => c.method === "session.prompt",
    );
    expect(promptCalls).toHaveLength(1);
    const [input] = promptCalls[0]?.args ?? [];
    const promptInput = input as {
      sessionID: string;
      text: string;
      delivery: string;
    };
    expect(promptInput.sessionID).toBe("session-1");
    expect(promptInput.delivery).toBe("queue");
    expect(promptInput.text).toContain("feature-auth");
    expect(promptInput.text).toContain("weave-plan-activation");
  });

  it("honours an explicit delivery mode override", async () => {
    const facade = new MockPluginContext();

    await startPlanExecution(facade, {
      sessionID: "session-2",
      planName: "hotfix",
      delivery: "steer",
    });

    const [input] =
      facade.calls.find((c) => c.method === "session.prompt")?.args ?? [];
    expect((input as { delivery: string }).delivery).toBe("steer");
  });

  it("maps a rejected session.prompt call to a SessionOperationError", async () => {
    const facade = new MockPluginContext();
    (facade as { session: { prompt: unknown } }).session.prompt = async () => {
      throw new Error("network down");
    };

    const result = await startPlanExecution(facade, {
      sessionID: "session-3",
      planName: "feature-auth",
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("SessionOperationError");
    if (error.type === "SessionOperationError") {
      expect(error.operation).toBe("prompt");
      expect(error.sessionId).toBe("session-3");
    }
  });
});
