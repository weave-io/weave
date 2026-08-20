/**
 * Adversarial tests for the OpenCode SDK boundary.
 *
 * These tests keep raw SDK resources at the adapter boundary. They prove that
 * projection is strict, bounded, accessor-safe, and that provider payloads do
 * not cross the typed client error boundary.
 */

import { describe, expect, it } from "bun:test";
import type { OpenCodeExternalValue } from "../opencode-client.js";
import {
  MAX_OPEN_CODE_AGENT_DESCRIPTION_LENGTH,
  MAX_OPEN_CODE_AGENT_NAME_LENGTH,
  MAX_OPEN_CODE_AGENT_SUMMARIES,
  projectOpenCodeAgentSummaries,
  projectOpenCodeAgentSummary,
  SdkOpenCodeClient,
} from "../opencode-client.js";
import { createOpencodeClient } from "../sdk-types.js";

const SDK_SENTINEL = "sdk-secret-sentinel-7f5b";

function makeSdkClient(
  body: OpenCodeExternalValue,
  status = 200,
): SdkOpenCodeClient {
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    directory: "/tmp/opencode-client-test",
    fetch: async (_request: Request) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
  return new SdkOpenCodeClient(client);
}

function makeThrowingSdkClient(): SdkOpenCodeClient {
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    directory: "/tmp/opencode-client-test",
    fetch: async (_request: Request) => {
      throw new Error(SDK_SENTINEL);
    },
  });
  return new SdkOpenCodeClient(client);
}

