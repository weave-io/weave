import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import {
  generateNonceHex,
  hexToBytes,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { WEAVE_CHILD_SECRET_ENV } from "../child-env.js";
import { signEnvelope } from "../child-envelope.js";
import {
  deriveChildExtensionFallbackPaths,
  resolveChildExtensionSpawnArgs,
} from "../pi-extension-inventory-port.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { createTestOnlyGrantedSessionStorageAuthority } from "./fakes/test-only-session-storage-authority.js";

/**
 * The pinned-child bootstrap seam is adapter-tested with modelled ports only.
 * The real Pi process and filesystem proof lives under scripts/pi.
 */

const AUTHORITY = await createTestOnlyGrantedSessionStorageAuthority("/tmp");
const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();
const WEAVE_PATH = "/opt/weave/packages/adapters/pi/dist/extension.js";
const PROVIDER_PATH = "/opt/pi/providers/openai-codex.js";
const BASE_COMMAND = ["pi", "--mode", "rpc"] as const;

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function spawnInput(
  overrides: Partial<PiRpcChildSpawnInput> = {},
): PiRpcChildSpawnInput {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "generation-1",
    agentName: "shuttle-mini",
    depth: 1,
    cwd: "/project",
    env: {},
    task: "do the thing",
    ...overrides,
  };
}

function emptyInventory() {
  return {
    entries: [],
    truncated: false,
    projectScanned: false,
  } as const;
}

async function resolvePinnedArgs(
  fallbackChildExtensionPaths?: readonly string[],
): Promise<readonly string[]> {
  const resolved = await resolveChildExtensionSpawnArgs({
    store: {
      preferences: {
        get: () => okAsync(null),
      },
    } as unknown as Parameters<
      typeof resolveChildExtensionSpawnArgs
    >[0]["store"],
    ...(fallbackChildExtensionPaths === undefined
      ? {}
      : { fallbackChildExtensionPaths }),
    // This is an injected inventory port. The inherit-all fallback must not
    // consult it, but keeping it here proves the whole resolution boundary is
    // host-independent.
    collectInventory: () => okAsync(emptyInventory()),
  });
  expect(resolved.isOk()).toBe(true);
  return resolved._unsafeUnwrap().args;
}

function child(
  processPort: FakeChildProcessPort,
  resolveExtensionArgs: () => readonly string[],
  timerPort: {
    schedule(callback: () => void, delayMs: number): { cancel(): void };
  },
): PiRpcChild {
  return new PiRpcChild("child-1", "root", "generation-1", "shuttle-mini", 1, {
    processPort,
    sessionStorageAuthority: AUTHORITY,
    randomPort,
    hmacPort,
    logger: logger(),
    command: BASE_COMMAND,
    resolveExtensionArgs,
    timerPort,
  });
}

function secretFromSpawn(processPort: FakeChildProcessPort): Uint8Array {
  const encoded = processPort.spawnInputs[0]?.env[WEAVE_CHILD_SECRET_ENV];
  expect(encoded).toBeDefined();
  const secret = hexToBytes(encoded ?? "");
  expect(secret).toBeDefined();
  return secret ?? new Uint8Array();
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("pinned child bootstrap adapter seam", () => {
  it("keeps the pinned entry first and drops unsafe provider paths", () => {
    const fallback = deriveChildExtensionFallbackPaths(
      [
        ...BASE_COMMAND,
        "--no-extensions",
        "-e",
        PROVIDER_PATH,
        "-e",
        WEAVE_PATH,
        "-e",
        "relative/provider.js",
        "-e",
        "/opt/pi/../escaped.js",
        "-e",
        PROVIDER_PATH,
      ],
      WEAVE_PATH,
    );

    expect(fallback).toEqual([WEAVE_PATH, PROVIDER_PATH]);
  });

  it("propagates safe pinned argv in order and maps an authenticated handshake", async () => {
    const fallback = deriveChildExtensionFallbackPaths(
      [
        ...BASE_COMMAND,
        "--no-extensions",
        "-e",
        PROVIDER_PATH,
        "-e",
        WEAVE_PATH,
        "-e",
        "relative/provider.js",
      ],
      WEAVE_PATH,
    );
    const extensionArgs = await resolvePinnedArgs(fallback);
    expect(extensionArgs).toEqual([
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      PROVIDER_PATH,
    ]);

    const processPort = new FakeChildProcessPort();
    const childProcess = child(processPort, () => extensionArgs, {
      schedule: () => ({ cancel() {} }),
    });
    const pending = childProcess.spawnAndHandshake(spawnInput());
    await flush();

    expect(processPort.spawnInputs[0]?.command).toEqual([
      ...BASE_COMMAND,
      "--no-extensions",
      "-e",
      WEAVE_PATH,
      "-e",
      PROVIDER_PATH,
      "--no-session",
    ]);

    const spawned = processPort.spawnedProcesses[0];
    expect(spawned).toBeDefined();
    const secret = secretFromSpawn(processPort);
    const envelope = await signEnvelope(
      {
        childId: "child-1",
        generationId: "generation-1",
        direction: "child-to-parent",
        sequence: 1,
        nonce: generateNonceHex(randomPort),
        correlationId: "child-1",
        kind: "handshake",
        body: {},
      },
      secret,
      hmacPort,
    );
    expect(envelope.isOk()).toBe(true);
    spawned?.emitLine(envelope._unsafeUnwrap());

    const result = await pending;
    expect(result.isOk()).toBe(true);
    childProcess.dispose();
  });

  it("maps a missing mocked handshake to the closed RED failure", async () => {
    const processPort = new FakeChildProcessPort();
    let handshakeTimeout: (() => void) | undefined;
    const childProcess = child(processPort, () => [], {
      schedule(callback) {
        handshakeTimeout = callback;
        return { cancel() {} };
      },
    });
    const pending = childProcess.spawnAndHandshake(spawnInput());
    await flush();
    expect(processPort.spawnInputs[0]?.command).toEqual([
      ...BASE_COMMAND,
      "--no-session",
    ]);

    handshakeTimeout?.();
    const result = await pending;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ChildHandshakeMissing");
    childProcess.dispose();
  });
});
