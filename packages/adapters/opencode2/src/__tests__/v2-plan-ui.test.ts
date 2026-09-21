/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: the plan panel's own plugin definition. It ships as a
 * separate `./tui` entry point that the server plugin never loads, so no
 * scenario reaches it.
 */

import { describe, expect, it } from "bun:test";
import tui, { WeaveTuiPlugin } from "../tui.js";

describe("OpenCode 2 TUI entry", () => {
  it("exports a separate native CLI plugin definition", () => {
    expect(tui).toBe(WeaveTuiPlugin);
    expect(WeaveTuiPlugin.id).toBe("weave.tui");
    expect(typeof WeaveTuiPlugin.setup).toBe("function");
  });
});
