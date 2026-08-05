/**
 * Production factory for `weave adapter pi …` XDG-rooted ports.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  createProductionPiAdapterCommandRegistry,
  openProductionPiAdapterCommandPorts,
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
} from "../index.js";
import type { PiSessionManagerStatic } from "../native-session-host.js";

function fakeSessionManager(): PiSessionManagerStatic {
  return {
    create() {
      throw new Error("create unused in list/doctor smoke");
    },
    open() {
      throw new Error("open unused in list/doctor smoke");
    },
  };
}

async function tempXdg(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "weave-pi-cli-prod-"));
  const resolved = await $`realpath ${base}`.quiet();
  return resolved.text().trim();
}

describe("openProductionPiAdapterCommandPorts", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("opens XDG-rooted ports and lists an empty workspace page", async () => {
    const xdg = await tempXdg();
    dirs.push(xdg);
    const opened = await openProductionPiAdapterCommandPorts({
      workspaceKey: "/tmp/weave-workspace",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
    });
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    expect(opened.value.cacheMode).toBe("active");
    const listed = await opened.value.children.list({
      workspaceKey: "/tmp/weave-workspace",
      includeTombstoned: true,
    });
    expect(listed._unsafeUnwrap().children).toEqual([]);
    const doctor = await opened.value.doctor.run({});
    expect(doctor._unsafeUnwrap().kind).toBe("doctor");
  });

  it("builds a dispatchable production registry", async () => {
    const xdg = await tempXdg();
    dirs.push(xdg);
    const registry = await createProductionPiAdapterCommandRegistry({
      workspaceKey: "/tmp/weave-workspace",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
    });
    expect(registry.isOk()).toBe(true);
    if (registry.isErr()) return;
    expect(registry.value.get(PI_ADAPTER_NAME)).toBeDefined();
    expect(
      registry.value
        .get(PI_ADAPTER_NAME)
        ?.get(PI_ADAPTER_COMMAND_NAMES.childrenList),
    ).toBeTypeOf("function");
  });

  it("fails closed on a relative XDG data home", async () => {
    const opened = await openProductionPiAdapterCommandPorts({
      workspaceKey: "/tmp/weave-workspace",
      env: { XDG_DATA_HOME: "relative-xdg", HOME: "/tmp" },
      SessionManager: fakeSessionManager(),
    });
    expect(opened.isErr()).toBe(true);
    if (opened.isOk()) return;
    expect(opened.error.type).toBe("SessionRootUnavailable");
  });
});
