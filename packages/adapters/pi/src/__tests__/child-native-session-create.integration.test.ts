/**
 * Real Pi 0.83 SessionManager + Bun no-follow FS integration for Task 20
 * header persistence before spawn. Does not start a Pi TUI or child process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { $ } from "bun";
import { join } from "node:path";
import {
  PI_NATIVE_THREAD_ENTRY_TYPE,
  PiNativeSessionStore,
} from "../child-native-sessions.js";
import { createBunPiNativeSessionFs } from "../native-session-fs.js";
import { createPiNativeSessionHost } from "../native-session-host.js";

const PARENT = "parent-session-integration-1";

describe("PiNativeSessionStore.createChildSession — Pi 0.83 SessionManager", () => {
  let root: string;

  beforeEach(async () => {
    root = (await $`mktemp -d /private/tmp/weave-ns-create-XXXXXX`.quiet())
      .text()
      .trim();
  });

  afterEach(async () => {
    await $`rm -rf ${root}`.quiet();
  });

  test("persists host header, reopens, and appends thread metadata durably", async () => {
    const fs = createBunPiNativeSessionFs();
    const host = createPiNativeSessionHost(SessionManager);
    const store = new PiNativeSessionStore({ root, fs, host });

    const created = await store.createChildSession({
      childId: "child-1",
      parentSession: PARENT,
      cwd: root,
    });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) throw new Error(JSON.stringify(created.error));

    const record = created.value;
    expect(record.parentSession).toBe(PARENT);
    expect(record.path.startsWith(`${root}/child-1/`)).toBe(true);

    const file = Bun.file(record.path);
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBe(1);
    const header = JSON.parse(lines[0] ?? "{}") as {
      type?: string;
      version?: number;
      id?: string;
      cwd?: string;
      timestamp?: string;
      parentSession?: string;
      role?: string;
    };
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
    expect(header.id).toBe(record.sessionId);
    expect(header.cwd).toBe(root);
    expect(header.parentSession).toBe(PARENT);
    expect(typeof header.timestamp).toBe("string");
    expect(header.role).toBeUndefined();
    expect(text).not.toMatch(/"role"\s*:\s*"assistant"/);

    const leaf = await store.establishThreadLeaf(
      record.ref,
      {
        threadId: "thread-1",
        agentName: "shuttle-mini",
        parentId: "parent-1",
        parentAgentName: "loom",
        parentDepth: 0,
        ownerParentSessionId: PARENT,
        cwd: root,
        createdAt: 1_700_000_000_000,
      },
      PARENT,
    );
    expect(leaf.isOk()).toBe(true);
    if (leaf.isErr()) throw new Error(JSON.stringify(leaf.error));
    expect(leaf.value.leafId.length).toBeGreaterThan(0);

    const after = await Bun.file(record.path).text();
    const afterLines = after.trimEnd().split("\n");
    expect(afterLines.length).toBe(2);
    const custom = JSON.parse(afterLines[1] ?? "{}") as {
      type?: string;
      customType?: string;
      data?: { threadId?: string };
    };
    expect(custom.type).toBe("custom");
    expect(custom.customType).toBe(PI_NATIVE_THREAD_ENTRY_TYPE);
    expect(custom.data?.threadId).toBe("thread-1");

    const reopened = SessionManager.open(
      record.path,
      join(root, "child-1"),
    );
    expect(reopened.getHeader()?.id).toBe(record.sessionId);
    expect(reopened.getHeader()?.parentSession).toBe(PARENT);
    const entries = reopened.getEntries();
    expect(entries).toHaveLength(1);
    expect(
      (entries[0] as { customType?: string }).customType,
    ).toBe(PI_NATIVE_THREAD_ENTRY_TYPE);
  });

  test("refuses to invent an assistant entry when the host has not flushed", async () => {
    const created = SessionManager.create(root, join(root, "raw"), {
      parentSession: PARENT,
    });
    expect(created.isPersisted()).toBe(true);
    const path = created.getSessionFile();
    expect(path).toBeDefined();
    expect(await Bun.file(path as string).exists()).toBe(false);

    const fs = createBunPiNativeSessionFs();
    const host = createPiNativeSessionHost(SessionManager);
    const store = new PiNativeSessionStore({
      root,
      fs,
      host,
    });
    const result = await store.createChildSession({
      childId: "child-2",
      parentSession: PARENT,
      cwd: root,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error(JSON.stringify(result.error));
    const body = await Bun.file(result.value.path).text();
    expect(body.trimEnd().split("\n")).toHaveLength(1);
    expect(body).not.toMatch(/assistant/);
  });
});
