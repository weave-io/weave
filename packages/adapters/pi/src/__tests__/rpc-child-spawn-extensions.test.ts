import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { PiDelegationController } from "../delegation-controller.js";
import { createDirectDispatchTransport } from "../direct-dispatch-transport.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { FakeIdGenerator } from "./fakes/fake-pi-host.js";
import {
  createTestOnlyGrantedSessionStorageAuthority,
  mintTestOnlyLaunchGrant,
} from "./fakes/test-only-session-storage-authority.js";

/**
 * Task 11 contract: the child-extension selection reaches `pi` argv, or the
 * spawn fails - it is never silently dropped, and it never changes argv for a
 * host that has no stored selection.
 */

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();

const AUTHORITY = await createTestOnlyGrantedSessionStorageAuthority("/tmp");
const SESSION_DIR = "/tmp/weave-sessions";
const SESSION_PATH = `${SESSION_DIR}/child-1.jsonl`;

const WEAVE_PATH = "/opt/weave/packages/adapters/pi/dist/extension.js";
const OTHER_PATH = "/home/user/.pi/agent/extensions/pi-vim/index.ts";

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function spawnInput(
  overrides: Partial<PiRpcChildSpawnInput> = {},
): PiRpcChildSpawnInput {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "gen-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/project",
    env: {},
    task: "do the thing",
    ...overrides,
  };
}

function nativeSession(): NonNullable<PiRpcChildSpawnInput["session"]> {
  return {
    mode: "native",
    grant: mintTestOnlyLaunchGrant(AUTHORITY, {
      childId: "child-1",
      sessionDir: SESSION_DIR,
      sessionPath: SESSION_PATH,
      activeLeafId: "leaf-1",
    }),
  };
}

function makeChild(
  processPort: FakeChildProcessPort,
  resolveExtensionArgs?: () => readonly string[],
): PiRpcChild {
  return new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
    processPort,
    sessionStorageAuthority: AUTHORITY,
    randomPort,
    hmacPort,
    logger: noopLogger(),
    ...(resolveExtensionArgs === undefined ? {} : { resolveExtensionArgs }),
  });
}

/** Spawns, captures argv, then disposes so no child is left hanging. */
async function captureSpawnCommand(
  resolveExtensionArgs?: () => readonly string[],
  session?: PiRpcChildSpawnInput["session"],
): Promise<readonly string[] | undefined> {
  const processPort = new FakeChildProcessPort();
  const child = makeChild(processPort, resolveExtensionArgs);
  const pending = child.spawnAndHandshake(
    spawnInput(session === undefined ? {} : { session }),
  );
  await Promise.resolve();
  await Promise.resolve();
  const command = processPort.spawnInputs[0]?.command;
  // The scripted process never completes a handshake; disposing settles the
  // pending launch so no timer or resolver outlives the test.
  child.dispose();
  await pending;
  return command;
}

/**
 * A rejected argument list fails before any process exists, so nothing needs
 * disposing and the failure is observable on its own.
 */
async function expectSpawnRefused(
  resolveExtensionArgs: () => readonly string[],
): Promise<void> {
  const processPort = new FakeChildProcessPort();
  const child = makeChild(processPort, resolveExtensionArgs);
  const result = await child.spawnAndHandshake(spawnInput());
  // The existing typed spawn failure, never a silent drop of the arguments.
  expect(result.isErr() && result.error.code).toBe("ChildSpawnFailed");
  expect(processPort.spawnInputs).toHaveLength(0);
}

