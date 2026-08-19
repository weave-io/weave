import { describe, expect, it } from "bun:test";
import { MODEL_TRANSITION_SCHEMA_VERSION } from "../child-control-bodies.js";
import {
  appendPiModelFailoverRecord,
  MODEL_FAILOVER_RECORD_SCHEMA_VERSION,
  modelFailoverRecordFromTransition,
  PI_MODEL_FAILOVER_ENTRY_TYPE,
  parsePiModelFailoverNativeEntry,
  parsePiModelFailoverRecord,
} from "../model-failover-record.js";

const TRANSITION_ID = "123e4567-e89b-42d3-a456-426614174000";

const RECORD = {
  schemaVersion: MODEL_FAILOVER_RECORD_SCHEMA_VERSION,
  transitionId: TRANSITION_ID,
  failureClass: "provider_unavailable",
  from: { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  to: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude" },
} as const;

function nativeEntry(data: unknown = RECORD): Record<string, unknown> {
  return {
    type: "custom",
    id: "entry-fallback-1",
    customType: PI_MODEL_FAILOVER_ENTRY_TYPE,
    data,
  };
}

function transition(phase: "applied" | "recovery-confirmed") {
  return {
    schemaVersion: MODEL_TRANSITION_SCHEMA_VERSION,
    transitionId: TRANSITION_ID,
    failureClass: "provider_unavailable",
    from: { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    to: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude" },
    phase,
  };
}

describe("durable model-failover record", () => {
  it("accepts the exact bounded canonical record and native custom entry", () => {
    const parsed = parsePiModelFailoverRecord(RECORD);
    expect(parsed.isOk()).toBe(true);
    expect(parsed._unsafeUnwrap()).toEqual(RECORD);

    const entry = parsePiModelFailoverNativeEntry(nativeEntry());
    expect(entry.isOk()).toBe(true);
    expect(entry._unsafeUnwrap()).toEqual(RECORD);
  });

  it("accepts recovery-confirmed transitions and emits no applied-only record", () => {
    const applied = modelFailoverRecordFromTransition(transition("applied"));
    expect(applied.isOk()).toBe(true);
    expect(applied._unsafeUnwrap()).toBeUndefined();

    const confirmed = modelFailoverRecordFromTransition(
      transition("recovery-confirmed"),
    );
    expect(confirmed.isOk()).toBe(true);
    expect(confirmed._unsafeUnwrap()).toEqual(RECORD);
  });

  it("rejects extra, malformed, accessor-backed, prototype, and oversized values", () => {
    const extra = { ...RECORD, extra: true };
    expect(parsePiModelFailoverRecord(extra).isErr()).toBe(true);

    const symbolExtra = { ...RECORD };
    Object.defineProperty(symbolExtra, Symbol("extra"), {
      enumerable: true,
      value: true,
    });
    expect(parsePiModelFailoverRecord(symbolExtra).isErr()).toBe(true);

    const accessor = { ...RECORD } as Record<string, unknown>;
    Object.defineProperty(accessor, "transitionId", {
      enumerable: true,
      get: () => TRANSITION_ID,
    });
    expect(parsePiModelFailoverRecord(accessor).isErr()).toBe(true);

    const nestedAccessor = {
      ...RECORD,
      from: { ...RECORD.from },
    } as Record<string, unknown>;
    Object.defineProperty(nestedAccessor.from, "provider", {
      enumerable: true,
      get: () => "openai",
    });
    expect(parsePiModelFailoverRecord(nestedAccessor).isErr()).toBe(true);

    const forgedPrototype = Object.create({ inherited: true }) as Record<
      string,
      unknown
    >;
    Object.assign(forgedPrototype, RECORD);
    expect(parsePiModelFailoverRecord(forgedPrototype).isErr()).toBe(true);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(parsePiModelFailoverRecord(revoked.proxy).isErr()).toBe(true);

    expect(
      parsePiModelFailoverRecord({
        ...RECORD,
        from: { ...RECORD.from, id: "x".repeat(257) },
      }).isErr(),
    ).toBe(true);
    expect(
      parsePiModelFailoverRecord({
        ...RECORD,
        transitionId: "é".repeat(200),
      }).isErr(),
    ).toBe(true);

    const nativeExtra = { ...nativeEntry(), extra: true };
    expect(parsePiModelFailoverNativeEntry(nativeExtra).isErr()).toBe(true);

    const nativeMissingId = nativeEntry();
    delete nativeMissingId.id;
    expect(parsePiModelFailoverNativeEntry(nativeMissingId).isErr()).toBe(true);

    const nativeAccessor = nativeEntry();
    Object.defineProperty(nativeAccessor, "type", {
      enumerable: true,
      get: () => "custom",
    });
    expect(parsePiModelFailoverNativeEntry(nativeAccessor).isErr()).toBe(true);

    const unrelated = parsePiModelFailoverNativeEntry({
      type: "custom",
      id: "x",
    });
    expect(unrelated.isOk()).toBe(true);
    expect(unrelated._unsafeUnwrap()).toBeUndefined();
  });

  it("appends only after context repair and deduplicates by transition id", () => {
    const entries: unknown[] = [];
    const makePort = () => ({
      getEntries: () => entries,
      appendEntry: (type: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `entry-${entries.length + 1}`,
          customType: type,
          data,
        });
      },
    });

    const refused = appendPiModelFailoverRecord(makePort(), RECORD);
    expect(refused.isErr()).toBe(true);
    expect(refused._unsafeUnwrapErr()).toMatchObject({
      type: "PiModelFailoverAppendFailed",
      reason: "context-not-repaired",
    });
    expect(entries).toHaveLength(0);

    const first = appendPiModelFailoverRecord(makePort(), RECORD, true);
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap().status).toBe("appended");
    expect(entries).toHaveLength(1);

    const sameProcess = appendPiModelFailoverRecord(makePort(), RECORD, true);
    expect(sameProcess.isOk()).toBe(true);
    expect(sameProcess._unsafeUnwrap().status).toBe("duplicate");
    expect(entries).toHaveLength(1);

    const afterReload = appendPiModelFailoverRecord(makePort(), RECORD, true);
    expect(afterReload.isOk()).toBe(true);
    expect(afterReload._unsafeUnwrap().status).toBe("duplicate");
    expect(entries).toHaveLength(1);
  });
});
