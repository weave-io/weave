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

describe("a user sets one capability and leaves the rest unsaid", () => {
  const capabilities = [
    "read",
    "write",
    "execute",
    "delegate",
    "network",
  ] as const;
  const permissions = ["allow", "deny", "ask"] as const;
  const combinations: Array<[(typeof capabilities)[number], string]> =
    capabilities.flatMap((capability) =>
      permissions.map((permission): [(typeof capabilities)[number], string] => [
        capability,
        permission,
      ]),
    );

  it.each(
    combinations,
  )("gives the agent %s: %s and asks about everything else", async (capability, permission) => {
    const plan = await whenMaterialized(`
        agent one-rule {
          prompt "You are one-rule."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent

          tool_policy {
            ${capability} ${permission}
          }
        }
      `);

    const policy = agent(plan, "one-rule").descriptor.effectiveToolPolicy;

    expect(policy[capability] as string).toBe(permission);
    for (const other of capabilities.filter((c) => c !== capability)) {
      expect(policy[other]).toBe("ask");
    }
  });
});

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

    expect(agent(plan, "partial").descriptor.effectiveToolPolicy).toEqual({
      read: "ask",
      write: "deny",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });
});

describe("a user declares no tool policy at all", () => {
  it("asks before every capability rather than granting any of them", async () => {
    const plan = await whenMaterialized(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agent(plan, "bare").descriptor.effectiveToolPolicy).toEqual({
      read: "ask",
      write: "ask",
      execute: "ask",
      delegate: "ask",
      network: "ask",
    });
  });

  it("hands the adapter no raw policy to second-guess the resolved one with", async () => {
    const plan = await whenMaterialized(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agent(plan, "bare").descriptor.rawToolPolicy).toBeUndefined();
  });
});

describe("an adapter wants to know exactly what the user typed", () => {
  it("gets the declared policy back unchanged, next to the resolved one", async () => {
    const plan = await whenMaterialized(`
      agent auditor {
        prompt "You are auditor."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        tool_policy {
          read allow
          write deny
        }
      }
    `);

    const descriptor = agent(plan, "auditor").descriptor;

    expect(descriptor.rawToolPolicy).toEqual({ read: "allow", write: "deny" });
    expect(descriptor.effectiveToolPolicy.execute).toBe("ask");
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
