import { describe, expect, it } from "bun:test";
import {
  trainRecordDigest,
  transitionStableTrain,
  validateStableTrain,
} from "../stable-train.js";

const content = {
  schemaVersion: 1 as const,
  trainRef: "release/20260719-abcdef123456",
  subjectSha: "a".repeat(40),
  cutAt: "2026-07-19T00:00:00.000Z",
  expiresAt: "2026-07-26T00:00:00.000Z",
  state: "prepared" as const,
  packages: ["@weaveio/weave-cli"],
  versions: { "@weaveio/weave-cli": "1.2.3" },
};
const record = { ...content, recordDigest: trainRecordDigest(content) };

describe("stable train records", () => {
  it.each([
    ["canonical content-addressed record", record],
  ])("accepts %s", (_name, value) =>
    expect(validateStableTrain(value).isOk()).toBe(true));
  it.each([
    ["unknown schema", { ...record, schemaVersion: 2 }],
    [
      "missing digest binding",
      { ...record, recordDigest: `sha256:${"b".repeat(64)}` },
    ],
    [
      "nonseven-day expiry",
      { ...record, expiresAt: "2026-07-25T00:00:00.000Z" },
    ],
    [
      "Claude package",
      {
        ...record,
        packages: ["@weaveio/weave-adapter-claude-code"],
        versions: { "@weaveio/weave-adapter-claude-code": "1.2.3" },
      },
    ],
    ["extra property", { ...record, approval: true }],
  ])("rejects %s", (_name, value) =>
    expect(validateStableTrain(value).isErr()).toBe(true));

  it("permits only declared state transitions and redigests the record", () => {
    const result = transitionStableTrain(record as never, "built");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.recordDigest).not.toBe(record.recordDigest);
    expect(transitionStableTrain(result.value, "finalized").isErr()).toBe(true);
  });
});
