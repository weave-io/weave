/**
 * Adversarial coverage for `validatePiNativeSessionHeader` against hostile
 * proxies whose own reflection traps throw (Spec 33 path-session design §5.2).
 *
 * A validator that reflects directly - `Object.getPrototypeOf`,
 * `Reflect.ownKeys`, `Object.getOwnPropertyDescriptor`, or plain property
 * access - propagates a trap's throw straight out of a `Result`-returning
 * function, so a hostile or merely broken host could crash the seam instead of
 * being refused. Every trap failure here must be a typed validation failure.
 */

import { describe, expect, test } from "bun:test";

import { validatePiNativeSessionHeader } from "../native-session-header.js";

const PARENT = "parent-session-1";

const SUPPORTED_HEADER = {
  type: "session",
  version: 3,
  id: "pi-session-1",
  timestamp: "2026-08-11T00:00:00.000Z",
  cwd: "/repo",
  parentSession: PARENT,
} as const;

describe("header validation survives hostile reflection traps", () => {
  test("a throwing getPrototypeOf trap is a typed refusal, not a throw", () => {
    const hostile = new Proxy(
      { ...SUPPORTED_HEADER },
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap");
        },
      },
    );

    expect(validatePiNativeSessionHeader(hostile)._unsafeUnwrapErr()).toBe(
      "not-plain-object",
    );
  });

  test("a throwing ownKeys trap is a typed refusal, not a throw", () => {
    const hostile = new Proxy(
      { ...SUPPORTED_HEADER },
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      },
    );

    expect(validatePiNativeSessionHeader(hostile)._unsafeUnwrapErr()).toBe(
      "not-plain-object",
    );
  });

  test("a throwing getOwnPropertyDescriptor trap is a typed refusal", () => {
    const hostile = new Proxy(
      { ...SUPPORTED_HEADER },
      {
        getOwnPropertyDescriptor() {
          throw new Error("getOwnPropertyDescriptor trap");
        },
      },
    );

    expect(validatePiNativeSessionHeader(hostile)._unsafeUnwrapErr()).toBe(
      "unsafe-descriptor",
    );
  });

  test("a descriptor whose own value accessor throws is a typed refusal", () => {
    const hostile = new Proxy(
      { ...SUPPORTED_HEADER },
      {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Object.getOwnPropertyDescriptor(target, key);
          if (key !== "cwd" || descriptor === undefined) return descriptor;
          // `ToPropertyDescriptor` reads `.value` off the trap result, so a
          // throwing accessor here throws inside the engine's own conversion.
          return Object.defineProperty({ ...descriptor }, "value", {
            get() {
              throw new Error("descriptor value trap");
            },
            enumerable: true,
          });
        },
      },
    );

    expect(validatePiNativeSessionHeader(hostile)._unsafeUnwrapErr()).toBe(
      "unsafe-descriptor",
    );
  });

  test("a throwing get trap never runs: values come from descriptors", () => {
    let getTrapCalls = 0;
    const hostile = new Proxy(
      { ...SUPPORTED_HEADER },
      {
        get() {
          getTrapCalls += 1;
          throw new Error("get trap");
        },
      },
    );

    expect(validatePiNativeSessionHeader(hostile).isOk()).toBe(true);
    expect(getTrapCalls).toBe(0);
  });

  test("a revoked proxy is a typed refusal, not a throw", () => {
    const revocable = Proxy.revocable({ ...SUPPORTED_HEADER }, {});
    revocable.revoke();

    expect(validatePiNativeSessionHeader(revocable.proxy).isErr()).toBe(true);
  });

  test("an ownKeys trap that reports a symbol key is refused", () => {
    const marker = Symbol("hidden");
    const target = { ...SUPPORTED_HEADER, [marker]: true };

    expect(validatePiNativeSessionHeader(target)._unsafeUnwrapErr()).toBe(
      "unsafe-descriptor",
    );
  });
});
