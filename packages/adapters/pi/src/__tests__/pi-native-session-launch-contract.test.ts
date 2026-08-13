import { describe, expect, it } from "bun:test";
import { WebCryptoHmacPort, WebCryptoRandomPort } from "../child-crypto.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";
import { TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY } from "./fakes/test-only-session-storage-authority.js";

const SESSION_DIR = "/data/weave/adapters/pi/sessions/child-1";
const SESSION_FILE = `${SESSION_DIR}/pi-generated.jsonl`;
const INHERITED_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function spawnInput(
  session: NonNullable<PiRpcChildSpawnInput["session"]>,
): PiRpcChildSpawnInput {
  return {
    childId: "child-1",
    parentId: "root",
    generationId: "generation-1",
    agentName: "shuttle",
    depth: 1,
    cwd: "/repo",
    env: { [INHERITED_SESSION_DIR]: "/untrusted/input-redirect" },
    task: "verify the Pi-native launch contract",
    session,
  };
}

function makeChild(processPort: FakeChildProcessPort): PiRpcChild {
  return new PiRpcChild("child-1", "root", "generation-1", "shuttle", 1, {
    processPort,
    sessionStorageAuthority:
      TEST_ONLY_GRANTED_SESSION_STORAGE_AUTHORITY,
    randomPort: new WebCryptoRandomPort(),
    hmacPort: new WebCryptoHmacPort(),
    logger: noopLogger(),
    command: ["pi", "--mode", "rpc"],
    baseEnv: {
      PATH: "/usr/bin",
      [INHERITED_SESSION_DIR]: "/inherited/settings-redirect",
    },
  });
}

function argumentValue(
  command: readonly string[],
  flag: "--session" | "--session-dir",
): string | undefined {
  const index = command.indexOf(flag);
  return index < 0 ? undefined : command[index + 1];
}

async function flushSpawn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Pi-native RPC launch contract", () => {
  it("passes both exact session arguments and scrubs Pi's inherited session directory", async () => {
    const processPort = new FakeChildProcessPort();
    const child = makeChild(processPort);

    const spawnPromise = child.spawnAndHandshake(
      spawnInput({
        mode: "restore",
        sessionDir: SESSION_DIR,
        sessionPath: SESSION_FILE,
        activeLeafId: "leaf-1",
      }),
    );
    await flushSpawn();
    const observed = processPort.spawnInputs[0];
    child.dispose();
    await spawnPromise;

    expect({
      session: argumentValue(observed?.command ?? [], "--session"),
      sessionDir: argumentValue(observed?.command ?? [], "--session-dir"),
      inheritedSessionDirPresent:
        observed !== undefined &&
        Object.hasOwn(observed.env, INHERITED_SESSION_DIR),
    }).toEqual({
      session: SESSION_FILE,
      sessionDir: SESSION_DIR,
      inheritedSessionDirPresent: false,
    });
  });

  it("rejects an arbitrary non-immediate session path before process spawn", async () => {
    const processPort = new FakeChildProcessPort();
    const child = makeChild(processPort);
    const nestedPath = `${SESSION_DIR}/nested/model-chosen.jsonl`;

    const spawnPromise = child.spawnAndHandshake(
      spawnInput({
        mode: "restore",
        sessionDir: SESSION_DIR,
        sessionPath: nestedPath,
        activeLeafId: "leaf-1",
      }),
    );
    await flushSpawn();
    const spawnCallsBeforeDispose = processPort.spawnInputs.length;
    child.dispose();
    const result = await spawnPromise;
    const publicFailure = result.isErr() ? JSON.stringify(result.error) : "";

    expect({
      rejected: result.isErr(),
      spawnCalls: spawnCallsBeforeDispose,
      leakedSessionPath:
        publicFailure.includes(SESSION_DIR) ||
        publicFailure.includes(nestedPath),
    }).toEqual({
      rejected: true,
      spawnCalls: 0,
      leakedSessionPath: false,
    });
  });
});
