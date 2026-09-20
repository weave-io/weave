/**
 * DSL scenarios — tool policy.
 *
 * Bucket: DSL. `tool_policy` is how a user says what an agent may do. Weave
 * resolves it into the `effectiveToolPolicy` every adapter maps onto its own
 * permission model, so these are the promises behind "this agent cannot write"
 * no matter which harness runs it.
 */

import { describe, expect, it } from "bun:test";
import { agent, whenMaterialized } from "../support/scenario.js";

describe("a user restricts what a delegated specialist may do", () => {
  const config = `
    agent auditor {
      prompt "You review code. You do not change it."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      tool_policy {
        read allow
        write deny
        execute ask
        delegate deny
        network deny
      }
    }
  `;

  it("carries each capability through to the adapter exactly as declared", async () => {
    const plan = await whenMaterialized(config);

    expect(agent(plan, "auditor").descriptor.effectiveToolPolicy).toEqual({
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "deny",
      network: "deny",
    });
  });
});

describe("a user declares only some capabilities", () => {
  it("still resolves every capability, so an adapter never sees a gap", async () => {
    const plan = await whenMaterialized(`
      agent partial {
        prompt "You are partial."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          write deny
        }
      }
    `);

    const policy = agent(plan, "partial").descriptor.effectiveToolPolicy;

    expect(policy.write).toBe("deny");
    for (const capability of [
      "read",
      "execute",
      "delegate",
      "network",
    ] as const) {
      expect(policy[capability]).toBeDefined();
    }
  });
});

describe("a user declares no tool policy at all", () => {
  it("still gets a fully resolved policy", async () => {
    const plan = await whenMaterialized(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const policy = agent(plan, "bare").descriptor.effectiveToolPolicy;

    for (const capability of [
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ] as const) {
      expect(["allow", "deny", "ask"]).toContain(policy[capability]);
    }
  });
});

describe("a category tightens the policy its shuttle inherits", () => {
  it("applies the category's permissions over the base shuttle's", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "You are Shuttle."
        models ["anthropic/claude-sonnet-4-5"]
        mode all

        tool_policy {
          read allow
          write allow
          execute allow
          delegate allow
        }
      }

      category docs {
        description "Documentation only"

        tool_policy {
          write deny
          execute deny
        }
      }
    `);

    const base = agent(plan, "shuttle").descriptor.effectiveToolPolicy;
    const docs = agent(plan, "shuttle-docs").descriptor.effectiveToolPolicy;

    expect(base.write).toBe("allow");
    expect(docs.write).toBe("deny");
    expect(docs.execute).toBe("deny");
    expect(docs.read).toBe("allow");
  });
});

describe("a user gives an agent a policy the DSL does not define", () => {
  it("is rejected rather than silently resolved to something permissive", async () => {
    const source = `
      agent broken {
        prompt "You are broken."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read maybe
        }
      }
    `;

    const { parseConfig } = await import("@weaveio/weave-core");
    expect(parseConfig(source).isErr()).toBe(true);
  });
});
