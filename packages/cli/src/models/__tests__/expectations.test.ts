import { describe, expect, it } from "bun:test";
import {
  compareExpectations,
  describeMismatch,
  ModelExpectationsSchema,
} from "../expectations.js";
import type { CatalogResolution } from "../resolve.js";

const report: CatalogResolution[] = [
  {
    harness: "opencode2",
    section: "default",
    catalog: "openai",
    agents: [
      {
        agent: "shuttle",
        model: "openai/gpt-6-sol",
        entryIndex: 1,
        skipped: [],
      },
      { agent: "thread", model: "none", skipped: [] },
    ],
  },
  {
    harness: "claude-code",
    section: "claude-code",
    catalog: "anthropic",
    agents: [{ agent: "shuttle", model: "sonnet", entryIndex: 0, skipped: [] }],
  },
];

function expectations(harnesses: unknown) {
  return ModelExpectationsSchema.parse({ schema: 1, harnesses });
}

describe("ModelExpectationsSchema", () => {
  it("accepts per-harness, per-catalog agent expectations", () => {
    expect(
      ModelExpectationsSchema.safeParse({
        schema: 1,
        harnesses: {
          opencode2: { "github-copilot+openai": { weft: "none" } },
          "claude-code": { anthropic: { weft: "opus" } },
          pi: { openrouter: { weft: "none" } },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an unknown harness", { copilot: {} }],
    ["an unknown catalog", { opencode2: { azure: { weft: "none" } } }],
    [
      "a Claude Code catalog other than anthropic",
      { "claude-code": { openai: { weft: "opus" } } },
    ],
    ["an empty expectation", { opencode2: { openai: { weft: "" } } }],
  ])("rejects %s", (_name, harnesses) => {
    expect(
      ModelExpectationsSchema.safeParse({ schema: 1, harnesses }).success,
    ).toBe(false);
  });

  it("rejects a file without schema 1 or with an unknown field", () => {
    expect(ModelExpectationsSchema.safeParse({ harnesses: {} }).success).toBe(
      false,
    );
    expect(
      ModelExpectationsSchema.safeParse({ schema: 1, harnesses: {}, x: 1 })
        .success,
    ).toBe(false);
  });
});

describe("compareExpectations", () => {
  it("passes when every resolution matches, none included", () => {
    expect(
      compareExpectations(
        report,
        expectations({
          opencode2: {
            openai: { shuttle: "openai/gpt-6-sol", thread: "none" },
          },
          "claude-code": { anthropic: { shuttle: "sonnet" } },
        }),
      ),
    ).toEqual([]);
  });

  it("reports a different model, a missing expectation and an extra one", () => {
    const mismatches = compareExpectations(
      report,
      expectations({
        opencode2: {
          openai: { shuttle: "openai/gpt-6-luna", loom: "openai/gpt-6-sol" },
        },
        "claude-code": { anthropic: { shuttle: "sonnet" } },
      }),
    );
    expect(mismatches.map(describeMismatch)).toEqual([
      "opencode2 / openai / shuttle: expected openai/gpt-6-luna, resolved openai/gpt-6-sol",
      "opencode2 / openai / thread: resolved none, but the expectations file has no entry",
      "opencode2 / openai / loom: expected openai/gpt-6-sol, but the list has no such agent for this harness",
    ]);
  });

  it("reports a whole harness the expectations file leaves out", () => {
    const mismatches = compareExpectations(
      report,
      expectations({
        opencode2: { openai: { shuttle: "openai/gpt-6-sol", thread: "none" } },
      }),
    );
    expect(mismatches).toEqual([
      {
        harness: "claude-code",
        catalog: "anthropic",
        agent: "shuttle",
        expected: undefined,
        actual: "sonnet",
      },
    ]);
  });
});
