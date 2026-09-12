import { describe, expect, it } from "bun:test";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { adaptCopilotDelegationPrompt } from "../delegation-prompt.js";

function targets(...names: string[]): DelegationTarget[] {
  return names.map((name) => ({ name, triggers: [], isCategory: false }));
}

const LOOM_PROMPT = [
  "You are **loom**, the main orchestrator.",
  "",
  "- **shuttle** — Shuttle (Domain Specialist)",
  "- **thread** — Thread (Codebase Explorer)",
  "- **shuttle-core** — DSL lexer",
  "",
  "They appear with names like `shuttle-{category}`. Prefer a category shuttle over the generic shuttle.",
  "If nothing matches, use the generic `shuttle`. Do not invent `shuttle-backend`.",
].join("\n");

describe("adaptCopilotDelegationPrompt", () => {
  it("returns Loom's prompt unchanged when it has no delegation targets", () => {
    const prompt = "You are **loom**. Ask `shuttle` for help.";
    expect(
      adaptCopilotDelegationPrompt({
        agentName: "loom",
        prompt,
        delegationTargets: [],
        pluginAgentIdQualifier: "weave",
      }),
    ).toBe(prompt);
  });

  it("returns any agent other than Loom or Tapestry unchanged, even with delegation targets", () => {
    for (const agentName of ["pattern", "shuttle", "my-orchestrator"]) {
      expect(
        adaptCopilotDelegationPrompt({
          agentName,
          prompt: LOOM_PROMPT,
          delegationTargets: targets("shuttle", "thread"),
          pluginAgentIdQualifier: "weave",
        }),
      ).toBe(LOOM_PROMPT);
    }
  });

  it("adapts Tapestry's prompt", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "tapestry",
      prompt: "Available specialists:\n- **shuttle** — Shuttle",
      delegationTargets: targets("shuttle"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("- **weave:shuttle** — Shuttle");
    expect(result).toContain("## Delegation targets (GitHub Copilot)");
  });

  it("qualifies bold and code references to delegation targets", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: LOOM_PROMPT,
      delegationTargets: targets("shuttle", "thread", "shuttle-core"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("- **weave:shuttle** — Shuttle");
    expect(result).toContain("- **weave:thread** — Thread");
    expect(result).toContain("- **weave:shuttle-core** — DSL lexer");
    expect(result).toContain("use the generic `weave:shuttle`");
  });

  it("leaves the agent's own name, plain prose, patterns, and non-targets alone", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: LOOM_PROMPT,
      delegationTargets: targets("shuttle", "thread", "shuttle-core"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("You are **loom**");
    expect(result).toContain("over the generic shuttle.");
    expect(result).toContain("`shuttle-{category}`");
    expect(result).toContain("Do not invent `shuttle-backend`.");
    expect(result).not.toContain("weave:weave:");
  });

  it("appends a section mapping built-ins to the Weave agents that replace them", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: LOOM_PROMPT,
      delegationTargets: targets(
        "shuttle",
        "thread",
        "spindle",
        "weft",
        "warp",
      ),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("## Delegation targets (GitHub Copilot)");
    expect(result).toContain("`agent_type` MUST be the `weave:<name>` id");
    expect(result).toContain(
      "Never use Copilot's built-in agent types `explore`, `research`, `task`, `general-purpose`, `code-review`, `security-review`",
    );
    expect(result).toContain("→ `weave:thread` (instead of `explore`)");
    expect(result).toContain("→ `weave:spindle` (instead of `research`)");
    expect(result).toContain(
      "→ `weave:shuttle` (instead of `task` / `general-purpose`)",
    );
    expect(result).toContain("→ `weave:weft` (instead of `code-review`)");
    expect(result).toContain("→ `weave:warp` (instead of `security-review`)");
    expect(result).toContain("several `weave:thread` calls in the same turn");
  });

  it("points implementation at category shuttles when any are targets", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: LOOM_PROMPT,
      delegationTargets: [
        ...targets("shuttle"),
        { name: "shuttle-core", triggers: [], isCategory: true },
      ],
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain(
      "→ `weave:shuttle` or the matching category shuttle (`weave:shuttle-<category>`) (instead of `task` / `general-purpose`)",
    );
  });

  it("only forbids built-ins whose Weave replacement is a delegation target", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: "Delegate to **shuttle**.",
      delegationTargets: targets("shuttle"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain(
      "Never use Copilot's built-in agent types `task`, `general-purpose`",
    );
    expect(result).not.toContain("`explore`");
    expect(result).not.toContain("Parallel exploration");
  });

  it("omits the built-in list when no replacement agent is a target", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: "Delegate to **custom-agent**.",
      delegationTargets: targets("custom-agent"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("Delegate to **weave:custom-agent**.");
    expect(result).toContain("(for example `weave:custom-agent`)");
    expect(result).not.toContain("Never use");
  });

  it("keeps references bare when no qualifier is supplied", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: LOOM_PROMPT,
      delegationTargets: targets("shuttle", "thread"),
    });

    expect(result).toContain("- **shuttle** — Shuttle");
    expect(result).not.toContain("weave:");
    expect(result).not.toContain("`agent_type` MUST be");
    expect(result).toContain("→ `thread` (instead of `explore`)");
  });

  it("escapes regex metacharacters in target names", () => {
    const result = adaptCopilotDelegationPrompt({
      agentName: "loom",
      prompt: "Use **a.b** but not **axb**.",
      delegationTargets: targets("a.b"),
      pluginAgentIdQualifier: "weave",
    });

    expect(result).toContain("Use **weave:a.b** but not **axb**.");
  });
});
