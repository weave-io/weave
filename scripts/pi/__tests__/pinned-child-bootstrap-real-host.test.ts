/**
 * Opt-in real-host proof for the pinned preloader child seam.
 *
 * The adapter suite uses only mocked process, filesystem, and inventory ports.
 * Set WEAVE_PI_REAL_HOST_REGRESSION=1 to run this against an installed Pi.
 * The test records only closed handshake outcomes and never retains child
 * content. All temporary-tree cleanup uses the live-proof bounded filesystem
 * port.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { okAsync } from "neverthrow";
import { createTestOnlyGrantedSessionStorageAuthority } from "../../../packages/adapters/pi/src/__tests__/fakes/test-only-session-storage-authority.js";
import {
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../../../packages/adapters/pi/src/child-crypto.js";
import {
  BunPiChildProcessPort,
  type PiChildProcessPort,
  type PiSpawnedChildProcess,
} from "../../../packages/adapters/pi/src/child-process-port.js";
import { resolveChildExtensionSpawnArgs } from "../../../packages/adapters/pi/src/pi-extension-inventory-port.js";
import { PiRpcChild } from "../../../packages/adapters/pi/src/rpc-child.js";
import type { JsonValue } from "../../../packages/adapters/pi/src/strict-json.js";
import {
  createLiveProofSystem,
  type LiveProofSystem,
  workspacePath,
} from "../child-stream-live-proof-system.js";

const runRealHostRegression = Bun.env.WEAVE_PI_REAL_HOST_REGRESSION === "1";
const realHostTest = runRealHostRegression ? it : it.skip;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PI_EXECUTABLE = Bun.env.WEAVE_PI_REAL_HOST_BIN ?? "pi";

const logger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

type ChildProofOutcome =
  | "ChildHandshakeMissing"
  | "bootstrap-ack"
  | "bootstrap-ack-missing"
  | "cleanup-failed"
  | "resolution-failed"
  | "setup-failed"
  | "spawn-failed";

interface ObservedProcess {
  process: PiSpawnedChildProcess | undefined;
}

function isolatedDirectory(root: string, name: string): string {
  return `${root}/${name}`;
}

function observingProcessPort(
  observed: Set<string>,
  state: ObservedProcess,
): PiChildProcessPort {
  const inner = new BunPiChildProcessPort();
  return {
    spawn(input) {
      return inner.spawn(input).map((process) => {
        state.process = process;
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
                value.kind === "bootstrap-ack"
              ) {
                observed.add("bootstrap-ack");
              }
            } catch {
              // Ordinary Pi RPC records are not retained by this proof.
            }
          }
        });
        return process;
      });
    },
  };
}

async function waitForObserved(
  system: LiveProofSystem,
  observed: ReadonlySet<string>,
  kind: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!observed.has(kind) && Date.now() < deadline) {
    const delayed = await system.delay(10);
    if (delayed.isErr()) return false;
  }
  return observed.has(kind);
}

async function waitForProcessExit(
  system: LiveProofSystem,
  process: PiSpawnedChildProcess | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (process === undefined) return true;
  return Promise.race([
    process.exited.then(
      () => true,
      () => false,
    ),
    system.delay(timeoutMs).match(
      () => false,
      () => false,
    ),
  ]);
}

async function resolveChildArgs(
  fallbackChildExtensionPaths: readonly string[] | undefined,
): Promise<readonly string[] | undefined> {
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
    ...(fallbackChildExtensionPaths === undefined
      ? {}
      : { fallbackChildExtensionPaths }),
    collectInventory: () => okAsync(emptyInventory),
  });
  return resolved.isOk() ? resolved.value.args : undefined;
}

async function runChild(input: {
  readonly fallbackChildExtensionPaths?: readonly string[];
  readonly system: LiveProofSystem;
}): Promise<ChildProofOutcome> {
  const extensionArgs = await resolveChildArgs(
    input.fallbackChildExtensionPaths,
  );
  if (extensionArgs === undefined) return "resolution-failed";

  const baseRoot = workspacePath(
    input.system.temporaryRoot(),
    `weave-task11-real-host-${input.system.uniqueToken()}`,
  );
  const made = await input.system.makeDirectory(baseRoot);
  if (made.isErr()) return "setup-failed";

  const authority = await createTestOnlyGrantedSessionStorageAuthority("/tmp");
  const agentDirectory = isolatedDirectory(baseRoot, "agent");
  const baseEnv: Record<string, string> = {
    PATH: Bun.env.PATH ?? "",
    HOME: Bun.env.HOME ?? "",
    USERPROFILE: Bun.env.USERPROFILE ?? Bun.env.HOME ?? "",
    BUN_INSTALL: Bun.env.BUN_INSTALL ?? `${Bun.env.HOME ?? ""}/.bun`,
    PI_CODING_AGENT_DIR: agentDirectory,
    XDG_CONFIG_HOME: isolatedDirectory(baseRoot, "config"),
    XDG_DATA_HOME: isolatedDirectory(baseRoot, "data"),
    XDG_CACHE_HOME: isolatedDirectory(baseRoot, "cache"),
    LANG: Bun.env.LANG ?? "C.UTF-8",
    LC_ALL: Bun.env.LC_ALL ?? "C.UTF-8",
    WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE: "1",
  };
  const observed = new Set<string>();
  const observedProcess: ObservedProcess = { process: undefined };
  const child = new PiRpcChild(
    "task11-child",
    "root",
    "task11-generation",
    "shuttle-mini",
    1,
    {
      processPort: observingProcessPort(observed, observedProcess),
      sessionStorageAuthority: authority,
      randomPort: new WebCryptoRandomPort(),
      hmacPort: new WebCryptoHmacPort(),
      logger,
      command: [PI_EXECUTABLE, "--mode", "rpc"],
      resolveExtensionArgs: () => extensionArgs,
      baseEnv,
      handshakeTimeoutMs: 1_500,
    },
  );
  let outcome: ChildProofOutcome = "spawn-failed";
  let task: ReturnType<PiRpcChild["runTask"]> | undefined;
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
    if (result.isErr()) {
      outcome =
        result.error.code === "ChildHandshakeMissing"
          ? "ChildHandshakeMissing"
          : "spawn-failed";
    } else if (input.fallbackChildExtensionPaths !== undefined) {
      const bootstrap = {
        mode: "ordinary",
        agentName: "shuttle-mini",
        composedPrompt: "x",
        models: [],
        delegationTargets: [],
        correlationId: "task11-child",
        context: { parentAgentName: "root", parentDepth: 0, cwd: REPO_ROOT },
      } as JsonValue;
      task = child.runTask(spawnInput, bootstrap);
      const ackObserved = await waitForObserved(
        input.system,
        observed,
        "bootstrap-ack",
        4_000,
      );
      outcome = ackObserved ? "bootstrap-ack" : "bootstrap-ack-missing";
    }
  } finally {
    child.dispose();
    if (task !== undefined) await task;
    if (
      !(await waitForProcessExit(input.system, observedProcess.process, 2_000))
    ) {
      outcome = "cleanup-failed";
    }
    const removed = await input.system.removePath(baseRoot);
    if (removed.isErr()) outcome = "cleanup-failed";
  }
  return outcome;
}

describe("pinned preloader child bootstrap on the real Pi host", () => {
  realHostTest(
    "reports missing args RED and a pinned bootstrap ack green",
    async () => {
      const system = createLiveProofSystem();
      const extensionPath = `${REPO_ROOT}/packages/adapters/pi/dist/extension.js`;

      const missing = await runChild({ system });
      expect(missing).toBe("ChildHandshakeMissing");

      const recovered = await runChild({
        system,
        fallbackChildExtensionPaths: [extensionPath],
      });
      expect(recovered).toBe("bootstrap-ack");
    },
    10_000,
  );
});
