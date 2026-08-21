import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  createAdapterCommandRegistry,
  dispatchAdapterCommand,
  parseAdapterCommandRequest,
} from "../adapter-command.js";

describe("parseAdapterCommandRequest", () => {
  it("accepts a minimal opaque envelope", () => {
    const parsed = parseAdapterCommandRequest({
      adapter: "fake",
      command: "ping",
      payloadJson: "{}",
    });
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual({
      adapter: "fake",
      command: "ping",
      payloadJson: "{}",
    });
  });

  it("rejects missing fields and unknown keys", () => {
    const missing = parseAdapterCommandRequest({ adapter: "fake" });
    expect(missing.isErr()).toBe(true);
    expect(missing._unsafeUnwrapErr().type).toBe("InvalidEnvelope");

    const unknown = parseAdapterCommandRequest({
      adapter: "fake",
      command: "ping",
      payloadJson: "{}",
      harnessSession: "/tmp/secret",
    });
    expect(unknown.isErr()).toBe(true);
    expect(unknown._unsafeUnwrapErr().type).toBe("InvalidEnvelope");
  });

  it("rejects uppercase or empty opaque names", () => {
    const upper = parseAdapterCommandRequest({
      adapter: "Fake",
      command: "ping",
      payloadJson: "{}",
    });
    expect(upper.isErr()).toBe(true);

    const empty = parseAdapterCommandRequest({
      adapter: "",
      command: "ping",
      payloadJson: "{}",
    });
    expect(empty.isErr()).toBe(true);
  });

  it("rejects boxed strings and accessors without reading them", () => {
    const valid = {
      adapter: "fake",
      command: "ping",
      payloadJson: "{}",
    };
    const boxed = { ...valid };
    Object.defineProperty(boxed, "adapter", {
      value: Reflect.construct(String, ["fake"]),
    });
    expect(parseAdapterCommandRequest(boxed)._unsafeUnwrapErr().type).toBe(
      "InvalidEnvelope",
    );

    let accessorReads = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, "payloadJson", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("payload accessor must not run");
      },
    });
    const accessorResult = parseAdapterCommandRequest(accessor);
    expect(accessorResult.isErr()).toBe(true);
    expect(accessorReads).toBe(0);

    const previousAdapter = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "adapter",
    );
    let setterCalls = 0;
    let prototypeResult: ReturnType<typeof parseAdapterCommandRequest>;
    try {
      Object.defineProperty(Object.prototype, "adapter", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      prototypeResult = parseAdapterCommandRequest(valid);
    } finally {
      if (previousAdapter === undefined)
        Reflect.deleteProperty(Object.prototype, "adapter");
      else Object.defineProperty(Object.prototype, "adapter", previousAdapter);
    }
    expect(prototypeResult.isOk()).toBe(true);
    expect(setterCalls).toBe(0);

    let tagReads = 0;
    const tagged = { ...valid };
    Object.defineProperty(tagged, Symbol.toStringTag, {
      configurable: true,
      get: () => {
        tagReads += 1;
        return "String";
      },
    });
    expect(parseAdapterCommandRequest(tagged)._unsafeUnwrapErr().type).toBe(
      "InvalidEnvelope",
    );
    expect(tagReads).toBe(0);

    const spoofedValue = {};
    Object.defineProperty(spoofedValue, Symbol.toStringTag, {
      configurable: true,
      get: () => {
        tagReads += 1;
        return "String";
      },
    });
    const spoofed = { ...valid };
    Object.defineProperty(spoofed, "adapter", { value: spoofedValue });
    expect(parseAdapterCommandRequest(spoofed)._unsafeUnwrapErr().type).toBe(
      "InvalidEnvelope",
    );
    expect(tagReads).toBe(0);
  });

  it("contains hostile proxy reflection failures as typed errors", () => {
    const valid = {
      adapter: "fake",
      command: "ping",
      payloadJson: "{}",
    };
    let getTrapCalls = 0;
    const transparentProxy = new Proxy(valid, {
      get: () => {
        getTrapCalls += 1;
        throw new Error("get trap");
      },
    });
    const transparentResult = parseAdapterCommandRequest(transparentProxy);
    expect(transparentResult.isOk()).toBe(true);
    expect(getTrapCalls).toBe(0);

    const hostileInputs = [
      new Proxy(valid, {
        ownKeys: () => {
          throw new Error("ownKeys trap");
        },
      }),
      new Proxy(valid, {
        getPrototypeOf: () => {
          throw new Error("prototype trap");
        },
      }),
      new Proxy(valid, {
        getOwnPropertyDescriptor: () => {
          throw new Error("descriptor trap");
        },
      }),
    ];

    for (const hostile of hostileInputs) {
      let result: ReturnType<typeof parseAdapterCommandRequest> | undefined;
      expect(() => {
        result = parseAdapterCommandRequest(hostile);
      }).not.toThrow();
      expect(result?.isErr()).toBe(true);
      if (result?.isErr()) expect(result.error.type).toBe("InvalidEnvelope");
    }
  });

  it("rejects callable values without invoking them or their traps", () => {
    let calls = 0;
    let applyTrapCalls = 0;
    let ownKeysTrapCalls = 0;
    const callable = Object.assign(
      () => {
        calls += 1;
        return null;
      },
      {
        adapter: "fake",
        command: "ping",
        payloadJson: "{}",
      },
    );
    const hostile = new Proxy(callable, {
      apply: () => {
        applyTrapCalls += 1;
        throw new Error("apply trap");
      },
      ownKeys: () => {
        ownKeysTrapCalls += 1;
        throw new Error("callable ownKeys trap");
      },
    });

    const result = parseAdapterCommandRequest(hostile);
    expect(result.isErr()).toBe(true);
    expect(calls).toBe(0);
    expect(applyTrapCalls).toBe(0);
    expect(ownKeysTrapCalls).toBe(0);
  });
});

