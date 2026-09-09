import type { ModelInfo, SkillInfo } from "@opencode-ai/client";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import type { OpenCode2AgentProjection } from "../v2/translate-agent.js";

export function modelInfo(
  providerID: string,
  id: string,
  variants: readonly string[] = [],
): ModelInfo {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: variants.map((variant) => ({ id: variant })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_000, output: 1_000 },
  };
}

export function skillInfo(id: string, name = id): SkillInfo {
  return { id, name, location: "/skills", content: `# ${name}` };
}

export function descriptor(
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name: "helper",
    composedPrompt: "role prompt",
    models: [],
    mode: "subagent",
    effectiveToolPolicy: {
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "ask",
    },
    rawToolPolicy: undefined,
    delegationTargets: [],
    skills: [],
    ...overrides,
  };
}

export function projection(id = "helper"): OpenCode2AgentProjection {
  return {
    id,
    system: "role prompt",
    mode: "subagent",
    permissions: [],
    skillNames: [],
  };
}

export function catalog(
  projections: ReadonlyMap<string, OpenCode2AgentProjection> = new Map([
    ["helper", projection()],
  ]),
): OpenCode2CatalogCandidate {
  return {
    revision: "a".repeat(64),
    agents: projections,
    runtime: new Map(
      [...projections].map(([name, value]) => [
        name,
        { projection: value, skillIDs: [] },
      ]),
    ),
    issues: [],
    sources: [],
  };
}
