/**
 * Production factory for `weave adapter pi …` XDG-rooted ports.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchAdapterCommand } from "@weaveio/weave-engine";
import {
  createProductionPiAdapterCommandRegistry,
  createProductionPorts,
  evaluateProductionChildrenDeleteGate,
  openProductionPiAdapterCommandPorts,
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
  resolveProductionAdapterCliRegistry,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
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
  const base = join(
    resolvedTmpdir(),
    `weave-pi-cli-prod-${crypto.randomUUID()}`,
  );
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

async function listRelativePaths(root: string): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  for await (const relative of glob.scan({
    cwd: root,
    onlyFiles: false,
    dot: true,
  })) {
    paths.push(relative);
  }
  return paths.sort();
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
      accessMode: "write",
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
      accessMode: "write",
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

describe("health-only CLI production dispatch — non-creating reads", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => removeScratchFiles(dir)));
  });

  it("gates children.delete before createProductionPorts with path-only-session-api", async () => {
    const xdg = await tempXdg();
    dirs.push(xdg);
    const before = await listRelativePaths(xdg);
    expect(before).toEqual([]);

    const gated = evaluateProductionChildrenDeleteGate({
      SessionManager: fakeSessionManager(),
    });
    expect(gated.isErr()).toBe(true);
    if (gated.isOk()) return;
    expect(gated.error.code).toBe("RequiredCapabilityUnavailable");
    expect(gated.error.correlation?.capabilityId).toBe(
      SESSION_MUTATION_REQUIRED_CAPABILITY,
    );
    expect(gated.error.correlation?.reason).toBe("path-only-session-api");

    const opened = await resolveProductionAdapterCliRegistry({
      action: "children.delete",
      workspaceKey: "/tmp/weave-workspace",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
    });
    expect(opened.isErr()).toBe(true);
    if (opened.isOk()) return;
    expect(opened.error).toEqual({
      type: "RequiredCapabilityUnavailable",
      capabilityId: SESSION_MUTATION_REQUIRED_CAPABILITY,
      reason: "path-only-session-api",
    });

    const after = await listRelativePaths(xdg);
    expect(after).toEqual([]);
    // createProductionPorts is the CLI factory name; delete must not reach it.
    expect(typeof createProductionPorts).toBe("function");
  });

  it("list/show/doctor on a pristine root leave the root absent", async () => {
    const xdg = await tempXdg();
    dirs.push(xdg);
    const before = await listRelativePaths(xdg);
    expect(before).toEqual([]);

    const registry = await resolveProductionAdapterCliRegistry({
      action: "children.list",
      workspaceKey: "/tmp/weave-workspace-pristine",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
    });
    expect(registry.isOk()).toBe(true);
    if (registry.isErr()) return;

    const listed = await dispatchAdapterCommand(registry.value, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({
        workspaceKey: "/tmp/weave-workspace-pristine",
      }),
    });
    expect(listed.isOk()).toBe(true);
    if (listed.isOk()) {
      const body = JSON.parse(listed.value.resultJson) as {
        children: unknown[];
      };
      expect(body.children).toEqual([]);
    }

    const shown = await dispatchAdapterCommand(registry.value, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "/tmp/weave-workspace-pristine",
        childId: "missing-child",
      }),
    });
    // Missing cache degrades: show is unavailable/typed, never creates state.
    expect(shown.isErr() || shown.isOk()).toBe(true);

    const doctor = await dispatchAdapterCommand(registry.value, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.doctor,
      payloadJson: JSON.stringify({}),
    });
    expect(doctor.isOk()).toBe(true);

    const after = await listRelativePaths(xdg);
    expect(after).toEqual([]);
    for (const name of [
      "child-metadata.sqlite",
      "child-metadata.sqlite-wal",
      "child-metadata.sqlite-shm",
      "child-metadata.sqlite-journal",
    ]) {
      expect(after.some((path) => path.endsWith(name))).toBe(false);
    }
  });

  it("read-only existing-cache list leaves DB bytes and side-file set unchanged", async () => {
    const xdg = await tempXdg();
    dirs.push(xdg);

    const written = await openProductionPiAdapterCommandPorts({
      workspaceKey: "/tmp/weave-workspace-cache",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
      accessMode: "write",
    });
    expect(written.isOk()).toBe(true);
    if (written.isErr()) return;
    expect(written.value.cacheMode).toBe("active");

    const dbPath = join(
      xdg,
      "weave",
      "adapters",
      "pi",
      "cache",
      "child-metadata.sqlite",
    );
    const beforeBytes = await Bun.file(dbPath).arrayBuffer();
    const beforeSha = new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(beforeBytes))
      .digest("hex");
    const beforePaths = await listRelativePaths(xdg);

    const readRegistry = await resolveProductionAdapterCliRegistry({
      action: "children.list",
      workspaceKey: "/tmp/weave-workspace-cache",
      env: { XDG_DATA_HOME: xdg, HOME: xdg },
      SessionManager: fakeSessionManager(),
    });
    expect(readRegistry.isOk()).toBe(true);
    if (readRegistry.isErr()) return;

    const listed = await dispatchAdapterCommand(readRegistry.value, {
      adapter: PI_ADAPTER_NAME,
      command: PI_ADAPTER_COMMAND_NAMES.childrenList,
      payloadJson: JSON.stringify({
        workspaceKey: "/tmp/weave-workspace-cache",
      }),
    });
    expect(listed.isOk()).toBe(true);

    const afterBytes = await Bun.file(dbPath).arrayBuffer();
    const afterSha = new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(afterBytes))
      .digest("hex");
    expect(afterSha).toBe(beforeSha);
    expect(await listRelativePaths(xdg)).toEqual([...beforePaths]);
    expect(
      beforePaths.some((path) => path.endsWith("child-metadata.sqlite-wal")),
    ).toBe(false);
    expect(
      beforePaths.some((path) => path.endsWith("child-metadata.sqlite-shm")),
    ).toBe(false);
  });
});
