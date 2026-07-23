/**
 * Spec 34 task 3 — harness-neutral permission coverage proof.
 *
 * Uses an in-memory fake adapter only. No live harness, child process,
 * network, or concrete Pi/OpenCode interception paths.
 */

import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import {
  createPermissionService,
  type PermissionCoverageContext,
  type PermissionCoverageProof,
  PermissionRegistryBuilder,
  type PermissionRegistryGeneration,
  type PermissionRequest,
  type PermissionSession,
  verifyPermissionCoverage,
} from "../index.js";
import { createInMemoryRuntimeStore } from "../runtime/memory-store.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

const allowPolicy = (): EffectiveToolPolicy => ({
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "allow",
});

const grantable = (
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest =>
  ({
    unresolved: false,
    capability: "read",
    operation: "read",
    target: { kind: "file", identifier: "a.txt" },
    display: { summary: "read a.txt" },
    ...overrides,
  }) as PermissionRequest;

const register = (
  builder: PermissionRegistryBuilder,
  toolIdentity: string,
  owner = "native",
) => {
  const result = builder.register({
    toolIdentity,
    owner,
    revision: "1",
    summary: `${toolIdentity} tool`,
    resolver: () => ok([grantable()]),
  });
  expect(result.isOk()).toBe(true);
};

const seal = (
  tools: readonly { identity: string; owner?: string }[],
): PermissionRegistryGeneration => {
  const builder = new PermissionRegistryBuilder();
  for (const tool of tools)
    register(builder, tool.identity, tool.owner ?? "native");
  return builder.seal()._unsafeUnwrap();
};

const context = (
  registry: PermissionRegistryGeneration,
  overrides: Partial<PermissionCoverageContext> = {},
): PermissionCoverageContext => {
  const registered = registry.inventory().map((entry) => entry.toolIdentity);
  return {
    registry,
    nativeToolIdentities: registered.filter((id) => id.startsWith("native.")),
    weaveOwnedToolIdentities: registered.filter((id) =>
      id.startsWith("weave."),
    ),
    interceptedToolIdentities: [...registered],
    bypassableToolIdentities: [],
    unmanagedThirdPartyToolIdentities: [],
    diagnostics: { includeToolIdentities: false },
    ...overrides,
  };
};

/**
 * Recording fake adapter: owns discovery/interception bookkeeping and routes
 * managed calls through PermissionService + permit consumption. No harness.
 */
class FakePermissionAdapter {
  readonly executions: Array<{ toolIdentity: string; call: unknown }> = [];
  readonly intercepted = new Set<string>();
  readonly bypassable = new Set<string>();
  unmanagedThirdParty: string[] = [];
  nativeTools: string[] = [];
  weaveTools: string[] = [];
  #registry: PermissionRegistryGeneration | undefined;
  #session: PermissionSession | undefined;

  discover(input: {
    native: readonly string[];
    weave: readonly string[];
    unmanaged?: readonly string[];
  }): void {
    this.nativeTools = [...input.native];
    this.weaveTools = [...input.weave];
    this.unmanagedThirdParty = [...(input.unmanaged ?? [])];
  }

  sealRegistry(
    thirdParty: readonly string[] = [],
  ): PermissionRegistryGeneration {
    const builder = new PermissionRegistryBuilder();
    for (const identity of this.nativeTools)
      register(builder, identity, "native");
    for (const identity of this.weaveTools)
      register(builder, identity, "weave");
    for (const identity of thirdParty)
      register(builder, identity, "third-party");
    this.#registry = builder.seal()._unsafeUnwrap();
    for (const entry of this.#registry.inventory())
      this.intercepted.add(entry.toolIdentity);
    return this.#registry;
  }

  markBypassable(toolIdentity: string): void {
    this.bypassable.add(toolIdentity);
  }

  dropInterception(toolIdentity: string): void {
    this.intercepted.delete(toolIdentity);
  }

  proveCoverage(includeToolIdentities = false) {
    if (!this.#registry) throw new Error("registry missing");
    return verifyPermissionCoverage({
      registry: this.#registry,
      nativeToolIdentities: [...this.nativeTools],
      weaveOwnedToolIdentities: [...this.weaveTools],
      interceptedToolIdentities: [...this.intercepted],
      bypassableToolIdentities: [...this.bypassable],
      unmanagedThirdPartyToolIdentities: [...this.unmanagedThirdParty],
      diagnostics: { includeToolIdentities },
    });
  }

  async activate(): Promise<void> {
    if (!this.#registry) throw new Error("registry missing");
    const store = createInMemoryRuntimeStore();
    const service = createPermissionService(store);
    const session = await service.activate({
      project: "project",
      controllerSession: "controller",
      registry: this.#registry,
      policies: { agent: allowPolicy() },
      requestSchemaVersion: "1",
    });
    this.#session = session._unsafeUnwrap();
  }

  async invoke(
    toolIdentity: string,
    call: unknown,
  ): Promise<"executed" | "unmanaged" | "blocked"> {
    if (!this.#session || !this.#registry) throw new Error("not activated");
    if (!this.intercepted.has(toolIdentity)) {
      if (this.unmanagedThirdParty.includes(toolIdentity)) return "unmanaged";
      return "blocked";
    }
    const outcome = await this.#session.authorizeCall({
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity,
      registryGeneration: this.#registry.id,
      call,
      approvalUiAvailable: false,
    });
    if (outcome.isErr()) return "blocked";
    if (outcome.value.kind === "unmanaged") return "unmanaged";
    if (outcome.value.kind !== "authorized") return "blocked";
    const permit = outcome.value.permit;
    const consumed = await this.#session.consumePermit({
      permit,
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity,
      registryGeneration: this.#registry.id,
      call,
    });
    if (consumed.isErr()) return "blocked";
    // Execute ONLY the frozen snapshot returned by consume — never caller call.
    this.executions.push({ toolIdentity, call: consumed.value });
    return "executed";
  }

  async replayPermit(
    toolIdentity: string,
    call: unknown,
    permit: string,
  ): Promise<boolean> {
    if (!this.#session || !this.#registry) throw new Error("not activated");
    const consumed = await this.#session.consumePermit({
      permit,
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity,
      registryGeneration: this.#registry.id,
      call,
    });
    if (consumed.isOk()) {
      this.executions.push({ toolIdentity, call: consumed.value });
      return true;
    }
    return false;
  }

  get registry(): PermissionRegistryGeneration {
    if (!this.#registry) throw new Error("registry missing");
    return this.#registry;
  }

  get session(): PermissionSession {
    if (!this.#session) throw new Error("session missing");
    return this.#session;
  }
}

describe("verifyPermissionCoverage", () => {
  it("accepts complete native and weave-owned coverage", () => {
    const registry = seal([
      { identity: "native.read" },
      { identity: "weave.delegate", owner: "weave" },
    ]);
    const proof = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: ["weave.delegate"],
        interceptedToolIdentities: ["native.read", "weave.delegate"],
        unmanagedThirdPartyToolIdentities: ["third.plugin"],
        diagnostics: { includeToolIdentities: true },
      }),
    );
    expect(proof.isOk()).toBe(true);
    const value = proof._unsafeUnwrap() as PermissionCoverageProof;
    expect(value.generationId).toBe(registry.id);
    expect(value.metadataIdentity).toBe(registry.identity);
    expect(value.requiredCount).toBe(2);
    expect(value.registeredCount).toBe(2);
    expect(value.interceptedCount).toBe(2);
    expect(value.unmanagedCount).toBe(1);
    expect(value.requiredToolIdentities).toEqual([
      "native.read",
      "weave.delegate",
    ]);
    expect(value.registeredToolIdentities).toEqual([
      "native.read",
      "weave.delegate",
    ]);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("omits tool-identity lists unless diagnostics policy permits", () => {
    const registry = seal([{ identity: "native.read" }]);
    const proof = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
    )._unsafeUnwrap();
    expect(proof.requiredToolIdentities).toBeUndefined();
    expect(proof.registeredToolIdentities).toBeUndefined();
    expect(proof.interceptedToolIdentities).toBeUndefined();
    expect(proof.unmanagedToolIdentities).toBeUndefined();
    expect(Reflect.ownKeys(proof)).not.toContain("requiredToolIdentities");
  });

  it("fails when a required native or weave tool lacks registration", () => {
    const registry = seal([{ identity: "native.read" }]);
    const missingNative = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read", "native.write"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(missingNative.isErr()).toBe(true);
    expect(missingNative._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_registration",
      toolIdentity: "native.write",
    });

    const missingWeave = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: ["weave.tool"],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(missingWeave._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_registration",
      toolIdentity: "weave.tool",
    });
  });

  it("fails when a registered tool lacks interception or is bypassable", () => {
    const registry = seal([
      { identity: "native.read" },
      { identity: "third.plugin", owner: "ext" },
    ]);
    const missing = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(missing._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_interception",
      toolIdentity: "third.plugin",
    });

    const bypass = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read", "third.plugin"],
        bypassableToolIdentities: ["native.read"],
      }),
    );
    expect(bypass._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "bypassable_call",
      toolIdentity: "native.read",
    });
  });

  it("rejects inventory overlap, duplicates, and invalid plain shape", () => {
    const registry = seal([{ identity: "native.read" }]);
    const overlap = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: ["native.read"],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(overlap._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "overlap_ambiguity",
      toolIdentity: "native.read",
    });

    const registeredUnmanaged = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
        unmanagedThirdPartyToolIdentities: ["native.read"],
      }),
    );
    expect(registeredUnmanaged._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "overlap_ambiguity",
    });

    const duplicate = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read", "native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(duplicate._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "duplicate_identity",
      toolIdentity: "native.read",
    });

    const withGetter = {
      registry,
      nativeToolIdentities: ["native.read"],
      weaveOwnedToolIdentities: [],
      interceptedToolIdentities: ["native.read"],
      bypassableToolIdentities: [],
      unmanagedThirdPartyToolIdentities: [],
      diagnostics: { includeToolIdentities: false },
    };
    Object.defineProperty(withGetter, "nativeToolIdentities", {
      enumerable: true,
      get: () => ["native.read"],
    });
    expect(verifyPermissionCoverage(withGetter).isErr()).toBe(true);
    expect(verifyPermissionCoverage(withGetter)._unsafeUnwrapErr().type).toBe(
      "invalid_coverage",
    );

    const extras = {
      ...context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
      extra: true,
    } as unknown as PermissionCoverageContext;
    expect(verifyPermissionCoverage(extras)._unsafeUnwrapErr().type).toBe(
      "invalid_coverage",
    );

    expect(
      verifyPermissionCoverage({
        registry: { id: "forged", identity: "x", inventory: () => [] },
      } as unknown as PermissionCoverageContext)._unsafeUnwrapErr().type,
    ).toBe("invalid_coverage");
  });

  it("keeps plain dense inventory arrays unchanged", () => {
    const registry = seal([
      { identity: "native.read" },
      { identity: "weave.tool", owner: "weave" },
    ]);
    const proof = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: ["weave.tool"],
        interceptedToolIdentities: ["native.read", "weave.tool"],
        unmanagedThirdPartyToolIdentities: ["ext.logger"],
        diagnostics: { includeToolIdentities: true },
      }),
    )._unsafeUnwrap();
    expect(proof.requiredCount).toBe(2);
    expect(proof.registeredCount).toBe(2);
    expect(proof.interceptedCount).toBe(2);
    expect(proof.unmanagedCount).toBe(1);
    expect(proof.requiredToolIdentities).toEqual(["native.read", "weave.tool"]);
  });

  it("changing get-length proxy cannot vanish required native into zero-count readiness", () => {
    const registry = seal([{ identity: "native.read" }]);
    let lengthReads = 0;
    const vanishingNative = new Proxy(["native.read"], {
      get(target, prop, receiver) {
        if (prop === "length") {
          lengthReads += 1;
          // Classic multi-read TOCTOU would observe length 1 then 0 and emit
          // requiredCount 0. Descriptor snapshot keeps the native identity.
          return lengthReads <= 1 ? 1 : 0;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const result = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: vanishingNative as unknown as string[],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
        diagnostics: { includeToolIdentities: true },
      }),
    );
    expect(result.isOk()).toBe(true);
    const proof = result._unsafeUnwrap();
    expect(proof.requiredCount).toBe(1);
    expect(proof.requiredToolIdentities).toEqual(["native.read"]);
  });

  it("fails invalid_coverage when a required native inventory is descriptor-inconsistent", () => {
    const registry = seal([{ identity: "native.read" }]);
    // ownKeys claims index 0 while length says empty — disappearing identity
    // must not collapse to zero-count success.
    const vanishing = new Proxy([] as string[], {
      ownKeys() {
        return ["0", "length"];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === "length") {
          return {
            value: 0,
            writable: true,
            enumerable: false,
            configurable: false,
          };
        }
        if (prop === "0") {
          return {
            value: "native.read",
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return undefined;
      },
    });
    const result = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: vanishing as unknown as string[],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
      }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("invalid_coverage");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      "native.read",
    );
  });

  it("maps throwing inventory array traps to closed invalid_coverage", () => {
    const registry = seal([{ identity: "native.read" }]);
    const traps = [
      "getPrototypeOf",
      "ownKeys",
      "getOwnPropertyDescriptor",
    ] as const;
    for (const trap of traps) {
      const hostile = new Proxy(["native.read"], {
        [trap]: () => {
          throw new Error(`TOP_SECRET_COVERAGE_${trap}`);
        },
      } as ProxyHandler<object>);
      const result = verifyPermissionCoverage(
        context(registry, {
          nativeToolIdentities: hostile as unknown as string[],
          weaveOwnedToolIdentities: [],
          interceptedToolIdentities: ["native.read"],
        }),
      );
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("invalid_coverage");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
    }
  });

  it("does not expose resolvers, policies, grants, digests, or calls on proof", () => {
    const registry = seal([{ identity: "native.read" }]);
    const proof = verifyPermissionCoverage(
      context(registry, {
        nativeToolIdentities: ["native.read"],
        weaveOwnedToolIdentities: [],
        interceptedToolIdentities: ["native.read"],
        diagnostics: { includeToolIdentities: true },
      }),
    )._unsafeUnwrap();
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain("resolver");
    expect(serialized).not.toContain("policy");
    expect(serialized).not.toContain("grant");
    expect(serialized).not.toContain("digest");
    expect(serialized).not.toContain("call");
    expect(Reflect.ownKeys(proof).sort()).toEqual(
      [
        "generationId",
        "interceptedCount",
        "interceptedToolIdentities",
        "metadataIdentity",
        "registeredCount",
        "registeredToolIdentities",
        "requiredCount",
        "requiredToolIdentities",
        "unmanagedCount",
        "unmanagedToolIdentities",
      ].sort(),
    );
  });
});

