/**
 * Opt-in real-host regression for the pinned preloader child seam.
 *
 * The default adapter suite keeps the repository's no-real-process contract.
 * Set WEAVE_PI_REAL_HOST_REGRESSION=1 to run this against an installed Pi.
 * The test records only handshake outcomes and closed failure codes.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { okAsync } from "neverthrow";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import {
  BunPiChildProcessPort,
  type PiChildProcessPort,
} from "../child-process-port.js";
import { resolveChildExtensionSpawnArgs } from "../pi-extension-inventory-port.js";
import { PiRpcChild } from "../rpc-child.js";
import type { JsonValue } from "../strict-json.js";
import { createTestOnlyGrantedSessionStorageAuthority } from "./fakes/test-only-session-storage-authority.js";

const runRealHostRegression = Bun.env.WEAVE_PI_REAL_HOST_REGRESSION === "1";
const realHostTest = runRealHostRegression ? it : it.skip;
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const PI_EXECUTABLE = Bun.env.WEAVE_PI_REAL_HOST_BIN ?? "pi";

const logger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function isolatedDirectory(root: string, name: string): string {
  return `${root}/${name}`;
}

async function removeDirectory(path: string): Promise<void> {
  await Bun.$`rm -rf ${path}`.quiet();
}

function observingProcessPort(observed: Set<string>): PiChildProcessPort {
  const inner = new BunPiChildProcessPort();
  return {
    spawn(input) {
      return inner.spawn(input).map((process) => {
        let buffered = "";
        const decoder = new TextDecoder();
        process.stdout.onData((chunk) => {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const value: unknown = JSON.parse(line);
              if (
                typeof value === "object" &&
                value !== null &&
                "kind" in value &&
                typeof value.kind === "string"
              ) {
                observed.add(value.kind);
              }
            } catch {
              // Pi also writes ordinary RPC records. They are not retained.
            }
          }
        });
        return process;
      });
    },
  };
}

async function waitForObserved(
  observed: ReadonlySet<string>,
  kind: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!observed.has(kind) && Date.now() < deadline) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return observed.has(kind);
}

async function runChild(input: {
  readonly extensionPath: string;
  readonly baseRoot: string;
  readonly fallbackChildExtensionPaths?: readonly string[];
}): Promise<string> {
  const emptyInventory = {
    entries: [],
    truncated: false,
    projectScanned: false,
  } as const;
  const store = {
    preferences: {
      get: () => okAsync(null),
    },
  } as unknown as Parameters<typeof resolveChildExtensionSpawnArgs>[0]["store"];
  const resolved = await resolveChildExtensionSpawnArgs({
    store,
    ...(input.fallbackChildExtensionPaths === undefined
      ? {}
      : { fallbackChildExtensionPaths: input.fallbackChildExtensionPaths }),
    collectInventory: () => okAsync(emptyInventory),
  });
  if (resolved.isErr()) return "resolution-failed";

  const authority = await createTestOnlyGrantedSessionStorageAuthority("/tmp");
  const agentDirectory = isolatedDirectory(input.baseRoot, "agent");
  const baseEnv: Record<string, string> = {
    PATH: Bun.env.PATH ?? "",
    HOME: Bun.env.HOME ?? "",
    USERPROFILE: Bun.env.USERPROFILE ?? Bun.env.HOME ?? "",
    BUN_INSTALL: Bun.env.BUN_INSTALL ?? `${Bun.env.HOME ?? ""}/.bun`,
    PI_CODING_AGENT_DIR: agentDirectory,
    XDG_CONFIG_HOME: isolatedDirectory(input.baseRoot, "config"),
    XDG_DATA_HOME: isolatedDirectory(input.baseRoot, "data"),
    XDG_CACHE_HOME: isolatedDirectory(input.baseRoot, "cache"),
    LANG: Bun.env.LANG ?? "C.UTF-8",
    LC_ALL: Bun.env.LC_ALL ?? "C.UTF-8",
    WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE: "1",
  };
  const observed = new Set<string>();
  const child = new PiRpcChild(
    "task11-child",
    "root",
    "task11-generation",
    "shuttle-mini",
    1,
    {
      processPort: observingProcessPort(observed),
      sessionStorageAuthority: authority,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      logger,
      command: [PI_EXECUTABLE, "--mode", "rpc"],
      resolveExtensionArgs: () => resolved.value.args,
      baseEnv,
      handshakeTimeoutMs: 1_500,
    },
  );
  try {
    const spawnInput = {
      childId: "task11-child",
      parentId: "root",
      generationId: "task11-generation",
      agentName: "shuttle-mini",
      depth: 1,
      cwd: REPO_ROOT,
      env: {},
      task: "x",
    } as const;
    const result = await child.spawnAndHandshake(spawnInput);
    if (result.isErr()) return result.error.code;
    if (input.fallbackChildExtensionPaths === undefined) return "handshake";
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));

    const bootstrap = {
      mode: "ordinary",
      agentName: "shuttle-mini",
      composedPrompt: "x",
      models: [],
      delegationTargets: [],
      correlationId: "task11-child",
      context: { parentAgentName: "root", parentDepth: 0, cwd: REPO_ROOT },
    } as JsonValue;
    const task = child.runTask(spawnInput, bootstrap);
    const ackObserved = await waitForObserved(observed, "bootstrap-ack", 4_000);
    child.dispose();
    await task;
    return ackObserved ? "bootstrap-ack" : "bootstrap-ack-missing";
  } finally {
    child.dispose();
  }
}

describe("pinned preloader child bootstrap on the real Pi host", () => {
  realHostTest(
    "fails without the parent extension argument, then handshakes with it",
    async () => {
      const baseRoot = `/tmp/weave-task11-real-host-${crypto.randomUUID()}`;
      const extensionPath = `${REPO_ROOT}/packages/adapters/pi/dist/extension.js`;
      await Bun.$`mkdir -p ${baseRoot}`.quiet();
      try {
        const missing = await runChild({ extensionPath, baseRoot });
        expect(missing).toBe("ChildHandshakeMissing");

        const recovered = await runChild({
          extensionPath,
          baseRoot,
          fallbackChildExtensionPaths: [extensionPath],
        });
        expect(recovered).toBe("bootstrap-ack");
      } finally {
        await removeDirectory(baseRoot);
      }
    },
    10_000,
  );
});
