import { describe, expect, test } from "bun:test";

import {
  createPiNativeSessionHost,
  type PiSessionManagerInstance,
  type PiSessionManagerStatic,
} from "../native-session-host.js";

function createSessionManagerInstance(): PiSessionManagerInstance {
  return {
    getSessionId: () => "session-id",
    getSessionFile: () => "/data/weave/sessions/session.jsonl",
    getSessionDir: () => "/data/weave/sessions",
    getHeader: () => ({ id: "session-id", cwd: "/repo" }),
    getEntries: () => [],
    isPersisted: () => true,
    getLeafId: () => null,
    appendCustomEntry: () => "entry-id",
  };
}

describe("createPiNativeSessionHost", () => {
  test("delegates native session creation and opening to Pi", () => {
    const manager = createSessionManagerInstance();
    const createCalls: unknown[][] = [];
    const openCalls: unknown[][] = [];
    const sessionManager: PiSessionManagerStatic = {
      create: (...args) => {
        createCalls.push(args);
        return manager;
      },
      open: (...args) => {
        openCalls.push(args);
        return manager;
      },
    };
    const host = createPiNativeSessionHost(sessionManager);

    expect(
      host
        .create("/repo", "/data/weave/sessions", { id: "session-id" })
        .getSessionId(),
    ).toBe("session-id");
    expect(
      host
        .open("/data/weave/sessions/session.jsonl", "/data/weave/sessions")
        .getSessionId(),
    ).toBe("session-id");
    expect(createCalls).toEqual([
      ["/repo", "/data/weave/sessions", { id: "session-id" }],
    ]);
    expect(openCalls).toEqual([
      ["/data/weave/sessions/session.jsonl", "/data/weave/sessions"],
    ]);
  });
});