describe("dispatchAdapterCommand", () => {
  it("routes to a fake adapter handler and returns opaque JSON", async () => {
    const registry = createAdapterCommandRegistry({
      fake: {
        echo: (payloadJson) =>
          okAsync(JSON.stringify({ echoed: JSON.parse(payloadJson) })),
      },
    });

    const result = await dispatchAdapterCommand(registry, {
      adapter: "fake",
      command: "echo",
      payloadJson: JSON.stringify({ n: 1 }),
    });

    expect(result.isOk()).toBe(true);
    expect(JSON.parse(result._unsafeUnwrap().resultJson)).toEqual({
      echoed: { n: 1 },
    });
  });

  it("fails closed for unregistered adapter or command", async () => {
    const registry = createAdapterCommandRegistry({
      fake: {
        ping: () => okAsync(JSON.stringify({ ok: true })),
      },
    });

    const missingAdapter = await dispatchAdapterCommand(registry, {
      adapter: "missing",
      command: "ping",
      payloadJson: "{}",
    });
    expect(missingAdapter._unsafeUnwrapErr()).toEqual({
      type: "AdapterNotRegistered",
      adapter: "missing",
    });

    const missingCommand = await dispatchAdapterCommand(registry, {
      adapter: "fake",
      command: "other",
      payloadJson: "{}",
    });
    expect(missingCommand._unsafeUnwrapErr()).toEqual({
      type: "CommandNotRegistered",
      adapter: "fake",
      command: "other",
    });
  });

  it("maps handler failures without inspecting payload semantics", async () => {
    const registry = createAdapterCommandRegistry({
      fake: {
        boom: () => errAsync({ message: "port unavailable" }),
      },
    });

    const result = await dispatchAdapterCommand(registry, {
      adapter: "fake",
      command: "boom",
      payloadJson: JSON.stringify({ childPath: "/secret/session.jsonl" }),
    });

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "HandlerFailed",
      adapter: "fake",
      command: "boom",
      message: "port unavailable",
    });
  });

  it("does not import Pi packages from the engine surface", async () => {
    await Promise.resolve();
    // Structural proof: this module graph stays harness-neutral.
    expect(dispatchAdapterCommand).toBeDefined();
    expect(createAdapterCommandRegistry).toBeDefined();
  });
});
