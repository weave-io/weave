import { describe, expect, it } from "bun:test";

import plugin from "../plugin.js";

describe("plugin loader shape", () => {
  it("exports a Plugin-shaped default without booting a real host", () => {
    expect(typeof plugin.id).toBe("string");
    expect(plugin.id).toBe("weave");
    expect(typeof plugin.setup).toBe("function");
  });
});
