import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryRuntimeStore } from "@weaveio/weave-engine";
import { makeRuntimeStoreOpenFailedFailure } from "../errors.js";
import {
  BunJsonlRecoveryPointerStore,
  parseRecoveryPointer,
  type PiWeaveRecoveryPointerV1,
} from "../recovery-pointer.js";
import {
  FailingRuntimeStoreFactory,
  InMemoryRuntimeStoreFactory,
  SqliteRuntimeStoreFactory,
} from "../runtime-store-port.js";

async function makeScratchRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  await Bun.write(join(root, ".keep"), "");
  await Bun.file(join(root, ".keep")).delete();
  return root;
}

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

describe("InMemoryRuntimeStoreFactory", () => {
  it("returns the injected store without touching disk", async () => {
    const store = createInMemoryRuntimeStore();
    const factory = new InMemoryRuntimeStoreFactory(store);
    const result = await factory.open("/never/read");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(store);
  });
});

describe("FailingRuntimeStoreFactory", () => {
  it("maps a scripted open failure onto RuntimeStoreOpenFailed", async () => {
    const factory = new FailingRuntimeStoreFactory(
      makeRuntimeStoreOpenFailedFailure("disk-unavailable"),
    );
    const result = await factory.open("/tmp/weave.db");
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.code).toBe("RuntimeStoreOpenFailed");
  });
});

describe("SqliteRuntimeStoreFactory — real filesystem conformance", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeScratchRoot("weave-runtime-store-test");
  });

  afterEach(async () => {
    await removeScratchFiles(root);
  });

  it("opens and migrates a fresh Runtime Store in a scratch directory", async () => {
    const factory = new SqliteRuntimeStoreFactory();
    const result = await factory.open(root);
    expect(result.isOk()).toBe(true);
  });

  it("reopens the same isolated store without losing its schema", async () => {
    const factory = new SqliteRuntimeStoreFactory();
    const first = await factory.open(root);
    expect(first.isOk()).toBe(true);
    if (first.isOk()) first.value.close();
    const second = await factory.open(root);
    expect(second.isOk()).toBe(true);
    if (second.isOk()) second.value.close();
  });
});

describe("BunJsonlRecoveryPointerStore — schema-safe read safety", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeScratchRoot("weave-recovery-pointer-test");
  });

  afterEach(async () => {
    await removeScratchFiles(root);
  });

  it("reads only the latest valid pointer and skips malformed/unknown-version entries", async () => {
    const privateCanary = "PRIVATE-RECOVERY-POINTER-CANARY";
    const pointerPath = join(root, "pointers.jsonl");
    const store = new BunJsonlRecoveryPointerStore(pointerPath);

    const appendResult = await store.appendPointer({
      schemaVersion: 1,
      workflowId: "workflow-valid",
      leaseId: "lease-valid",
      controllerGeneration: "gen-1",
      status: "recoverable",
      observedAt: "2026-01-01T00:00:00.000Z",
      attempt: {
        attemptId: "attempt-valid",
      },
    });
    expect(appendResult.isOk()).toBe(true);

    // Put a malformed/unknown-version pointer containing private canary data after the
    // real pointer: the seam should reject it while reading, and the returned output
    // should still reflect the valid pointer only.
    const malformed = `${JSON.stringify({
      schemaVersion: 99,
      workflowId: privateCanary,
      leaseId: "lease-ignored",
      controllerGeneration: "gen-ignored",
      status: "recoverable",
      observedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const existing = await Bun.file(pointerPath).text();
    await Bun.write(pointerPath, `${existing}${malformed}`);

    const result = await store.readLatestPointer();
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value?.workflowId).toBe("workflow-valid");
      expect(result.value?.workflowId).not.toContain(privateCanary);
      expect(JSON.stringify(result.value)).not.toContain(privateCanary);
    }
  });

  it("returns typed parse failures for unknown-version pointer payloads passed through the parser", () => {
    const privateCanary = "PRIVATE-RECOVERY-PARSER-CANARY";
    const parse = parseRecoveryPointer({
      schemaVersion: 99,
      workflowId: privateCanary,
      leaseId: "lease-parse",
      controllerGeneration: "controller-parse",
      status: "recoverable",
      observedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as PiWeaveRecoveryPointerV1);
    expect(parse.isErr()).toBe(true);
    if (parse.isErr()) {
      expect(parse.error.kind).toBe("unknown-version");
      expect(JSON.stringify(parse.error)).not.toContain(privateCanary);
    }
  });
});