describe("projectOpenCodeAgentSummary", () => {
  it("projects a resource with a description", () => {
    const result = projectOpenCodeAgentSummary({
      name: "loom",
      description: "Orchestrates work",
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        name: "loom",
        description: "Orchestrates work",
      });
    }
  });

  it("projects a resource with the description omitted", () => {
    const result = projectOpenCodeAgentSummary({ name: "loom" });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ name: "loom" });
  });

  it("projects the durable identity and does not retain the raw options object", () => {
    const raw = {
      name: "loom",
      options: {
        weave: { kind: "weave-agent", version: 1, agentName: "loom" },
        providerDetail: SDK_SENTINEL,
      },
    };
    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.weaveIdentity).toEqual({
        kind: "weave-agent",
        version: 1,
        agentName: "loom",
      });
      expect(JSON.stringify(result.value)).not.toContain(SDK_SENTINEL);
    }
  });

  it("rejects missing, oversized, and malformed scalar fields", () => {
    const missingName = projectOpenCodeAgentSummary({ description: "x" });
    const oversizedName = projectOpenCodeAgentSummary({
      name: "n".repeat(MAX_OPEN_CODE_AGENT_NAME_LENGTH + 1),
    });
    const oversizedDescription = projectOpenCodeAgentSummary({
      name: "loom",
      description: "d".repeat(MAX_OPEN_CODE_AGENT_DESCRIPTION_LENGTH + 1),
    });
    const malformedDescription = projectOpenCodeAgentSummary({
      name: "loom",
      description: { hostile: true },
    });

    expect(missingName.isErr()).toBe(true);
    expect(oversizedName.isErr()).toBe(true);
    expect(oversizedDescription.isErr()).toBe(true);
    expect(malformedDescription.isErr()).toBe(true);
  });

  it("rejects accessor-backed resources without invoking the accessor", () => {
    let accessed = false;
    const raw = { name: "loom" };
    Object.defineProperty(raw, "description", {
      get: () => {
        accessed = true;
        return SDK_SENTINEL;
      },
      enumerable: true,
    });

    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isErr()).toBe(true);
    expect(accessed).toBe(false);
  });

  it("rejects nested accessors without invoking them", () => {
    let accessed = false;
    const options = {};
    Object.defineProperty(options, "weave", {
      get: () => {
        accessed = true;
        return { kind: "weave-agent", version: 1, agentName: "loom" };
      },
      enumerable: true,
    });

    const result = projectOpenCodeAgentSummary({ name: "loom", options });

    expect(result.isErr()).toBe(true);
    expect(accessed).toBe(false);
  });

  it("rejects resources with a foreign prototype", () => {
    const raw = Object.assign(Object.create({ hostile: true }), {
      name: "loom",
    });

    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isErr()).toBe(true);
  });

  it("rejects an active proxy without invoking its get trap", () => {
    let getCount = 0;
    const raw = new Proxy(
      { name: "loom" },
      {
        get() {
          getCount += 1;
          throw new Error(SDK_SENTINEL);
        },
      },
    );

    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isErr()).toBe(true);
    expect(getCount).toBe(0);
  });

  it("rejects a revoked proxy without throwing", () => {
    const revocable = Proxy.revocable({ name: "loom" }, {});
    revocable.revoke();

    const result = projectOpenCodeAgentSummary(revocable.proxy);

    expect(result.isErr()).toBe(true);
  });

  it("rejects own-key churn at the projection boundary", () => {
    let ownKeysCalls = 0;
    const raw = new Proxy(
      { name: "loom" },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return ownKeysCalls === 1
            ? Reflect.ownKeys(target)
            : [...Reflect.ownKeys(target), "description"];
        },
      },
    );

    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isErr()).toBe(true);
    expect(ownKeysCalls).toBeGreaterThan(0);
  });

  it("rejects descriptor churn without invoking a descriptor getter", () => {
    let descriptorCalls = 0;
    let getterExecuted = false;
    const raw = new Proxy(
      { name: "loom" },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorCalls += 1;
          if (key === "name") {
            return {
              get: () => {
                getterExecuted = true;
                return "loom";
              },
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    const result = projectOpenCodeAgentSummary(raw);

    expect(result.isErr()).toBe(true);
    expect(descriptorCalls).toBeGreaterThan(0);
    expect(getterExecuted).toBe(false);
  });

  it("rejects malformed, omitted-name, and mismatched durable identities", () => {
    const omitted = projectOpenCodeAgentSummary({
      name: "loom",
      options: { weave: undefined },
    });
    const malformed = projectOpenCodeAgentSummary({
      name: "loom",
      options: { weave: { kind: "foreign", version: 1, agentName: "loom" } },
    });
    const mismatched = projectOpenCodeAgentSummary({
      name: "loom",
      options: {
        weave: { kind: "weave-agent", version: 1, agentName: "other" },
      },
    });

    expect(omitted.isOk()).toBe(true);
    if (omitted.isOk()) expect(omitted.value.weaveIdentity).toBeUndefined();
    expect(malformed.isErr()).toBe(true);
    expect(mismatched.isErr()).toBe(true);
  });
});

describe("projectOpenCodeAgentSummaries", () => {
  it("rejects an oversized list and sparse list", () => {
    const oversized = projectOpenCodeAgentSummaries(
      Array.from({ length: MAX_OPEN_CODE_AGENT_SUMMARIES + 1 }, () => ({
        name: "loom",
      })),
    );
    const sparse: OpenCodeExternalValue[] = [null];
    sparse.pop();
    sparse.length = 1;

    expect(oversized.isErr()).toBe(true);
    expect(projectOpenCodeAgentSummaries(sparse).isErr()).toBe(true);
  });
});

describe("SdkOpenCodeClient projection and diagnostics", () => {
  it("maps a malformed SDK list resource to bounded invalid-response diagnostics", async () => {
    const result = await makeSdkClient([
      { name: "n".repeat(129) },
    ]).listAgents();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe("invalid-response");
      expect(JSON.stringify(result.error)).not.toContain(SDK_SENTINEL);
    }
  });

  it("discards the SDK error payload for listAgents", async () => {
    const result = await makeSdkClient(
      { message: SDK_SENTINEL },
      500,
    ).listAgents();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe("sdk-error");
      expect(result.error.message).toBe(
        "OpenCode list-agents failed (sdk-error)",
      );
      expect(JSON.stringify(result.error)).not.toContain(SDK_SENTINEL);
    }
  });

  it("discards the SDK error payload for createAgent", async () => {
    const result = await makeSdkClient(
      { error: SDK_SENTINEL },
      500,
    ).createAgent("loom", { mode: "subagent" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe("sdk-error");
      expect(result.error.message).toBe(
        "OpenCode create-agent failed (sdk-error)",
      );
      expect(JSON.stringify(result.error)).not.toContain(SDK_SENTINEL);
    }
  });

  it("discards the SDK error payload for updateAgent", async () => {
    const result = await makeSdkClient(
      { error: SDK_SENTINEL },
      500,
    ).updateAgent("loom", { mode: "subagent" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe("sdk-error");
      expect(result.error.message).toBe(
        "OpenCode update-agent failed (sdk-error)",
      );
      expect(JSON.stringify(result.error)).not.toContain(SDK_SENTINEL);
    }
  });

  it("maps thrown SDK causes to request-failed without retaining the cause", async () => {
    const result = await makeThrowingSdkClient().listAgents();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe("request-failed");
      expect(JSON.stringify(result.error)).not.toContain(SDK_SENTINEL);
    }
  });
});
