import { describe, expect, it } from "bun:test";
import { TarInspector } from "../tar-inspector.js";

describe("TarInspector", () => {
  it("rejects non-gzip input before parsing or extraction", () => {
    const result = new TarInspector().inspect(
      new TextEncoder().encode("not an archive"),
    );
    expect(result.isErr()).toBe(true);
  });
});
