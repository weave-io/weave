import { describe, expect, it } from "bun:test";
import {
  CLAUDE_CODE_TOOL_CLASSIFICATIONS,
  CLAUDE_CODE_TOOL_IDS,
  getClaudeCodeToolClassifications,
} from "../tool-classification.js";

describe("CLAUDE_CODE_TOOL_CLASSIFICATIONS", () => {
  it("maps Read to read capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Read",
    );
    expect(entry).toBeDefined();
    expect(entry!.capability).toBe("read");
  });

  it("maps Write to write capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Write",
    );
    expect(entry!.capability).toBe("write");
  });

  it("maps Edit to write capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Edit",
    );
    expect(entry!.capability).toBe("write");
  });

  it("maps MultiEdit to write capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "MultiEdit",
    );
    expect(entry!.capability).toBe("write");
  });

  it("maps Bash to execute capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Bash",
    );
    expect(entry!.capability).toBe("execute");
  });

  it("maps Task to delegate capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Task",
    );
    expect(entry!.capability).toBe("delegate");
  });

  it("maps Agent to delegate capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "Agent",
    );
    expect(entry!.capability).toBe("delegate");
  });

  it("maps WebFetch to network capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "WebFetch",
    );
    expect(entry!.capability).toBe("network");
  });

  it("maps WebSearch to network capability", () => {
    const entry = CLAUDE_CODE_TOOL_CLASSIFICATIONS.find(
      (c) => c.toolId === "WebSearch",
    );
    expect(entry!.capability).toBe("network");
  });

  it("covers all five abstract capabilities", () => {
    const capabilities = new Set(
      CLAUDE_CODE_TOOL_CLASSIFICATIONS.map((c) => c.capability),
    );
    expect(capabilities).toEqual(
      new Set(["read", "write", "execute", "delegate", "network"]),
    );
  });

  it("has 9 total entries", () => {
    expect(CLAUDE_CODE_TOOL_CLASSIFICATIONS).toHaveLength(9);
  });
});

describe("getClaudeCodeToolClassifications", () => {
  it("returns the same array as the constant", () => {
    expect(getClaudeCodeToolClassifications()).toBe(
      CLAUDE_CODE_TOOL_CLASSIFICATIONS,
    );
  });
});

describe("CLAUDE_CODE_TOOL_IDS", () => {
  it("contains all tool identifiers", () => {
    expect(CLAUDE_CODE_TOOL_IDS).toEqual([
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Task",
      "Agent",
      "WebFetch",
      "WebSearch",
    ]);
  });
});
