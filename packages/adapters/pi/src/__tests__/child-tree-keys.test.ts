import { describe, expect, it } from "bun:test";
import { classifyChildTreeKey } from "../child-tree-keys.js";

describe("classifyChildTreeKey", () => {
  it("classifies Alt+1..Alt+9 as select-direct-child with a 1-based index", () => {
    for (let n = 1; n <= 9; n += 1) {
      expect(classifyChildTreeKey(`\x1b${n}`)).toEqual({
        kind: "select-direct-child",
        index: n,
      });
    }
  });

  it("classifies plain Backspace as select-parent", () => {
    expect(classifyChildTreeKey("\x7f")).toEqual({ kind: "select-parent" });
  });

  it("classifies plain Esc as cancel-selected", () => {
    expect(classifyChildTreeKey("\x1b")).toEqual({ kind: "cancel-selected" });
  });

  it("returns undefined for unrelated input, leaving it to the host default", () => {
    expect(classifyChildTreeKey("a")).toBeUndefined();
    expect(classifyChildTreeKey("\r")).toBeUndefined();
    expect(classifyChildTreeKey("\x1b0")).toBeUndefined();
    expect(classifyChildTreeKey("\x1b[A")).toBeUndefined();
  });

  it("never classifies Alt+Backspace or Alt+Esc as a plain Backspace/Esc", () => {
    expect(classifyChildTreeKey("\x1b\x7f")).toBeUndefined();
  });
});
