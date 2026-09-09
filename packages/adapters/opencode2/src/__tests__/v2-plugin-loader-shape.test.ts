import { describe, expect, it } from "bun:test";
import plugin, { server, WeavePlugin } from "../server.js";

describe("OpenCode 2 plugin loader shape", () => {
  it("exports one native plugin definition through every server alias", () => {
    expect(plugin).toBe(WeavePlugin);
    expect(server).toBe(WeavePlugin);
    expect(WeavePlugin.id).toBe("weave");
    expect(typeof WeavePlugin.setup).toBe("function");
  });
});
