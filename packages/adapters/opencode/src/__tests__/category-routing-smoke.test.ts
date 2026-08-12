/**
 * Integration smoke test: OpenCode adapter translates a `shuttle-client-frontend`
 * category agent descriptor correctly.
 *
 * This test verifies that `translateAgent` correctly materialises a category
 * shuttle `AgentDescriptor` into an OpenCode agent config, including passing
 * through the composed prompt, mode, model, temperature, description, and
 * permission fields.
 *
 * The composed prompt in the fixture is a realistic routing-table-free prompt
 * that reflects the current engine output (no `## Category Routing Table`
 * section). The translator is expected to carry it through unchanged — this is
 * a translation-fidelity test, not an enrichment test.
 *
 * This test is skipped by default. To run it:
 *
 *   RUN_HARNESS_SMOKE=1 bun test packages/adapters/opencode/src/__tests__/category-routing-smoke.test.ts
 *
 * No running OpenCode process is required -- the test exercises the pure
 * translation layer (`translateAgent`) using a hand-crafted `AgentDescriptor`.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import { translateAgent } from "../translate-agent.js";

// ---------------------------------------------------------------------------
// Fixture: shuttle-client-frontend AgentDescriptor
// ---------------------------------------------------------------------------

/**
 * A routing-table-free composed prompt that reflects current engine output.
 * The engine no longer injects a `## Category Routing Table` block; the
 * prompt contains only the domain-specialist header and the category-specific
 * append text.
 */
const COMPOSED_PROMPT = `# shuttle-client-frontend

You are a domain specialist shuttle agent focused on the **client-frontend** category.

Focus on UI correctness, accessibility, and design-system consistency.`;

/**
 * A minimal but realistic `AgentDescriptor` for the `shuttle-client-frontend`
 * category shuttle agent. All required fields are populated; optional fields
 * are set where they are meaningful for category shuttles.
 */
const descriptor: AgentDescriptor = {
  name: "shuttle-client-frontend",
  displayName: "Shuttle — Client Frontend",
  description:
    "Domain specialist for client-facing UI, components, and styling",
  category: {
    name: "client-frontend",
    description: "Client-facing UI, components, and styling",
    patterns: ["src/client/**", "**/*.tsx", "**/*.css"],
  },
  composedPrompt: COMPOSED_PROMPT,
  models: ["claude-sonnet-4-5"],
  mode: "subagent",
  temperature: 0.2,
  effectiveToolPolicy: {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "ask",
  },
  rawToolPolicy: {
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "deny",
    network: "ask",
  },
  delegationTargets: [],
  skills: [],
};

// ---------------------------------------------------------------------------
// Smoke tests — skipped unless RUN_HARNESS_SMOKE=1
// ---------------------------------------------------------------------------

describe.skipIf(!Bun.env.RUN_HARNESS_SMOKE)(
  "category-routing smoke — translateAgent (shuttle-client-frontend)",
  () => {
    it("translateAgent returns ok for a category shuttle descriptor", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);
    });

    it("translated config includes the agent name via the prompt field", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      // The agent name is conveyed through the composed prompt content
      expect(config.prompt).toContain("shuttle-client-frontend");
    });

    it("translated config system prompt does not contain Category Routing Table", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      // Routing table injection was removed from the engine; the prompt must
      // not contain the old section header.
      expect(config.prompt).not.toContain("Category Routing Table");
    });

    it("translated config system prompt contains the category name", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.prompt).toContain("client-frontend");
    });

    it("translated config carries mode subagent", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.mode).toBe("subagent");
    });

    it("translated config carries the resolved model when provided", () => {
      const resolvedModel = "anthropic/claude-sonnet-4-5";
      const result = translateAgent(descriptor, resolvedModel);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.model).toBe(resolvedModel);
    });

    it("translated config omits model field when no resolved model is given", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.model).toBeUndefined();
    });

    it("translated config carries the temperature declared in the descriptor", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.temperature).toBe(0.2);
    });

    it("translated config carries the description from the descriptor", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(config.description).toBe(descriptor.description);
    });

    it("translated config permission block exactly reflects delegate:deny and network:ask from mapToolPolicy", () => {
      const result = translateAgent(descriptor);
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      // mapToolPolicy translates:
      //   write:allow   → permission.edit = "allow"
      //   execute:allow → permission.bash = "allow"
      //   network:ask   → permission.webfetch = "ask"
      //   delegate:deny → permission.doom_loop = "deny"
      expect(config.permission).toBeDefined();
      expect(config.permission?.edit).toBe("allow");
      expect(config.permission?.bash).toBe("allow");
      expect(config.permission?.webfetch).toBe("ask");
      expect(config.permission?.doom_loop).toBe("deny");
    });

    it("full translated config shape is a non-null object with required fields", () => {
      const result = translateAgent(descriptor, "anthropic/claude-sonnet-4-5");
      expect(result.isOk()).toBe(true);

      const config = result._unsafeUnwrap();
      expect(typeof config).toBe("object");
      expect(config).not.toBeNull();
      expect(typeof config.prompt).toBe("string");
      expect((config.prompt ?? "").length).toBeGreaterThan(0);
      expect(config.mode).toBeDefined();
      expect(config.permission).toBeDefined();
    });
  },
);

// ---------------------------------------------------------------------------
// Baseline sanity — always runs (proves the fixture is coherent)
// ---------------------------------------------------------------------------

describe("category-routing smoke — fixture sanity (always runs)", () => {
  it("COMPOSED_PROMPT does not contain Category Routing Table", () => {
    expect(COMPOSED_PROMPT).not.toContain("Category Routing Table");
  });

  it("COMPOSED_PROMPT contains the category name", () => {
    expect(COMPOSED_PROMPT).toContain("client-frontend");
  });

  it("descriptor.composedPrompt does not contain Category Routing Table", () => {
    expect(descriptor.composedPrompt).not.toContain("Category Routing Table");
  });

  it("descriptor category metadata is correct", () => {
    expect(descriptor.category?.name).toBe("client-frontend");
    expect(descriptor.category?.patterns).toContain("src/client/**");
  });

  it("translateAgent is importable and is a function", () => {
    expect(typeof translateAgent).toBe("function");
  });
});
