import { describe, expect, it } from "bun:test";
import { err, ok, type ResultAsync } from "neverthrow";
import {
  beforeTool,
  previewToolPolicy,
} from "../execution-lifecycle/before-tool.js";
import type {
  LifecycleError,
  RegisteredBeforeToolInput,
  StaticToolPolicyPreviewInput,
} from "../execution-lifecycle/types.js";
import { PermissionRegistryBuilder } from "../permissions/registry.js";
import { InMemoryPermissionApprovalRepository } from "../permissions/repository.js";
import {
  activatePermissionSessionForTesting,
  PermissionSession,
  type PermissionSessionTestingOptions,
} from "../permissions/session.js";
import type {
  PermissionCallInput,
  PermissionError,
  PermissionRequest,
  PermissionResolver,
} from "../permissions/types.js";
import {
  createExecutionLeaseId,
  createWorkflowInstanceId,
} from "../runtime/types.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

const policy = (value: "allow" | "deny" | "ask"): EffectiveToolPolicy => ({
  read: value,
  write: value,
  execute: value,
  delegate: value,
  network: value,
});
const request: PermissionRequest = {
  unresolved: false,
  capability: "read",
  operation: "read",
  target: { kind: "file", identifier: "a" },
  display: { summary: "read a" },
};
const makeRegistry = (
  tool = "tool",
  resolver: PermissionResolver = () => ok([request]),
) => {
  const builder = new PermissionRegistryBuilder();
  builder.register({
    toolIdentity: tool,
    owner: "owner",
    revision: "1",
    summary: tool,
    resolver,
  });
  return builder.seal()._unsafeUnwrap();
};
const activate = async (
  value: "allow" | "deny" | "ask" = "allow",
  options: Partial<PermissionSessionTestingOptions> = {},
) => {
  const registry = options.registry ?? makeRegistry();
  const session = await activatePermissionSessionForTesting({
    project: "project",
    session: "controller",
    registry,
    policies: { agent: policy(value) },
    requestSchemaVersion: "1",
    monotonicClock: () => 1000,
    wallClock: () => 1000,
    ids: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    repository: new InMemoryPermissionApprovalRepository({}, () => 1000),
    ...options,
  });
  return { session: session._unsafeUnwrap(), registry };
};
type RegisteredWithLegacyFields = RegisteredBeforeToolInput & {
  effectiveToolPolicy?: EffectiveToolPolicy;
  toolCapability?: string;
};
const registered = (
  session: PermissionSession,
  registryGeneration: string,
  overrides: Partial<RegisteredBeforeToolInput> = {},
): RegisteredBeforeToolInput => ({
  workflowInstanceId: createWorkflowInstanceId("workflow"),
  leaseId: createExecutionLeaseId("lease"),
  agentName: "agent",
  toolName: "tool",
  permission: {
    session,
    project: "project",
    controllerSession: "controller",
    registryGeneration,
    call: { value: 1 },
    approvalUiAvailable: true,
  },
  ...overrides,
});
const result = async <T>(
  value: ResultAsync<T, LifecycleError | PermissionError>,
): Promise<T> => (await value)._unsafeUnwrap();
const errorType = async <T, E extends LifecycleError | PermissionError>(
  value: ResultAsync<T, E>,
): Promise<E["type"]> => (await value)._unsafeUnwrapErr().type;

