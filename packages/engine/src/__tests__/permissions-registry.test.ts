import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";
import * as engine from "../index.js";
import { verifyPermissionCoverage } from "../permissions/coverage.js";
import {
  createPermissionRegistryBuilderForTesting,
  invokePermissionResolver,
  lookupRegistryRegistration,
  PermissionRegistryBuilder,
  PermissionRegistryGeneration,
  readRegistryGenerationMeta,
  readRegistryInventory,
  validatePermissionRegistryGeneration,
} from "../permissions/registry.js";

const registration = (
  toolIdentity: string,
  extra: Record<string, unknown> = {},
) => ({
  toolIdentity,
  owner: "owner",
  revision: "1",
  summary: "summary",
  resolver: () => ok([]),
  ...extra,
});

describe("permission registry", () => {
  it("validates required fields and UTF-8 byte limits", () => {
    expect(
      new PermissionRegistryBuilder().register(registration("")).isErr(),
    ).toBe(true);
    expect(
      new PermissionRegistryBuilder()
        .register(registration("a".repeat(257)))
        .isErr(),
    ).toBe(true);
    expect(
      new PermissionRegistryBuilder()
        .register(registration("é".repeat(129)))
        .isErr(),
    ).toBe(true);
    expect(
      new PermissionRegistryBuilder()
        .register(registration("é".repeat(129)))
        .isErr(),
    ).toBe(true);
    expect(
      new PermissionRegistryBuilder()
        .register(registration("x", { resolver: "no" }))
        .isErr(),
    ).toBe(true);
  });

  it("poisons duplicate candidates and enforces lifecycle", () => {
    const builder = new PermissionRegistryBuilder();
    expect(builder.register(registration("x")).isOk()).toBe(true);
    expect(builder.register(registration("x")).isErr()).toBe(true);
    expect(builder.seal().isErr()).toBe(true);
    expect(builder.register(registration("y")).isErr()).toBe(true);
    expect(builder.seal().isErr()).toBe(true);
  });

  it("creates stable identities and immutable safe views", () => {
    const a = new PermissionRegistryBuilder();
    a.register(registration("b"));
    a.register(registration("a"));
    const b = new PermissionRegistryBuilder();
    b.register(registration("a"));
    b.register(registration("b"));
    const one = a.seal();
    const two = b.seal();
    expect(one.isOk() && two.isOk() && one.value.identity).toBe(
      two.isOk() ? two.value.identity : "",
    );
    expect(one.isOk() && two.isOk() && one.value.id).not.toBe(
      two.isOk() ? two.value.id : "",
    );
    if (one.isOk()) {
      expect(Object.isFrozen(one.value)).toBe(true);
      expect(Object.isFrozen(one.value.inventory())).toBe(true);
      expect(one.value.get("missing")).toBeUndefined();
      expect(one.value.get("a")?.resolver).toBeDefined();
      expect(Object.isFrozen(one.value.get("a"))).toBe(true);
      expect(Reflect.ownKeys(one.value)).not.toContain("registrations");
      expect(
        Object.getOwnPropertyDescriptor(one.value, "registrations"),
      ).toBeUndefined();
      expect(() =>
        Object.defineProperty(one.value, "registrations", {
          value: new Map(),
        }),
      ).toThrow();
      expect(() =>
        (one.value.inventory() as unknown as unknown[]).push({}),
      ).toThrow();
    }
    expect(Reflect.ownKeys(a)).not.toContain("registrations");
  });

  it("keeps metadata identity stable across seals while minting unique generation ids", () => {
    const sealMatching = () => {
      const builder = new PermissionRegistryBuilder();
      builder.register(registration("tool-a", { revision: "3" }));
      builder.register(registration("tool-b", { owner: "svc" }));
      return builder.seal()._unsafeUnwrap();
    };
    const first = sealMatching();
    const second = sealMatching();
    expect(first.identity).toBe(second.identity);
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
    expect(second.id.length).toBeGreaterThan(0);
  });

  it("retries a first collision then seals with a fresh id", () => {
    const reserved = createPermissionRegistryBuilderForTesting({
      idSource: () => "collision-shared-id",
    });
    reserved.register(registration("tool"));
    expect(reserved.seal().isOk()).toBe(true);

    let calls = 0;
    const builder = createPermissionRegistryBuilderForTesting({
      idSource: () => {
        calls += 1;
        if (calls === 1) return "collision-shared-id";
        return "collision-recovered-id";
      },
    });
    builder.register(registration("tool"));
    const sealed = builder.seal();
    expect(sealed.isOk()).toBe(true);
    expect(sealed._unsafeUnwrap().id).toBe("collision-recovered-id");
    expect(calls).toBe(2);
  });

  it("returns invalid_registry after repeated generation-id collisions", () => {
    const first = createPermissionRegistryBuilderForTesting({
      idSource: () => "always-colliding-id",
    });
    first.register(registration("tool"));
    expect(first.seal().isOk()).toBe(true);

    let calls = 0;
    const second = createPermissionRegistryBuilderForTesting({
      idSource: () => {
        calls += 1;
        return "always-colliding-id";
      },
    });
    second.register(registration("tool"));
    const failed = second.seal();
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr().type).toBe("invalid_registry");
    expect(calls).toBe(16);
  });

  it("wraps generation-id source throws as invalid_registry", () => {
    const builder = createPermissionRegistryBuilderForTesting({
      idSource: () => {
        throw new Error("crypto unavailable");
      },
    });
    builder.register(registration("tool"));
    const failed = builder.seal();
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr()).toEqual({
      type: "invalid_registry",
      message: "unable to create registry generation",
    });
    expect(JSON.stringify(failed._unsafeUnwrapErr())).not.toContain(
      "crypto unavailable",
    );
  });

  it("issues unique generation ids under concurrent seal pressure", async () => {
    let sequence = 0;
    const source = () => {
      const current = sequence;
      sequence += 1;
      // Force every other attempt to collide with an already-issued id pattern
      // by replaying earlier values before advancing.
      if (current > 0 && current % 3 === 0)
        return `concurrent-id-${current - 1}`;
      return `concurrent-id-${current}`;
    };
    const builders = Array.from({ length: 32 }, () => {
      const builder = createPermissionRegistryBuilderForTesting({
        idSource: source,
      });
      builder.register(registration("tool"));
      return builder;
    });
    const results = await Promise.all(
      builders.map(async (builder) => builder.seal()),
    );
    expect(results.every((result) => result.isOk())).toBe(true);
    const ids = results.map((result) => result._unsafeUnwrap().id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not expose the testing builder factory on the package root", () => {
    expect("createPermissionRegistryBuilderForTesting" in engine).toBe(false);
    expect(Object.hasOwn(new PermissionRegistryBuilder(), "idSource")).toBe(
      false,
    );
  });

  it("rejects JavaScript construction and has no public fromToken surface", () => {
    expect("fromToken" in PermissionRegistryGeneration).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(
        PermissionRegistryGeneration,
        "fromToken",
      ),
    ).toBeUndefined();
    expect(
      () =>
        new (
          PermissionRegistryGeneration as unknown as new (
            ...args: unknown[]
          ) => unknown
        )(Symbol("forged"), [], "custom-identity", "custom-generation"),
    ).toThrow();
  });

  it("freezes the generation constructor and prototype against monkey patches", () => {
    expect(Object.isFrozen(PermissionRegistryGeneration)).toBe(true);
    expect(Object.isFrozen(PermissionRegistryGeneration.prototype)).toBe(true);
    expect(() => {
      (
        PermissionRegistryGeneration as unknown as {
          fromToken: unknown;
        }
      ).fromToken = () => {
        throw new Error("should not install");
      };
    }).toThrow();
    expect(() => {
      PermissionRegistryGeneration.prototype.lookup = () => ({
        toolIdentity: "forged",
        owner: "attacker",
        revision: "0",
        summary: "forged",
        resolver: () => ok([]),
      });
    }).toThrow();
    expect(() => {
      PermissionRegistryGeneration.prototype.get = () => undefined;
    }).toThrow();
    expect(() => {
      PermissionRegistryGeneration.prototype.inventory = () => [];
    }).toThrow();
  });

  it("blocks patched static token capture and forged source/identity/id supply", () => {
    const Generation = PermissionRegistryGeneration as unknown as {
      fromToken?: (...args: unknown[]) => unknown;
    };
    let capturedToken: unknown;
    let installed = false;
    try {
      Generation.fromToken = (token: unknown, ..._rest: unknown[]) => {
        capturedToken = token;
        installed = true;
        return err({ type: "invalid_registry", message: "patched" });
      };
    } catch {
      installed = false;
    }
    expect(installed).toBe(false);
    expect(capturedToken).toBeUndefined();
    expect("fromToken" in PermissionRegistryGeneration).toBe(false);

    const builder = new PermissionRegistryBuilder();
    builder.register(registration("tool"));
    const sealed = builder.seal();
    expect(sealed.isOk()).toBe(true);
    // Seal still succeeds through the module-private factory; no public token
    // surface exists for an attacker to wrap or supply custom identity/id.
    expect(capturedToken).toBeUndefined();
    if (sealed.isOk()) {
      const meta = readRegistryGenerationMeta(sealed.value)._unsafeUnwrap();
      expect(meta.id.length).toBeGreaterThan(0);
      expect(meta.identity.length).toBeGreaterThan(0);
    }
  });

  it("keeps authoritative accessors independent of own-method and prototype attacks", () => {
    const builder = new PermissionRegistryBuilder();
    builder.register(registration("tool"));
    const generation = builder.seal()._unsafeUnwrap();

    // Genuine instance is frozen: own-method shadowing cannot stick.
    expect(Object.isFrozen(generation)).toBe(true);
    expect(() => {
      Object.defineProperty(generation, "lookup", {
        value: () => ({
          toolIdentity: "shadowed",
          owner: "attacker",
          revision: "9",
          summary: "shadowed",
          resolver: () => ok([]),
        }),
        configurable: true,
      });
    }).toThrow();
    expect(() => {
      Object.defineProperty(generation, "inventory", {
        value: () => [
          {
            toolIdentity: "shadowed",
            owner: "attacker",
            revision: "9",
            summary: "shadowed",
          },
        ],
        configurable: true,
      });
    }).toThrow();

    const internalLookup = lookupRegistryRegistration(generation, "tool");
    expect(internalLookup.isOk()).toBe(true);
    expect(internalLookup._unsafeUnwrap()?.toolIdentity).toBe("tool");
    expect(lookupRegistryRegistration(generation, "shadowed").isOk()).toBe(
      true,
    );
    expect(
      lookupRegistryRegistration(generation, "shadowed")._unsafeUnwrap(),
    ).toBeUndefined();

    const inventory = readRegistryInventory(generation)._unsafeUnwrap();
    expect(inventory.map((entry) => entry.toolIdentity)).toEqual(["tool"]);
    expect(generation.lookup("tool")?.toolIdentity).toBe("tool");
    expect(generation.inventory().map((entry) => entry.toolIdentity)).toEqual([
      "tool",
    ]);

    // Coverage verification also uses non-virtual inventory/meta accessors.
    const proof = verifyPermissionCoverage({
      registry: generation,
      nativeToolIdentities: ["tool"],
      weaveOwnedToolIdentities: [],
      interceptedToolIdentities: ["tool"],
      bypassableToolIdentities: [],
      unmanagedThirdPartyToolIdentities: [],
      diagnostics: { includeToolIdentities: false },
    });
    expect(proof.isOk()).toBe(true);
    expect(proof._unsafeUnwrap().registeredCount).toBe(1);
  });

  it("brands generations against prototype, proxy, and copied-object forgeries", () => {
    const builder = new PermissionRegistryBuilder();
    builder.register(registration("tool"));
    const generation = builder.seal()._unsafeUnwrap();
    const forged = Object.create(generation) as typeof generation;
    const proxied = new Proxy(generation, {});
    const methodCopied = {
      lookup: generation.lookup.bind(generation),
      get: generation.get.bind(generation),
      inventory: generation.inventory.bind(generation),
      identity: generation.identity,
      id: generation.id,
    };
    for (const value of [forged, proxied, methodCopied]) {
      const checked = validatePermissionRegistryGeneration(value);
      expect(checked.isErr()).toBe(true);
      expect(checked._unsafeUnwrapErr().type).toBe("invalid_registry");
      expect(lookupRegistryRegistration(value as never, "tool").isErr()).toBe(
        true,
      );
      expect(readRegistryInventory(value as never).isErr()).toBe(true);
      expect(readRegistryGenerationMeta(value as never).isErr()).toBe(true);
    }
  });

  it("does not expose internal registry accessors or testing seams on the package root", () => {
    expect("lookupRegistryRegistration" in engine).toBe(false);
    expect("readRegistryInventory" in engine).toBe(false);
    expect("readRegistryGenerationMeta" in engine).toBe(false);
    expect("createPermissionRegistryBuilderForTesting" in engine).toBe(false);
    expect("fromToken" in engine.PermissionRegistryGeneration).toBe(false);
  });

  it("contains hostile registration and context reflection traps", () => {
    const traps = [
      "getPrototypeOf",
      "ownKeys",
      "getOwnPropertyDescriptor",
      "get",
    ] as const;
    for (const trap of traps) {
      const hostile = new Proxy(registration("x"), {
        [trap]: () => {
          throw new Error(`TOP_SECRET_${trap}`);
        },
      } as ProxyHandler<object>);
      const result = new PermissionRegistryBuilder().register(hostile as never);
      if (trap === "get") {
        expect(result.isOk()).toBe(true);
        continue;
      }
      expect(result._unsafeUnwrapErr().type).toBe("invalid_registration");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
    }
    const context = new Proxy(
      { toolIdentity: "x", owner: "o", revision: "1" },
      {
        getPrototypeOf: () => {
          throw new Error("TOP_SECRET_context");
        },
      },
    );
    const result = invokePermissionResolver(() => ok([]), {}, context as never);
    expect(result._unsafeUnwrapErr().type).toBe("invalid_registration");
  });

  it("rejects fake and malicious resolver Result values without escaping", () => {
    const fake = invokePermissionResolver(
      () => ({ value: [], isOk: () => true }) as never,
      {},
      { toolIdentity: "x", owner: "o", revision: "1" },
    );
    expect(fake._unsafeUnwrapErr().type).toBe("invalid_output");
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("TOP_SECRET_result");
        },
      },
    );
    const result = invokePermissionResolver(
      () => hostile as never,
      {},
      {
        toolIdentity: "x",
        owner: "o",
        revision: "1",
      },
    );
    expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );
  });

  it("freezes resolver inputs and distinguishes outcomes", () => {
    let frozen = false;
    const resolver = ({
      call,
      context,
    }: {
      call: import("../permissions/types.js").JsonValue;
      context: import("../permissions/types.js").PermissionRegistrationContext;
    }) => {
      frozen = Object.isFrozen(call) && Object.isFrozen(context);
      return ok([]);
    };
    expect(
      invokePermissionResolver(
        resolver,
        { x: [1] },
        { toolIdentity: "x", owner: "o", revision: "1" },
      ).isOk(),
    ).toBe(true);
    expect(frozen).toBe(true);
    expect(
      invokePermissionResolver(
        () => err({ type: "invalid_output" as const }),
        {},
        { toolIdentity: "x", owner: "o", revision: "1" },
      )._unsafeUnwrapErr().type,
    ).toBe("resolver_returned_error");
    expect(
      invokePermissionResolver(
        () => {
          throw new Error("secret");
        },
        {},
        { toolIdentity: "x", owner: "o", revision: "1" },
      )._unsafeUnwrapErr().type,
    ).toBe("resolver_threw");
  });
});
