/**
 * Tests for scripts/validate-config.ts — printSummary output.
 *
 * Strategy: import the exported `printSummary` function and spy on
 * `console.log` to capture what it prints. All WeaveConfig objects are built
 * via `parseConfig()` so they match the exact shape the real script receives.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { parseConfig } from "@weave/core";
import { printSummary } from "../validate-config.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error, null, 2));
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("printSummary", () => {
  let logLines: string[];
  // biome-ignore lint/suspicious/noExplicitAny: spy return type varies by Bun version
  let logSpy: any;

  beforeEach(() => {
    logLines = [];
    logSpy = spyOn(console, "log").mockImplementation(
      (...args: unknown[]) => void logLines.push(args.map(String).join(" ")),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Regression: existing fields unaffected by workflow changes
  // -------------------------------------------------------------------------

  it("prints agent and category counts — no workflows defined (regression)", () => {
    const config = cfg(`
      agent loom {
        prompt "You are loom."
        models ["claude-sonnet-4-5"]
      }
      category backend {
        patterns ["src/api/**"]
      }
    `);

    printSummary(config);

    expect(logLines.some((l) => l.includes("agents     (1): loom"))).toBe(true);
    expect(logLines.some((l) => l.includes("categories (1): backend"))).toBe(
      true,
    );
    // No workflow line when there are no workflows
    expect(logLines.every((l) => !l.includes("workflows"))).toBe(true);
  });

  it("prints multiple agents in declaration order (regression)", () => {
    const config = cfg(`
      agent loom   { prompt "a" models ["m"] }
      agent shuttle { prompt "b" models ["m"] }
    `);

    printSummary(config);

    const agentLine = logLines.find((l) => l.includes("agents"));
    expect(agentLine).toContain("agents     (2):");
    expect(agentLine).toContain("loom");
    expect(agentLine).toContain("shuttle");
  });

  it("omits disabled line when nothing is disabled (regression)", () => {
    const config = cfg(`agent a { prompt "x" models ["m"] }`);
    printSummary(config);
    expect(logLines.every((l) => !l.includes("disabled"))).toBe(true);
  });

  it("omits log_level line when not set (regression)", () => {
    const config = cfg(`agent a { prompt "x" models ["m"] }`);
    printSummary(config);
    expect(logLines.every((l) => !l.includes("log_level"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Workflow summary — new behaviour
  // -------------------------------------------------------------------------

  it("omits the workflows line when no workflows are defined", () => {
    const config = cfg(`agent a { prompt "x" models ["m"] }`);
    printSummary(config);
    expect(logLines.every((l) => !l.includes("workflows"))).toBe(true);
  });

  it("shows workflow count and step count for a single-step workflow", () => {
    const config = cfg(`
      workflow quick-fix {
        version 1

        step fix {
          name "Fix the bug"
          type autonomous
          agent shuttle
          prompt "Fix it."
          completion agent_signal
        }
      }
    `);

    printSummary(config);

    const wfLine = logLines.find((l) => l.includes("workflows"));
    expect(wfLine).toBeDefined();
    expect(wfLine).toContain("workflows  (1):");
    expect(wfLine).toContain("quick-fix [1 step]");
  });

  it("uses plural 'steps' for workflows with more than one step", () => {
    const config = cfg(`
      workflow quick-fix {
        version 1

        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it."
          completion agent_signal
        }

        step review {
          name "Review"
          type gate
          agent weft
          prompt "Review it."
          completion review_verdict
          on_reject pause
        }
      }
    `);

    printSummary(config);

    const wfLine = logLines.find((l) => l.includes("workflows"));
    expect(wfLine).toContain("quick-fix [2 steps]");
  });

  it("lists all workflows with individual step counts", () => {
    const config = cfg(`
      workflow one-step {
        version 1

        step work {
          name "Work"
          type autonomous
          agent shuttle
          prompt "Do it."
          completion agent_signal
        }
      }

      workflow four-step {
        version 1

        step plan {
          name "Plan"
          type autonomous
          agent pattern
          prompt "Plan."
          completion plan_created { plan_name "p" }
          outputs [{ name "plan_path" description "path" }]
        }

        step review-plan {
          name "Review plan"
          type interactive
          agent shuttle
          prompt "Review."
          completion user_confirm
        }

        step implement {
          name "Implement"
          type autonomous
          agent shuttle
          prompt "Implement."
          completion plan_complete { plan_name "p" }
          inputs [{ name "plan_path" description "path" }]
        }

        step gate {
          name "Security gate"
          type gate
          agent warp
          prompt "Audit."
          completion review_verdict
          on_reject pause
        }
      }
    `);

    printSummary(config);

    const wfLine = logLines.find((l) => l.includes("workflows"));
    expect(wfLine).toBeDefined();
    expect(wfLine).toContain("workflows  (2):");
    expect(wfLine).toContain("one-step [1 step]");
    expect(wfLine).toContain("four-step [4 steps]");
  });

  it("workflow line appears between categories and disabled", () => {
    const config = cfg(`
      agent a { prompt "x" models ["m"] }
      category c { patterns ["src/**"] }
      workflow w {
        version 1
        step s {
          name "S" type autonomous agent a prompt "." completion agent_signal
        }
      }
      disable agents ["warp"]
    `);

    printSummary(config);

    const agentIdx = logLines.findIndex((l) => l.includes("agents"));
    const categoryIdx = logLines.findIndex((l) => l.includes("categories"));
    const workflowIdx = logLines.findIndex((l) => l.includes("workflows"));
    const disabledIdx = logLines.findIndex((l) => l.includes("disabled"));

    expect(agentIdx).toBeLessThan(categoryIdx);
    expect(categoryIdx).toBeLessThan(workflowIdx);
    expect(workflowIdx).toBeLessThan(disabledIdx);
  });

  // -------------------------------------------------------------------------
  // Other fields
  // -------------------------------------------------------------------------

  it("prints disabled items spanning agents, hooks, and skills", () => {
    const config = cfg(`
      disable agents ["warp", "spindle"]
      disable hooks  ["on-session-idle"]
      disable skills ["tdd"]
    `);

    printSummary(config);

    const disabledLine = logLines.find((l) => l.includes("disabled"));
    expect(disabledLine).toBeDefined();
    expect(disabledLine).toContain("disabled   (4):");
    expect(disabledLine).toContain("warp");
    expect(disabledLine).toContain("spindle");
    expect(disabledLine).toContain("on-session-idle");
    expect(disabledLine).toContain("tdd");
  });

  it("prints log_level when set", () => {
    const config = cfg("log_level INFO");
    printSummary(config);
    expect(logLines.some((l) => l.includes("log_level: INFO"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // configPath parameter
  // -------------------------------------------------------------------------

  it("includes the configPath in the summary header", () => {
    const config = cfg(`agent a { prompt "x" models ["m"] }`);
    printSummary(config, "path/to/my.weave");
    expect(logLines[0]).toContain("path/to/my.weave");
  });

  it("defaults to .weave/config.weave when configPath is omitted", () => {
    const config = cfg(`agent a { prompt "x" models ["m"] }`);
    printSummary(config);
    expect(logLines[0]).toContain(".weave/config.weave");
  });

  // -------------------------------------------------------------------------
  // Full config smoke test
  // -------------------------------------------------------------------------

  it("renders a complete config with all sections", () => {
    const config = cfg(`
      agent shuttle {
        prompt "You are shuttle."
        models ["claude-sonnet-4-5"]
      }

      category core {
        patterns ["packages/core/**"]
      }

      workflow quick-fix {
        version 1

        step fix {
          name "Fix"
          type autonomous
          agent shuttle
          prompt "Fix it."
          completion agent_signal
        }

        step review {
          name "Review"
          type gate
          agent weft
          prompt "Review it."
          completion review_verdict
          on_reject pause
        }
      }

      disable agents ["warp"]

      log_level DEBUG
    `);

    printSummary(config);

    expect(logLines.some((l) => l.includes("agents     (1): shuttle"))).toBe(
      true,
    );
    expect(logLines.some((l) => l.includes("categories (1): core"))).toBe(true);
    expect(
      logLines.some((l) => l.includes("workflows  (1): quick-fix [2 steps]")),
    ).toBe(true);
    expect(logLines.some((l) => l.includes("disabled   (1): warp"))).toBe(true);
    expect(logLines.some((l) => l.includes("log_level: DEBUG"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fixture smoke test — scripts/fixtures/full-config.weave
  // -------------------------------------------------------------------------

  it("scripts/fixtures/full-config.weave parses cleanly and summarises all sections", () => {
    const source = readFileSync("scripts/fixtures/full-config.weave", "utf8");
    const result = parseConfig(source);
    expect(result.isOk()).toBe(true);

    printSummary(result._unsafeUnwrap(), "scripts/fixtures/full-config.weave");

    // header
    expect(logLines[0]).toContain("scripts/fixtures/full-config.weave");
    // 4 agents covering all three mode values
    const agentLine = logLines.find((l) => l.includes("agents"));
    expect(agentLine).toContain("agents     (4):");
    expect(agentLine).toContain("orchestrator");
    expect(agentLine).toContain("specialist");
    expect(agentLine).toContain("hybrid");
    expect(agentLine).toContain("bare");
    // 2 categories
    const catLine = logLines.find((l) => l.includes("categories"));
    expect(catLine).toContain("categories (2):");
    expect(catLine).toContain("full-cat");
    expect(catLine).toContain("minimal-cat");
    // 2 workflows — comprehensive has 7 steps (all types + all on_reject),
    // minimal has 1 step
    const wfLine = logLines.find((l) => l.includes("workflows"));
    expect(wfLine).toContain("workflows  (2):");
    expect(wfLine).toContain("comprehensive [7 steps]");
    expect(wfLine).toContain("minimal [1 step]");
    // 5 disabled items across agents + hooks + skills
    const disabledLine = logLines.find((l) => l.includes("disabled"));
    expect(disabledLine).toContain("disabled   (5):");
    // log_level
    expect(logLines.some((l) => l.includes("log_level: DEBUG"))).toBe(true);
  });
});