describe("beforeTool registered permission overload", () => {
  it("keeps legacy policy decisions in the non-authoritative preview", async () => {
    const input: StaticToolPolicyPreviewInput = {
      workflowInstanceId: createWorkflowInstanceId("w"),
      leaseId: createExecutionLeaseId("l"),
      agentName: "a",
      toolName: "t",
      toolCapability: "read",
      effectiveToolPolicy: policy("allow"),
    };
    expect((await result(previewToolPolicy(input))).decision).toBe("allow");
    expect(
      (
        await result(
          previewToolPolicy({ ...input, effectiveToolPolicy: policy("deny") }),
        )
      ).decision,
    ).toBe("deny");
    expect(
      (
        await result(
          previewToolPolicy({ ...input, effectiveToolPolicy: policy("ask") }),
        )
      ).decision,
    ).toBe("ask");
  });

  it("uses the registered session policy and registry", async () => {
    const unmanaged = await activate();
    expect(
      await result(
        beforeTool(
          registered(unmanaged.session, unmanaged.registry.id, {
            toolName: "other",
          }),
        ),
      ),
    ).toEqual({ kind: "unmanaged" });
    for (const [value, expected] of [
      ["allow", "authorized"],
      ["deny", "denied"],
      ["ask", "approval_required"],
    ] as const) {
      const a = await activate(value);
      const outcome = await result(
        beforeTool(registered(a.session, a.registry.id)),
      );
      expect(outcome.kind).toBe(expected);
    }
  });

  it("propagates resolver and repository failures", async () => {
    const resolverRegistry = makeRegistry("tool", () =>
      err({ type: "invalid_output" as const }),
    );
    const r = await activate("allow", { registry: resolverRegistry });
    expect(
      await errorType(beforeTool(registered(r.session, r.registry.id))),
    ).toBe("resolver_returned_error");
    const repositoryRegistry = makeRegistry();
    const f = await activate("ask", {
      registry: repositoryRegistry,
      repository: new InMemoryPermissionApprovalRepository({ match: true }),
    });
    expect(
      await errorType(beforeTool(registered(f.session, f.registry.id))),
    ).toBe("repository_failure");
  });

  it("maps wrapper identity and preserves exact session errors", async () => {
    const a = await activate();
    expect(
      await errorType(
        beforeTool(
          registered(a.session, a.registry.id, { agentName: "wrong" }),
        ),
      ),
    ).toBe("unknown_agent");
    expect(
      await errorType(beforeTool(registered(a.session, "wrong-generation"))),
    ).toBe("stale_permission_state");
  });

  it("rejects extra legacy policy fields on registered input", async () => {
    const a = await activate("allow");
    const input: RegisteredWithLegacyFields = registered(
      a.session,
      a.registry.id,
    );
    input.effectiveToolPolicy = policy("allow");
    input.toolCapability = "read";
    expect(await errorType(beforeTool(input))).toBe("validation");
  });

  it("rejects a legacy-shaped input instead of bypassing the session", async () => {
    const a = await activate("allow");
    const legacy = registered(a.session, a.registry.id);
    Object.defineProperty(legacy, "permission", { value: undefined });
    Object.defineProperty(legacy, "toolCapability", {
      enumerable: true,
      value: "read",
    });
    Object.defineProperty(legacy, "effectiveToolPolicy", {
      enumerable: true,
      value: policy("allow"),
    });
    expect(await errorType(beforeTool(legacy))).toBe("validation");
  });

  it("rejects accessors instead of reading them during validation", async () => {
    const a = await activate("allow");
    const input = registered(a.session, a.registry.id);
    Object.defineProperty(input, "permission", {
      configurable: true,
      enumerable: true,
      get: () => registered(a.session, a.registry.id).permission,
    });
    expect(await errorType(beforeTool(input))).toBe("validation");
  });

  it("rejects a proxy that hides permission instead of taking the preview path", async () => {
    const a = await activate("allow");
    const input = registered(a.session, a.registry.id);
    const hidden = new Proxy(input, {
      ownKeys: () => ["workflowInstanceId", "leaseId", "agentName", "toolName"],
    });
    expect(await errorType(beforeTool(hidden))).toBe("validation");
  });

  it("rejects hostile strings and callable or tagged lifecycle inputs", async () => {
    const a = await activate("allow");
    const boxed = registered(a.session, a.registry.id);
    Object.defineProperty(boxed, "agentName", {
      value: Reflect.construct(String, ["agent"]),
    });
    expect(await errorType(beforeTool(boxed))).toBe("validation");

    const callable = Object.assign(
      () => null,
      registered(a.session, a.registry.id),
    );
    expect(await errorType(beforeTool(callable))).toBe("validation");

    let tagReads = 0;
    const tagged = registered(a.session, a.registry.id);
    Object.defineProperty(tagged, Symbol.toStringTag, {
      configurable: true,
      get: () => {
        tagReads += 1;
        return "String";
      },
    });
    expect(await errorType(beforeTool(tagged))).toBe("validation");
    expect(tagReads).toBe(0);

    const spoofedValue = {};
    Object.defineProperty(spoofedValue, Symbol.toStringTag, {
      configurable: true,
      get: () => {
        tagReads += 1;
        return "String";
      },
    });
    const spoofed = registered(a.session, a.registry.id);
    Object.defineProperty(spoofed, "agentName", {
      value: spoofedValue,
    });
    expect(await errorType(beforeTool(spoofed))).toBe("validation");
    expect(tagReads).toBe(0);

    const hostile = new Proxy(registered(a.session, a.registry.id), {
      ownKeys: () => {
        throw new Error("ownKeys trap");
      },
    });
    const settled = await Promise.allSettled([beforeTool(hostile)]);
    expect(settled[0]?.status).toBe("fulfilled");
    if (settled[0]?.status !== "fulfilled") return;
    expect(settled[0].value.isErr()).toBe(true);
    expect(settled[0].value._unsafeUnwrapErr().type).toBe("validation");
  });

  it("validates lifecycle context before calling the session", async () => {
    const a = await activate();
    const calls: string[] = [];
    const session = Object.create(a.session);
    const call: PermissionCallInput = {
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "tool",
      registryGeneration: a.registry.id,
      call: {},
      approvalUiAvailable: true,
    };
    Object.defineProperty(session, "authorizeCall", {
      value: () => {
        calls.push("called");
        return a.session.authorizeCall(call);
      },
    });
    const omittedPermission = registered(session, a.registry.id);
    Object.defineProperty(omittedPermission, "permission", {
      value: null,
    });
    const missing = [
      registered(session, a.registry.id, {
        workflowInstanceId: createWorkflowInstanceId(""),
      }),
      registered(session, a.registry.id, {
        leaseId: createExecutionLeaseId(""),
      }),
      omittedPermission,
      registered(session, a.registry.id, { permission: undefined }),
    ];
    for (const input of missing)
      expect(await errorType(beforeTool(input))).toBe("validation");
    expect(calls).toEqual([]);
  });

  it("rejects forged, proxied, and copied-method sessions with typed errors", async () => {
    const a = await activate();
    const call: PermissionCallInput = {
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "tool",
      registryGeneration: a.registry.id,
      call: {},
      approvalUiAvailable: true,
    };
    const forged = Object.create(a.session);
    const proxied = new Proxy(a.session, {});
    const copied = a.session.authorizeCall;
    for (const value of [forged, proxied]) {
      const result = await copied.call(value, call);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
    }
    const forgedInput = {
      ...registered(a.session, a.registry.id),
      permission: {
        ...registered(a.session, a.registry.id).permission,
        session: forged,
      },
    };
    expect(await errorType(beforeTool(forgedInput))).toBe("validation");
  });

  it("clones the raw call before issuing a permit", async () => {
    const a = await activate();
    const call = { nested: { value: 1 } };
    const input = registered(a.session, a.registry.id, {
      permission: { ...registered(a.session, a.registry.id).permission, call },
    });
    const outcome = await result(beforeTool(input));
    expect(outcome.kind).toBe("authorized");
    if (outcome.kind !== "authorized") return;
    call.nested.value = 99;
    const consumed = await a.session.consumePermit({
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "tool",
      registryGeneration: a.registry.id,
      permit: outcome.permit,
      call: { nested: { value: 1 } },
    });
    expect(consumed.isOk()).toBe(true);
  });

  it("authorizes through a non-virtual path immune to genuine-session method shadowing", async () => {
    const denied = await activate("deny");
    expect(Object.isFrozen(denied.session)).toBe(true);

    let hijacked = 0;
    // Genuine frozen instance: defineProperty/assignment cannot install a shadow.
    expect(() => {
      Object.defineProperty(denied.session, "authorizeCall", {
        value: () => {
          hijacked += 1;
          return ok({ kind: "authorized", permit: "forged" });
        },
        configurable: true,
      });
    }).toThrow();
    expect(() => {
      denied.session.authorizeCall = (input) => {
        hijacked += 1;
        return denied.session.authorizeCall(input);
      };
    }).toThrow();

    // Prototype freeze blocks class-wide hijack attempts.
    expect(() => {
      PermissionSession.prototype.authorizeCall = (input) => {
        hijacked += 1;
        return denied.session.authorizeCall(input);
      };
    }).toThrow();

    const outcome = await result(
      beforeTool(registered(denied.session, denied.registry.id)),
    );
    expect(outcome.kind).toBe("denied");
    expect(hijacked).toBe(0);

    // Allow path still works and issues a genuine single-use permit.
    const allowed = await activate("allow");
    const authorized = await result(
      beforeTool(registered(allowed.session, allowed.registry.id)),
    );
    expect(authorized.kind).toBe("authorized");
    if (authorized.kind !== "authorized") return;
    expect(
      (
        await allowed.session.consumePermit({
          project: "project",
          session: "controller",
          agentName: "agent",
          toolIdentity: "tool",
          registryGeneration: allowed.registry.id,
          permit: authorized.permit,
          call: { value: 1 },
        })
      ).isOk(),
    ).toBe(true);
    expect(
      await errorType(
        allowed.session.consumePermit({
          project: "project",
          session: "controller",
          agentName: "agent",
          toolIdentity: "tool",
          registryGeneration: allowed.registry.id,
          permit: authorized.permit,
          call: { value: 1 },
        }),
      ),
    ).toBe("consumed_permit");
    expect(hijacked).toBe(0);
  });
});
