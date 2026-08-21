import { describe, expect, it } from "bun:test";
import {
  AGENT_DISPLAY_NAME_MAX,
  formatAgentDisplayName,
  formatDelegationAgentName,
} from "../agent-display-name.js";

describe("agent display names", () => {
  it("uses the closed initialism vocabulary and Title Case for other parts", () => {
    expect(formatAgentDisplayName("shuttle")).toBe("Shuttle");
    expect(formatAgentDisplayName("gpt-api-worker")).toBe("GPT API Worker");
    expect(formatAgentDisplayName("openai-mcp")).toBe("OpenAI MCP");
    expect(formatAgentDisplayName("custom-name")).toBe("Custom Name");
    expect(formatAgentDisplayName("unknown_initialism")).toBe(
      "Unknown Initialism",
    );
  });

  it("is bounded, deterministic, and has a nonempty fallback", () => {
    const long = formatAgentDisplayName(
      "a".repeat(AGENT_DISPLAY_NAME_MAX + 20),
    );
    expect([...long].length).toBeLessThanOrEqual(AGENT_DISPLAY_NAME_MAX);
    expect(formatAgentDisplayName("   ---___   ")).toBe("Delegate");
    expect(formatAgentDisplayName("İD")).toBe("İd");
  });

  it("preserves the established category display shape for delegation callers", () => {
    expect(formatDelegationAgentName("shuttle")).toBe("Shuttle");
    expect(formatDelegationAgentName("shuttle-infra")).toBe("Infra-Shuttle");
    expect(formatDelegationAgentName("shuttle-data-platform")).toBe(
      "Data-Platform-Shuttle",
    );
    expect(formatDelegationAgentName("worker-name")).toBe("Worker-Name");
  });
});
