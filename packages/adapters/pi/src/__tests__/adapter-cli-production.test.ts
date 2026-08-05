/**
 * Production factory for `weave adapter pi …` XDG-rooted ports.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * macOS temp dirs live behind `/var` → `/private/var`. The production
 * openat(O_NOFOLLOW) chain refuses that symlink, so scratch roots must start
 * on the resolved path. Prefixed without shelling out to `realpath`.
 */
function resolvedTmpdir(): string {
  const root = tmpdir();
  return root.startsWith("/var/") ? `/private${root}` : root;
}

async function tempXdg(): Promise<string> {
  const base = join(resolvedTmpdir(), `weave-pi-cli-prod-${crypto.randomUUID()}`);
  // Bun.write creates parent directories; no node:fs mkdtemp.
  await Bun.write(join(base, ".keep"), "");
  await Bun.file(join(base, ".keep")).delete();
  return base;
}

/** Delete files under a scratch tree with Bun.file (directories may remain). */
async function removeScratchFiles(root: string): Promise<void> {
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];
  for await (const relative of glob.scan({
    cwd: root,
    onlyFiles: true,
    dot: true,
  })) {
    files.push(join(root, relative));
  }
  await Promise.all(files.map((path) => Bun.file(path).delete()));
}

describe("openProductionPiAdapterCommandPorts", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => removeScratchFiles(dir)));
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
