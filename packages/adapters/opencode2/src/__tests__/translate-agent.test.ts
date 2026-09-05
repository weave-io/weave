import { describe, expect, it } from "bun:test";
import { toPermissionRules } from "../tool-policy-mapping.js";
import {
  type ResolvedAgentModel,
  type TranslatableAgentDescriptor,
  translateAgent,
  WEAVE_OWNERSHIP_MARKER,
} from "../translate-agent.js";

const BASE_MODEL: ResolvedAgentModel = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
};

function baseDescriptor(
  overrides: Partial<TranslatableAgentDescriptor> = {},
): TranslatableAgentDescriptor {
  return {
    name: "shuttle",
    description: "Shuttle (Domain Specialist)",
    composedPrompt: "You are Shuttle, a domain specialist.",
    mode: "subagent",
    effectiveToolPolicy: {
      read: "allow",
      write: "allow",
      execute: "allow",
      delegate: "deny",
      network: "ask",
    },
    ...overrides,
  };
}

describe("translateAgent", () => {
  it("populates system from composedPrompt", () => {
    const info = translateAgent(baseDescriptor(), BASE_MODEL);
    expect(info.system).toBe("You are Shuttle, a domain specialist.");
  });

  it("prepends the ownership marker to description", () => {
    const info = translateAgent(baseDescriptor(), BASE_MODEL);
    expect(info.description).toContain(WEAVE_OWNERSHIP_MARKER);
    expect(info.description).toBe(
      `${WEAVE_OWNERSHIP_MARKER} Shuttle (Domain Specialist)`,
    );
  });

  it("uses the ownership marker alone when no description is present", () => {
    const info = translateAgent(
      baseDescriptor({ description: undefined }),
      BASE_MODEL,
    );
    expect(info.description).toBe(WEAVE_OWNERSHIP_MARKER);
  });

  it("does not set request", () => {
    const info = translateAgent(baseDescriptor(), BASE_MODEL);
    expect(
      (info as unknown as Record<string, unknown>).request,
    ).toBeUndefined();
  });

  it("structures model from providerID/id/variant", () => {
    const withVariant: ResolvedAgentModel = {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    };
    const info = translateAgent(baseDescriptor(), withVariant);
    expect(info.model).toEqual({
      providerID: "openai",
      id: "gpt-5",
      variant: "high",
    } as unknown as typeof info.model);
  });

  it("omits variant when not provided", () => {
    const info = translateAgent(baseDescriptor(), BASE_MODEL);
    expect(info.model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    } as unknown as typeof info.model);
  });

  describe("mode translation", () => {
    it("translates primary mode", () => {
      const info = translateAgent(
        baseDescriptor({ mode: "primary" }),
        BASE_MODEL,
      );
      expect(info.mode).toBe("primary");
    });

    it("translates subagent mode", () => {
      const info = translateAgent(
        baseDescriptor({ mode: "subagent" }),
        BASE_MODEL,
      );
      expect(info.mode).toBe("subagent");
    });

    it("translates all mode", () => {
      const info = translateAgent(baseDescriptor({ mode: "all" }), BASE_MODEL);
      expect(info.mode).toBe("all");
    });
  });

  it("preserves permission order matching toPermissionRules output", () => {
    const policy = {
      read: "allow" as const,
      write: "ask" as const,
      execute: "deny" as const,
      delegate: "allow" as const,
      network: "deny" as const,
    };
    const info = translateAgent(
      baseDescriptor({ effectiveToolPolicy: policy }),
      BASE_MODEL,
    );
    expect(info.permissions).toEqual(toPermissionRules(policy));
  });

  it("passes through hidden, color, disabled when present", () => {
    const info = translateAgent(
      baseDescriptor({ hidden: true, color: "#ff0000", disabled: true }),
      BASE_MODEL,
    );
    expect((info as unknown as Record<string, unknown>).hidden).toBe(true);
    expect((info as unknown as Record<string, unknown>).color).toBe("#ff0000");
    expect((info as unknown as Record<string, unknown>).disabled).toBe(true);
  });

  it("omits hidden, color, disabled when absent", () => {
    const info = translateAgent(baseDescriptor(), BASE_MODEL);
    expect(Object.hasOwn(info, "hidden")).toBe(false);
    expect(Object.hasOwn(info, "color")).toBe(false);
    expect(Object.hasOwn(info, "disabled")).toBe(false);
  });

  it("sets id and name to descriptor.name", () => {
    const info = translateAgent(
      baseDescriptor({ name: "shuttle-backend" }),
      BASE_MODEL,
    );
    expect(info.name as unknown as string).toBe("shuttle-backend");
    expect(info.id as unknown as string).toBe("shuttle-backend");
  });
});