describe("fake adapter permission coverage enforcement", () => {
  it("passes complete inventory and executes managed calls once via permit", async () => {
    const adapter = new FakePermissionAdapter();
    adapter.discover({
      native: ["native.read", "native.write"],
      weave: ["weave.delegate"],
      unmanaged: ["ext.logger"],
    });
    adapter.sealRegistry();
    const coverage = adapter.proveCoverage(true);
    expect(coverage.isOk()).toBe(true);

    await adapter.activate();
    expect(await adapter.invoke("native.read", { path: "a" })).toBe("executed");
    expect(await adapter.invoke("weave.delegate", { target: "shuttle" })).toBe(
      "executed",
    );
    expect(adapter.executions).toEqual([
      { toolIdentity: "native.read", call: { path: "a" } },
      { toolIdentity: "weave.delegate", call: { target: "shuttle" } },
    ]);
  });

  it("fails coverage for missing registration, interception, or bypass", () => {
    const missingRegistration = new FakePermissionAdapter();
    missingRegistration.discover({
      native: ["native.read", "native.missing"],
      weave: [],
    });
    missingRegistration.sealRegistry();
    // sealRegistry only registered discovered tools that were present at seal;
    // inject an extra required native after seal to simulate incomplete inventory.
    missingRegistration.nativeTools.push("native.extra");
    expect(
      missingRegistration.proveCoverage()._unsafeUnwrapErr(),
    ).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_registration",
      toolIdentity: "native.extra",
    });

    const missingInterception = new FakePermissionAdapter();
    missingInterception.discover({ native: ["native.read"], weave: [] });
    missingInterception.sealRegistry();
    missingInterception.dropInterception("native.read");
    expect(
      missingInterception.proveCoverage()._unsafeUnwrapErr(),
    ).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_interception",
      toolIdentity: "native.read",
    });

    const bypass = new FakePermissionAdapter();
    bypass.discover({ native: ["native.read"], weave: [] });
    bypass.sealRegistry();
    bypass.markBypassable("native.read");
    expect(bypass.proveCoverage()._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "bypassable_call",
      toolIdentity: "native.read",
    });
  });

  it("treats unmanaged third-party authorize as unmanaged with no permit", async () => {
    const adapter = new FakePermissionAdapter();
    adapter.discover({
      native: ["native.read"],
      weave: [],
      unmanaged: ["ext.logger"],
    });
    adapter.sealRegistry();
    expect(adapter.proveCoverage().isOk()).toBe(true);
    await adapter.activate();

    expect(await adapter.invoke("ext.logger", { msg: "hi" })).toBe("unmanaged");
    expect(adapter.executions).toEqual([]);

    const direct = await adapter.session.authorizeCall({
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "ext.logger",
      registryGeneration: adapter.registry.id,
      call: { msg: "hi" },
      approvalUiAvailable: false,
    });
    expect(direct.isOk() && direct.value).toEqual({ kind: "unmanaged" });
  });

  it("makes interception mandatory once a third-party tool is registered", () => {
    const adapter = new FakePermissionAdapter();
    adapter.discover({
      native: ["native.read"],
      weave: [],
      unmanaged: ["ext.logger"],
    });
    adapter.sealRegistry(["ext.logger"]);
    // Registered third-party must leave the unmanaged list.
    adapter.unmanagedThirdParty = [];
    adapter.dropInterception("ext.logger");
    expect(adapter.proveCoverage()._unsafeUnwrapErr()).toMatchObject({
      type: "incomplete_coverage",
      reason: "missing_interception",
      toolIdentity: "ext.logger",
    });

    adapter.intercepted.add("ext.logger");
    expect(adapter.proveCoverage().isOk()).toBe(true);
  });

  it("blocks input swap and permit replay from executing", async () => {
    const adapter = new FakePermissionAdapter();
    adapter.discover({ native: ["native.read"], weave: [] });
    adapter.sealRegistry();
    await adapter.activate();

    const authorized = await adapter.session.authorizeCall({
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "native.read",
      registryGeneration: adapter.registry.id,
      call: { path: "a" },
      approvalUiAvailable: false,
    });
    expect(authorized.isOk()).toBe(true);
    if (!authorized.isOk() || authorized.value.kind !== "authorized")
      throw new Error("expected authorized");
    const permit = authorized.value.permit;

    const swapped = await adapter.session.consumePermit({
      permit,
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "native.read",
      registryGeneration: adapter.registry.id,
      call: { path: "swapped" },
    });
    expect(swapped.isErr()).toBe(true);
    expect(adapter.executions).toEqual([]);

    const first = await adapter.session.consumePermit({
      permit,
      project: "project",
      session: "controller",
      agentName: "agent",
      toolIdentity: "native.read",
      registryGeneration: adapter.registry.id,
      call: { path: "a" },
    });
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) throw new Error("expected consume ok");
    // Authorization is executable only after successful snapshot return.
    adapter.executions.push({
      toolIdentity: "native.read",
      call: first.value,
    });

    const replayed = await adapter.replayPermit(
      "native.read",
      { path: "a" },
      permit,
    );
    expect(replayed).toBe(false);
    expect(adapter.executions).toHaveLength(1);
  });

  it("executes only the frozen consume snapshot against hostile caller objects", async () => {
    const adapter = new FakePermissionAdapter();
    adapter.discover({ native: ["native.read"], weave: [] });
    adapter.sealRegistry();
    await adapter.activate();

    const live: { path: string; nested: { flag: string } } = {
      path: "allowed",
      nested: { flag: "safe" },
    };
    expect(await adapter.invoke("native.read", live)).toBe("executed");
    // Caller mutates after successful consumption — execution used the snapshot.
    live.path = "mutated-after-consume";
    live.nested.flag = "mutated-nested";
    expect(adapter.executions).toHaveLength(1);
    const executed = adapter.executions[0].call as {
      path: string;
      nested: { flag: string };
    };
    expect(executed).toEqual({ path: "allowed", nested: { flag: "safe" } });
    expect(Object.isFrozen(executed)).toBe(true);
    expect(Object.isFrozen(executed.nested)).toBe(true);
    expect(() => {
      (executed as { path: string }).path = "rewrite";
    }).toThrow();

    // Descriptor/get proxy disagreement: authorize+consume see data descriptor.
    let afterConsume = false;
    const proxyCall = new Proxy(
      { path: "proxy-allowed" },
      {
        get(target, prop, receiver) {
          if (prop === "path" && afterConsume) return "changed-at-execution";
          return Reflect.get(target, prop, receiver);
        },
        ownKeys: () => ["path"],
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "path") {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: "proxy-allowed",
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        getPrototypeOf: () => Object.prototype,
      },
    );
    adapter.executions.length = 0;
    expect(await adapter.invoke("native.read", proxyCall)).toBe("executed");
    expect(adapter.executions[0].call).toEqual({ path: "proxy-allowed" });
    afterConsume = true;
    // Live get now disagrees — adapter already executed the snapshot.
    expect((proxyCall as { path: string }).path).toBe("changed-at-execution");
  });
});
