import { describe, expect, it } from "bun:test";
import {
  InMemoryRecoveryPointerStore,
  isPointerForCurrentGeneration,
  parseRecoveryPointer,
  RECOVERY_POINTER_SCHEMA_VERSION,
} from "../recovery-pointer.js";

const VALID_POINTER = {
  schemaVersion: RECOVERY_POINTER_SCHEMA_VERSION,
  workflowId: "wf-1",
  leaseId: "lease-1",
  controllerGeneration: "gen-1",
  status: "recoverable" as const,
  observedAt: "2024-01-01T00:00:00.000Z",
};

describe("parseRecoveryPointer", () => {
  it("accepts a well-formed pointer", () => {
    const result = parseRecoveryPointer(VALID_POINTER);
    expect(result.isOk()).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    const result = parseRecoveryPointer({ ...VALID_POINTER, schemaVersion: 2 });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("unknown-version");
  });

  it("rejects planName without planRevision", () => {
    const result = parseRecoveryPointer({
      ...VALID_POINTER,
      planName: "plan-a",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe("malformed");
  });

  it("accepts planName and planRevision together", () => {
    const result = parseRecoveryPointer({
      ...VALID_POINTER,
      planName: "plan-a",
      planRevision: 3,
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects a non-object payload", () => {
    const result = parseRecoveryPointer("not-a-pointer");
    expect(result.isErr()).toBe(true);
  });
});

describe("isPointerForCurrentGeneration", () => {
  it("returns true only when generations match", () => {
    const pointer = parseRecoveryPointer(VALID_POINTER);
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(isPointerForCurrentGeneration(pointer.value, "gen-1")).toBe(true);
    expect(isPointerForCurrentGeneration(pointer.value, "gen-2")).toBe(false);
  });
});

describe("InMemoryRecoveryPointerStore", () => {
  it("appends and reads back the latest pointer", async () => {
    const store = new InMemoryRecoveryPointerStore();
    await store.appendPointer(VALID_POINTER);
    const latest = await store.readLatestPointer();
    expect(latest.isOk()).toBe(true);
    if (latest.isOk()) expect(latest.value).toEqual(VALID_POINTER);
  });

  it("returns undefined when no pointer has been appended", async () => {
    const store = new InMemoryRecoveryPointerStore();
    const latest = await store.readLatestPointer();
    expect(latest.isOk()).toBe(true);
    if (latest.isOk()) expect(latest.value).toBeUndefined();
  });

  it("degrades on a scripted append failure without losing prior pointers", async () => {
    const store = new InMemoryRecoveryPointerStore();
    await store.appendPointer(VALID_POINTER);
    store.setFailNextAppend("disk-full");
    const second = { ...VALID_POINTER, observedAt: "2024-01-01T00:01:00.000Z" };
    const appendResult = await store.appendPointer(second);
    expect(appendResult.isErr()).toBe(true);
    if (appendResult.isErr())
      expect(appendResult.error.code).toBe("SessionPointerAppendFailed");
    const latest = await store.readLatestPointer();
    expect(latest.isOk()).toBe(true);
    if (latest.isOk()) expect(latest.value).toEqual(VALID_POINTER);
  });
});
