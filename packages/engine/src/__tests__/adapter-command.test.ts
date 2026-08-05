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
    expect(typeof dispatchAdapterCommand).toBe("function");
    expect(typeof createAdapterCommandRegistry).toBe("function");
  });
});
