import { describe, expect, test } from "bun:test";

import {
  createPiNativeSessionHost,
  type PiSessionManagerStatic,
} from "../native-session-host.js";

describe("createPiNativeSessionHost", () => {
  test("fails closed before calling SessionManager", () => {
    let createCalls = 0;
    let openCalls = 0;
    const sessionManager: PiSessionManagerStatic = {
      create: () => {
        createCalls += 1;
        throw new Error("SessionManager.create must not be called");
      },
      open: () => {
        openCalls += 1;
        throw new Error("SessionManager.open must not be called");
      },
    };
    const host = createPiNativeSessionHost(sessionManager);

    expect(host.requireDescriptorSafeSessionIo()._unsafeUnwrapErr()).toEqual({
      type: "SessionStorageUnavailable",
      reason: "path-only-session-api",
    });
    expect(() => host.create("/repo", "/data/weave/sessions", {})).toThrow(
      "path-addressed session API",
    );
    expect(() =>
      host.open("/data/weave/sessions/session.jsonl", "/data/weave/sessions"),
    ).toThrow("path-addressed session API");
    expect(createCalls).toBe(0);
    expect(openCalls).toBe(0);
  });
});
