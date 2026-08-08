import { describe, expect, it } from "bun:test";
import { checkLinks, loadDocuments } from "../check-links.js";

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
});
