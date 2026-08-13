import { describe, expect, test } from "bun:test";

import {
  createPiNativeSessionHost,
  isPiSessionManagerStatic,
  type PiSessionManagerInstance,
  type PiSessionManagerStatic,
} from "../native-session-host.js";

const HEADER = {
  type: "session",
  version: 3,
  id: "pi-session-1",
  timestamp: "2026-08-11T00:00:00.000Z",
  cwd: "/repo",
  parentSession: "parent-session-1",
} as const;

function handle(sessionFile: string, sessionDir: string) {
  return {
    getSessionId: () => HEADER.id,
    getSessionFile: () => sessionFile,
    getSessionDir: () => sessionDir,
    getHeader: () => HEADER,
    getEntries: () => [],
    isPersisted: () => true,
    getLeafId: () => null,
    appendCustomEntry: () => "entry-1",
  } satisfies PiSessionManagerInstance;
}

describe("createPiNativeSessionHost", () => {
  test("passes the adapter-owned directory to both Pi constructors", () => {
    const createCalls: Array<[string, string | undefined, unknown]> = [];
    const openCalls: Array<[string, string | undefined]> = [];
    const sessionManager: PiSessionManagerStatic = {
      create: (cwd, sessionDir, options) => {
        createCalls.push([cwd, sessionDir, options]);
        return handle(
          `${sessionDir ?? ""}/pi-generated.jsonl`,
          sessionDir ?? "",
        );
      },
      open: (path, sessionDir) => {
        openCalls.push([path, sessionDir]);
        return handle(path, sessionDir ?? "");
      },
    };
    const host = createPiNativeSessionHost(sessionManager);

    const created = host.create("/repo", "/data/weave/sessions/child-1", {
      parentSession: "parent-session-1",
    });
    const opened = host.open(
      "/data/weave/sessions/child-1/pi-generated.jsonl",
      "/data/weave/sessions/child-1",
    );

    expect(createCalls).toEqual([
      [
        "/repo",
        "/data/weave/sessions/child-1",
        { parentSession: "parent-session-1" },
      ],
    ]);
    expect(openCalls).toEqual([
      [
        "/data/weave/sessions/child-1/pi-generated.jsonl",
        "/data/weave/sessions/child-1",
      ],
    ]);
    expect(created.getSessionDir()).toBe("/data/weave/sessions/child-1");
    expect(opened.getSessionId()).toBe(HEADER.id);
  });

  test("refuses a header carrying an unknown field instead of dropping it", () => {
    const sessionManager: PiSessionManagerStatic = {
      create: (_cwd, sessionDir) => ({
        ...handle(`${sessionDir ?? ""}/pi-generated.jsonl`, sessionDir ?? ""),
        getHeader: () =>
          ({
            ...HEADER,
            injected: "must-not-persist",
          }) as unknown as typeof HEADER,
      }),
      open: (path, sessionDir) => handle(path, sessionDir ?? ""),
    };
    const host = createPiNativeSessionHost(sessionManager);

    const header = host
      .create("/repo", "/data/weave/sessions/child-1", {})
      .getHeader();

    expect(header).toBeNull();
  });

  test("recognizes only a host with both public constructors", () => {
    expect(isPiSessionManagerStatic({ create() {}, open() {} })).toBe(true);
    expect(isPiSessionManagerStatic({ create() {} })).toBe(false);
    expect(isPiSessionManagerStatic(undefined)).toBe(false);
  });
});
