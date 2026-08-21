import { describe, expect, test } from "bun:test";
import type { StableTrainRecord } from "../model.js";
import { hasProgressedLineage } from "../stable-lineage.js";
import {
  type StableTrainContent,
  trainRecordDigest,
  validateStableTrain,
} from "../stable-train.js";

function trainDigest(value: StableTrainContent): string {
  const result = trainRecordDigest(value);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function train(
  state: "awaiting-promotion" | "promoted",
  overrides: Partial<StableTrainContent> = {},
): StableTrainRecord {
  const content: StableTrainContent = {
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
  const result = validateStableTrain({
    ...content,
    recordDigest: trainDigest(content),
  });
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("finalize to release-refs stable-train hand-off", () => {
  test("accepts finalize's promoted train", () =>
    expect(
      hasProgressedLineage(train("awaiting-promotion"), train("promoted")),
    ).toBe(true));

  test.each<[string, Partial<StableTrainContent>]>([
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
