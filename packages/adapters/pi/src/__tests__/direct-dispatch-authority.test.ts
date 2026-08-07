import { expect, test } from "bun:test";
import type { HmacPort, RandomPort } from "../child-crypto.js";
import { CHILD_SESSION_STORAGE_UNAVAILABLE_REASON } from "../child-session-storage-authority.js";
import type { PiDirectDispatchInput } from "../direct-dispatch.js";
import {
  createDirectDispatchTransport,
  PiDirectStepChildRegistry,
} from "../direct-dispatch-transport.js";
import type { IdGenerator, PiAdapterLogger } from "../types.js";
import { FakeChildProcessPort } from "./fakes/fake-child-process-port.js";

test("direct dispatch refuses before input, id, model, registry, bootstrap, or spawn work", async () => {
  let inputReads = 0;
  let idCalls = 0;
  let dependencyReads = 0;
  const processPort = new FakeChildProcessPort();
  const registry = new PiDirectStepChildRegistry();
  const input = new Proxy({} as PiDirectDispatchInput, {
    get() {
      inputReads += 1;
      throw new Error("direct-dispatch input interpreted");
    },
    ownKeys() {
      inputReads += 1;
      throw new Error("direct-dispatch input enumerated");
    },
  });
  const idGenerator: IdGenerator = {
    next: () => {
      idCalls += 1;
      return "unexpected-id";
    },
  };
  const deps = {
    processPort,
    randomPort: {} as RandomPort,
    hmacPort: {} as HmacPort,
    logger: {} as PiAdapterLogger,
    idGenerator,
    registry,
    get availableModels(): readonly never[] {
      dependencyReads += 1;
      throw new Error("model catalog read");
    },
  };

  const transport = createDirectDispatchTransport(deps, "gen-1");
  const result = await transport(input);

  expect(result.isErr()).toBe(true);
  if (result.isOk()) return;
  expect(result.error.code).toBe("ChildSpawnFailed");
  expect(result.error.scope).toEqual({ kind: "child", id: "direct-step" });
  expect(result.error.safeMessage).toBe(
    "Weave could not start the delegated child process.",
  );
  expect(result.error.correlation).toEqual({
    reason: CHILD_SESSION_STORAGE_UNAVAILABLE_REASON,
  });
  expect(inputReads).toBe(0);
  expect(idCalls).toBe(0);
  expect(dependencyReads).toBe(0);
  expect(processPort.spawnInputs).toHaveLength(0);
  expect(processPort.spawnedProcesses).toHaveLength(0);
  expect(registry.isActive()).toBe(false);
});
