import { describe, expect, it } from "bun:test";
import tui, { WeaveTuiPlugin } from "../tui.js";

describe("OpenCode 2 TUI entry", () => {
  it("exports a separate native CLI plugin definition", () => {
    expect(tui).toBe(WeaveTuiPlugin);
    expect(WeaveTuiPlugin.id).toBe("weave.tui");
    expect(typeof WeaveTuiPlugin.setup).toBe("function");
  });
});
