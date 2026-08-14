import { expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import {
  CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  createPiChildSessionStorageAuthority,
} from "../child-session-storage-authority.js";
import { PiRpcChild, type PiRpcChildSpawnInput } from "../rpc-child.js";
import type { PiAdapterLogger } from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";

test("RPC launch refuses restore, new, no-session, and hostile inputs before interpretation", async () => {
  const cases: readonly [string, unknown][] = [
    [
      "restored session",
      {
        mode: "restore",
        sessionDir: "/tmp/weave-sessions",
        sessionPath: "/tmp/weave-sessions/restored.jsonl",
        activeLeafId: "leaf-1",
        checkpointCursor: 7,
      },
    ],
    [
      "newly created session",
      {
        mode: "new",
        sessionDir: "/tmp/weave-sessions",
      },
    ],
    ["no session", undefined],
    [
      "malformed hostile path and id",
      {
        mode: "restore",
        sessionDir: "../../../../secret",
        sessionPath: "/tmp/weave-sessions/../../secret\u0000prompt",
        activeLeafId: "../../hostile-leaf",
        checkpointCursor: -1,
      },
    ],
  ];

  for (const [label, session] of cases) {
    let inputReads = 0;
    let randomCalls = 0;
    let hmacCalls = 0;
    const processPort = new FakeChildProcessPort();
    const input = new Proxy({ session } as unknown as PiRpcChildSpawnInput, {
      get() {
        inputReads += 1;
        throw new Error(`input interpreted: ${label}`);
      },
      ownKeys() {
        inputReads += 1;
        throw new Error(`input enumerated: ${label}`);
      },
    });
    const child = new PiRpcChild(
      label === "malformed hostile path and id"
        ? "../../hostile-child\u0000id"
        : "child-1",
      "root",
      "gen-1",
      "shuttle",
      1,
      {
        processPort,
        sessionStorageAuthority: createPiChildSessionStorageAuthority(),
        randomPort: {
          randomBytes: (length) => {
            randomCalls += 1;
            return new Uint8Array(length);
          },
        },
        hmacPort: {
          signHex: () => {
            hmacCalls += 1;
            return okAsync("");
          },
          verifyHex: () => {
            hmacCalls += 1;
            return okAsync(false);
          },
        },
        logger: {} as PiAdapterLogger,
      },
    );

    const result = await child.spawnAndHandshake(input);

    expect(result.isErr()).toBe(true);
    if (result.isOk()) continue;
    expect(result.error.code).toBe("ChildSpawnFailed");
    expect(result.error.safeMessage).toBe(
      "Weave could not start the delegated child process.",
    );
    expect(result.error.correlation).toEqual({
      reason: CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
    });
    expect(inputReads).toBe(0);
    expect(randomCalls).toBe(0);
    expect(hmacCalls).toBe(0);
    expect(processPort.spawnInputs).toHaveLength(0);
    expect(processPort.spawnedProcesses).toHaveLength(0);
    expect(child.isDisposed()).toBe(true);
  }
});
