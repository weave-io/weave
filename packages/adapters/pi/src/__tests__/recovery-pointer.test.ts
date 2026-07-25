import { describe, expect, it } from "bun:test";
import {
  activeInstanceFromRecoveryPointer,
  InMemoryRecoveryPointerStore,
  isPointerEligibleForExplicitResume,
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

describe("isPointerEligibleForExplicitResume", () => {
  it("returns true for a recoverable pointer from the same generation", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      controllerGeneration: "gen-1",
      status: "recoverable",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(isPointerEligibleForExplicitResume(pointer.value)).toBe(true);
  });

  it("returns true for a recoverable pointer from a prior generation", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      controllerGeneration: "gen-old",
      status: "recoverable",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    // Explicit resume allows prior-generation recoverable pointers
    // (Issue #21 Task 12 S019/S020)
    expect(isPointerEligibleForExplicitResume(pointer.value)).toBe(true);
  });

  it("returns false for a terminal pointer from the same generation", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      controllerGeneration: "gen-1",
      status: "terminal",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(isPointerEligibleForExplicitResume(pointer.value)).toBe(false);
  });

  it("returns false for a terminal pointer from a prior generation", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      controllerGeneration: "gen-old",
      status: "terminal",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    // Terminal pointers always fail closed, regardless of generation
    expect(isPointerEligibleForExplicitResume(pointer.value)).toBe(false);
  });
});

describe("activeInstanceFromRecoveryPointer", () => {
  it("reconstructs the tracker correlation for a recoverable pointer with a complete workflowId/leaseId pair", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      controllerGeneration: "gen-old",
      status: "recoverable",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    // Issue #21 Task 12 S020: a prior-generation recoverable pointer still
    // reconstructs correlation - the pointer's own generation never gates
    // explicit resume, only its status does.
    expect(activeInstanceFromRecoveryPointer(pointer.value)).toEqual({
      workflowInstanceId: "wf-1",
      leaseId: "lease-1",
    });
  });

  it("never seeds correlation for a terminal pointer", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      status: "terminal",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(activeInstanceFromRecoveryPointer(pointer.value)).toBeUndefined();
  });

  it("fails closed when workflowId is missing, even though status is recoverable", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      workflowId: undefined,
      status: "recoverable",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(activeInstanceFromRecoveryPointer(pointer.value)).toBeUndefined();
  });

  it("fails closed when leaseId is missing, even though workflowId and status are otherwise valid", () => {
    const pointer = parseRecoveryPointer({
      ...VALID_POINTER,
      leaseId: undefined,
      status: "recoverable",
    });
    if (!pointer.isOk()) throw new Error("fixture invalid");
    expect(activeInstanceFromRecoveryPointer(pointer.value)).toBeUndefined();
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
