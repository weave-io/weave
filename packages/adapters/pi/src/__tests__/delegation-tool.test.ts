import { describe, expect, it } from "bun:test";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "../delegation-controller.js";
import {
  buildDelegationToolRegistration,
  type PiDelegationToolDeps,
  WEAVE_DELEGATION_TOOL_NAME,
  WEAVE_DELEGATION_TOOL_OWNER,
} from "../delegation-tool.js";
import type { PiAdapterFailure } from "../errors.js";
import type { PiChildSettlement } from "../rpc-child.js";
import type { PiSessionContext } from "../types.js";

const TARGETS: readonly DelegationTarget[] = [
  {
    name: "shuttle",
    description: "General specialist",
    triggers: [],
    isCategory: false,
  },
  {
    name: "shuttle-backend",
    description: "Backend specialist",
    triggers: [],
    isCategory: true,
  },
];

function fakeController(
  delegate: (
    request: PiDelegationRequest,
  ) => ResultAsync<PiChildSettlement, PiAdapterFailure>,
): PiDelegationController {
  return { delegate } as unknown as PiDelegationController;
}

function baseDeps(
  overrides: Partial<PiDelegationToolDeps> = {},
): PiDelegationToolDeps {
  let counter = 0;
  return {
    targets: TARGETS,
    getController: () => undefined,
    parentId: "root",
    parentDepth: 0,
    parentAgentName: "loom",
    idGenerator: { next: () => `child-${++counter}` },
    buildBootstrap: () => ({}),
    buildEnv: () => ({}),
    ...overrides,
  };
}

function ctx(): PiSessionContext {
  return {
    mode: "tui",
    cwd: "/project",
    isProjectTrusted: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  };
}

describe("buildDelegationToolRegistration", () => {
  it("exposes the fixed tool identity and restricts the schema enum to the supplied targets", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    expect(registration.tool.name).toBe(WEAVE_DELEGATION_TOOL_NAME);
    expect(registration.owner).toBe(WEAVE_DELEGATION_TOOL_OWNER);
    const parameters = registration.tool.parameters as {
      properties: { agent: { enum: string[] } };
    };
    expect(parameters.properties.agent.enum.sort()).toEqual([
      "shuttle",
      "shuttle-backend",
    ]);
  });

  it("resolver: hard-rejects (never asks) an agent outside the eligible target set", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    const result = registration.resolver({
      call: { agent: "not-a-real-target", task: "do it" },
      context: { toolIdentity: "weave_delegate", owner: "x", revision: "1" },
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("unsafe_input");
  });

  it("resolver: an unresolved/malformed call shape forces an ask rather than a reusable grant", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    const result = registration.resolver({
      call: { agent: 123 },
      context: { toolIdentity: "weave_delegate", owner: "x", revision: "1" },
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
      {
        unresolved: true,
        display: { summary: "Delegate to an eligible agent" },
      },
    ]);
  });

  it("resolver: a valid eligible target produces exactly one grantable delegate request", () => {
    const registration = buildDelegationToolRegistration(baseDeps());
    const result = registration.resolver({
      call: { agent: "shuttle", task: "x".repeat(300) },
      context: { toolIdentity: "weave_delegate", owner: "x", revision: "1" },
    });
    const requests = result._unsafeUnwrap();
    expect(requests.length).toBe(1);
    const [request] = requests;
    expect(request.unresolved).toBe(false);
    if (!request.unresolved) {
      expect(request.capability).toBe("delegate");
      expect(request.target).toEqual({
        kind: "weave-agent",
        identifier: "shuttle",
      });
      // Details are a bounded preview, never the full raw task text.
      expect(request.display.details?.length).toBeLessThan(300);
    }
  });

  it("execute: rejects an ineligible agent with a structured (not thrown) error, never touching the controller", async () => {
    let called = false;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() => {
            called = true;
            return okAsync({ outcome: "completed", summary: "x" });
          }),
      }),
    );
    const result = await registration.tool.execute(
      "call-1",
      { agent: "nope", task: "x" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({ ok: false, error: "invalid-delegation-target" });
    expect(called).toBe(false);
  });

  it("execute: fails closed when the delegation transport is not yet available", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({ getController: () => undefined }),
    );
    const result = await registration.tool.execute(
      "call-1",
      { agent: "shuttle", task: "x" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: false,
      error: "delegation-transport-unavailable",
    });
  });

  it("execute: delegates to the controller and returns its structured settlement, without creating workflow state", async () => {
    let capturedRequest: PiDelegationRequest | undefined;
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController((request) => {
            capturedRequest = request;
            return okAsync({
              outcome: "completed",
              summary: "done",
            } as PiChildSettlement);
          }),
      }),
    );
    const result = await registration.tool.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({
      ok: true,
      settlement: { outcome: "completed", summary: "done" },
    });
    expect(capturedRequest?.agentName).toBe("shuttle");
    expect(capturedRequest?.parentId).toBe("root");
    expect(capturedRequest?.cwd).toBe("/project");
  });

  it("execute: surfaces a controller failure as a structured error code, never throwing", async () => {
    const registration = buildDelegationToolRegistration(
      baseDeps({
        getController: () =>
          fakeController(() =>
            errAsync({
              code: "ChildCapacityExceeded",
              phase: "child",
              scope: { kind: "child", id: "child-1" },
              impact: "operation-stopped",
              retryable: true,
              recovery: "retry",
              safeMessage: "no capacity",
            } as PiAdapterFailure),
          ),
      }),
    );
    const result = await registration.tool.execute(
      "call-1",
      { agent: "shuttle", task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    const text = JSON.parse((result.content[0] as { text: string }).text);
    expect(text).toEqual({ ok: false, error: "ChildCapacityExceeded" });
  });
});
