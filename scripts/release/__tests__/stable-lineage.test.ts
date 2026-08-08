import { describe, expect, test } from "bun:test";
import { hasProgressedLineage } from "../stable-lineage.js";
import { trainRecordDigest } from "../stable-train.js";

function train(state: "awaiting-promotion" | "promoted", overrides = {}) {
  const content = {
    schemaVersion: 1 as const,
    trainRef: "release/20260719-aaaaaaaaaaaa",
    subjectSha: "a".repeat(40),
    cutAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    state,
    packages: ["@weaveio/weave-cli"],
    versions: { "@weaveio/weave-cli": "1.2.3" },
    ...overrides,
  };
  return { ...content, recordDigest: trainRecordDigest(content) } as never;
}

describe("finalize to release-refs stable-train hand-off", () => {
  test("accepts finalize's promoted train", () =>
    expect(
      hasProgressedLineage(train("awaiting-promotion"), train("promoted")),
    ).toBe(true));

  test.each([
    ["train ref", { trainRef: "release/20260720-aaaaaaaaaaaa" }],
    ["cut sha", { subjectSha: "b".repeat(40) }],
    [
      "package set",
      {
        packages: ["@weaveio/weave-adapter-opencode"],
        versions: { "@weaveio/weave-adapter-opencode": "1.2.3" },
      },
    ],
    ["regressed state", { state: "awaiting-promotion" }],
    ["non-promoted state", { state: "finalized" }],
  ])("rejects a progressed train with changed %s", (_name, override) =>
    expect(
      hasProgressedLineage(
        train("awaiting-promotion"),
        train("promoted", override),
      ),
    ).toBe(false));
});
