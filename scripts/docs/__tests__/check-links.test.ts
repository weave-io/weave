import { describe, expect, it } from "bun:test";
import {
  checkLinks,
  DEFAULT_LINK_CHECK_LIMITS,
  type LinkCheckBound,
  type LinkCheckLimits,
  loadDocuments,
} from "../check-links.js";

const BUDGET_CASES: readonly [
  LinkCheckBound,
  Partial<LinkCheckLimits>,
  Record<string, string>,
][] = [
  ["documents", { documents: 1 }, { "a.md": "# A", "b.md": "# B" }],
  [
    "links",
    { links: 1 },
    { "a.md": "[x](a.md) [y](a.md) [z](a.md)", "b.md": "# B" },
  ],
  ["anchors", { anchors: 1 }, { "a.md": "# A\n\n## B\n\n### C" }],
];

describe("checkLinks", () => {
  it.each([
    ["missing file", "[bad](missing.md)"],
    ["missing local anchor", "[bad](guide.md#missing)"],
    ["missing self anchor", "[bad](#missing)"],
  ])("rejects a %s", (_name, link) => {
    expect(
      checkLinks({
        documents: { "readme.md": link, "guide.md": "# Present" },
      }).isErr(),
    ).toBe(true);
  });

  it("accepts relative files, anchors, and external links", () => {
    expect(
      checkLinks({
        documents: {
          "readme.md":
            "# Home\n[guide](guide.md#present) [web](https://example.com)",
          "guide.md": "# Present",
        },
      }).isOk(),
    ).toBe(true);
  });

  it("accepts the current documentation tree", async () => {
    expect(checkLinks(await loadDocuments()).isOk()).toBe(true);
  });

  it.each(
    BUDGET_CASES,
  )("reports an exhausted %s budget", (bound, overrides, documents) => {
    const result = checkLinks(
      { documents },
      { ...DEFAULT_LINK_CHECK_LIMITS, ...overrides },
    );
    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error.type).toBe("LinkBudgetExceeded");
    if (result.error.type !== "LinkBudgetExceeded") return;
    expect(result.error.bound).toBe(bound);
  });
});