describe("child extension arguments in spawn argv", () => {
  it("keeps argv byte-identical to today when no provider is supplied", async () => {
    expect(await captureSpawnCommand()).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--no-session",
    ]);
  });

  it("keeps argv byte-identical when the inherit-all provider returns nothing", async () => {
    const ephemeral = await captureSpawnCommand(() => []);
    expect(ephemeral).toEqual(["pi", "--mode", "rpc", "--no-session"]);

    const native = await captureSpawnCommand(() => [], nativeSession());
    expect(native).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--session-dir",
      SESSION_DIR,
      "--session",
      SESSION_PATH,
    ]);
  });

  it("emits --no-extensions and one -e per selected extension, Weave first, before the session flags", async () => {
    const args = ["--no-extensions", "-e", WEAVE_PATH, "-e", OTHER_PATH];
    const ephemeral = await captureSpawnCommand(() => args);
    expect(ephemeral).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      OTHER_PATH,
      "--no-session",
    ]);

    const native = await captureSpawnCommand(() => args, nativeSession());
    expect(native).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      OTHER_PATH,
      "--session-dir",
      SESSION_DIR,
      "--session",
      SESSION_PATH,
    ]);
  });

  it("evaluates the provider on every spawn, never once at construction", async () => {
    let calls = 0;
    const processPort = new FakeChildProcessPort();
    const child = makeChild(processPort, () => {
      calls += 1;
      return [];
    });
    expect(calls).toBe(0);
    const pending = child.spawnAndHandshake(spawnInput());
    await Promise.resolve();
    expect(calls).toBe(1);
    child.dispose();
    await pending;
  });

  it("fails closed on every malformed provider result instead of dropping arguments", async () => {
    const longPath = `/opt/${"a".repeat(600)}/extension.js`;
    const tooMany = [
      "--no-extensions",
      ...Array.from({ length: 66 }, (_, index) => [
        "-e",
        `/opt/weave/ext-${index}.js`,
      ]).flat(),
    ];
    const rejected: readonly (readonly string[])[] = [
      // Missing the leading --no-extensions.
      ["-e", WEAVE_PATH],
      // --no-extensions with no extension at all would drop Weave itself.
      ["--no-extensions"],
      // Trailing flag with no value.
      ["--no-extensions", "-e", WEAVE_PATH, "-e"],
      // Unknown flag in a pair position.
      ["--no-extensions", "--extension", WEAVE_PATH],
      // npm specs install into a per-child temporary directory.
      ["--no-extensions", "-e", "npm:pi-vim"],
      // Relative path.
      ["--no-extensions", "-e", "dist/extension.js"],
      // Traversal component.
      ["--no-extensions", "-e", "/opt/weave/../weave/extension.js"],
      // Backslash.
      ["--no-extensions", "-e", "/opt/weave\\extension.js"],
      // NUL.
      ["--no-extensions", "-e", "/opt/weave/extension.js\0"],
      // Session flags may only ever come from this transport.
      ["--no-extensions", "-e", WEAVE_PATH, "--no-session"],
      ["--session-dir", SESSION_DIR],
      // Duplicate path.
      ["--no-extensions", "-e", WEAVE_PATH, "-e", WEAVE_PATH],
      // Over the per-path byte bound.
      ["--no-extensions", "-e", longPath],
      // Over the 65-path bound (Weave plus 64 optional entries).
      tooMany,
      // Non-string element from an untyped caller.
      ["--no-extensions", "-e", 7 as unknown as string],
    ];

    for (const args of rejected) {
      await expectSpawnRefused(() => args);
    }
  });

  it("accepts exactly the 65-path bound", async () => {
    const atBound = [
      "--no-extensions",
      ...Array.from({ length: 65 }, (_, index) => [
        "-e",
        `/opt/weave/ext-${index}.js`,
      ]).flat(),
    ];
    expect(await captureSpawnCommand(() => atBound)).toEqual([
      "pi",
      "--mode",
      "rpc",
      ...atBound,
      "--no-session",
    ]);
  });

  it("fails closed when the provider itself throws", async () => {
    await expectSpawnRefused(() => {
      throw new Error("provider exploded");
    });
  });

  it("applies the provider on the ordinary delegation spawn path", async () => {
    const processPort = new FakeChildProcessPort();
    const parsed = parseConfig("agent shuttle {\n}\n");
    if (parsed.isErr()) throw new Error("test setup: config did not parse");
    const controller = new PiDelegationController({
      config: parsed.value,
      generationId: "gen-1",
      idGenerator: new FakeIdGenerator(),
      logger: noopLogger(),
      processPort,
      sessionStorageAuthority: AUTHORITY,
      randomPort,
      hmacPort,
      handshakeTimeoutMs: 10,
      cancelGraceMs: 10,
      resolveExtensionArgs: () => ["--no-extensions", "-e", WEAVE_PATH],
    });

    const settled = controller.delegate({
      parentId: "root",
      parentDepth: 0,
      parentAgentName: "shuttle",
      agentName: "shuttle",
      task: "do the thing",
      cwd: "/project",
      env: {},
      bootstrap: {
        mode: "ordinary",
        agentName: "shuttle",
        composedPrompt: "You are Shuttle.",
        models: [],
        correlationId: "child-1",
        context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
      },
    });
    await processPort.spawnCalled;
    expect(processPort.spawnInputs[0]?.command).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "--no-session",
    ]);
    controller.disposeAll();
    await settled;
  });

  it("applies the provider on the direct-dispatch spawn path", async () => {
    const processPort = new FakeChildProcessPort();
    const transport = createDirectDispatchTransport(
      {
        processPort,
        sessionStorageAuthority: AUTHORITY,
        randomPort,
        hmacPort,
        logger: noopLogger(),
        idGenerator: new FakeIdGenerator(),
        handshakeTimeoutMs: 10,
        resolveExtensionArgs: () => ["--no-extensions", "-e", WEAVE_PATH],
      },
      "gen-1",
    );

    const dispatched = transport({
      workflowInstanceId: "wf-1",
      leaseId: "lease-1",
      stepName: "verify",
      agentName: "smoke-child",
      composedPrompt: "You are the workflow step agent.",
      taskPrompt: "Call weave_complete_step exactly once.",
      cwd: "/project",
      correlationId: "engine-effect-correlation-unrelated",
      models: [],
      delegationTargets: [],
    });
    await processPort.spawnCalled;
    expect(processPort.spawnInputs[0]?.command).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "--no-session",
    ]);
    await dispatched;
  });

  it("still rejects a base command carrying a session flag", async () => {
    const processPort = new FakeChildProcessPort();
    const child = new PiRpcChild("child-1", "root", "gen-1", "shuttle", 1, {
      processPort,
      sessionStorageAuthority: AUTHORITY,
      randomPort,
      hmacPort,
      logger: noopLogger(),
      command: ["pi", "--mode", "rpc", "--resume=latest"],
      resolveExtensionArgs: () => ["--no-extensions", "-e", WEAVE_PATH],
    });
    const result = await child.spawnAndHandshake(spawnInput());
    expect(result.isErr()).toBe(true);
    expect(processPort.spawnInputs).toHaveLength(0);
  });
});
