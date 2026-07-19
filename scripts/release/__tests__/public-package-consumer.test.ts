import { describe, expect, it } from "bun:test";

describe("public consumer fixture", () => {
  it("uses package-only imports with no workspace aliases", async () => {
    const source = await Bun.file(
      "scripts/release/__fixtures__/consumer/index.ts",
    ).text();
    expect(source).not.toContain("workspace:");
    expect(source).not.toContain("@weaveio/weave-core");
  });
});
