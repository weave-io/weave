/**
 * Unit tests for `OpenCodeAgentMaterializer` — the V1 adapter's report of
 * which agents OpenCode holds (ADR 0013, Spec 38 item 2).
 *
 * Model resolution and translation never fail on today's config-hook path,
 * so no registered config can show what happens when they do. These tests
 * inject a failing step for one agent and check that Loom is then not
 * offered it. The config is inline DSL; there is no harness and no disk.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { materializeAgents } from "@weaveio/weave-engine";
import { err, ok } from "neverthrow";

import { OpenCodeAgentMaterializer } from "../materialize-agents.js";
import { translateAgent } from "../translate-agent.js";

const CONFIG = `
agent loom {
  prompt "{{#delegation.targets}}- **{{name}}**\\n{{/delegation.targets}}"
  mode primary
}

agent shuttle {
  prompt "You are shuttle."
  mode subagent
  tool_policy {
    delegate deny
  }
}

category api {
  description "HTTP handlers"
}

category web {
  description "Browser UI"
}
`;

function config(): WeaveConfig {
  const parsed = parseConfig(CONFIG);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

/** `materializeAgents`, counting how often the adapter composes. */
function countingMaterialize() {
  const calls: Array<Parameters<typeof materializeAgents>[0]> = [];
  const materialize: typeof materializeAgents = (input) => {
    calls.push(input);
    return materializeAgents(input);
  };
  return { calls, materialize };
}

/** `translateAgent`, refusing one agent the way a translation error would. */
const refusing =
  (name: string): typeof translateAgent =>
  (descriptor, model) =>
    descriptor.name === name
      ? err({
          type: "TranslateAgentError",
          agentName: name,
          message: `cannot translate ${name}`,
        })
      : translateAgent(descriptor, model);

describe("OpenCodeAgentMaterializer — every agent translates", () => {
  it("composes once and reports every agent as materialized", async () => {
    const { calls, materialize } = countingMaterialize();
    const result = await new OpenCodeAgentMaterializer({
      materializeAgents: materialize,
    }).materialize(config());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.harness).toBeUndefined();
    expect(result.report).toEqual({
      materialized: ["loom", "shuttle", "shuttle-api", "shuttle-web"],
      failed: [],
    });
  });
});

describe("OpenCodeAgentMaterializer — one agent fails to translate", () => {
  it("does not give OpenCode the refused agent", async () => {
    const result = await new OpenCodeAgentMaterializer({
      translate: refusing("shuttle-web"),
    }).materialize(config());

    expect([...result.translated.keys()]).toEqual([
      "loom",
      "shuttle",
      "shuttle-api",
    ]);
  });

  it("reports the refusal with its reason", async () => {
    const result = await new OpenCodeAgentMaterializer({
      translate: refusing("shuttle-web"),
    }).materialize(config());

    expect(result.report.failed).toEqual([
      {
        agentName: "shuttle-web",
        reason: "translation_failed",
        message: "cannot translate shuttle-web",
      },
    ]);
  });

  it("composes again with that report, so Loom is not offered the refused agent", async () => {
    const { calls, materialize } = countingMaterialize();
    const result = await new OpenCodeAgentMaterializer({
      materializeAgents: materialize,
      translate: refusing("shuttle-web"),
    }).materialize(config());

    expect(calls).toHaveLength(2);
    expect(calls[1]?.harness?.failed.map((f) => f.agentName)).toEqual([
      "shuttle-web",
    ]);
    const loomPrompt = String(result.translated.get("loom")?.prompt);
    expect(loomPrompt).toContain("**shuttle-api**");
    expect(loomPrompt).not.toContain("shuttle-web");
  });
});

describe("OpenCodeAgentMaterializer — one agent's model does not resolve", () => {
  it("reports it as model_unresolved and leaves it out of Loom's list", async () => {
    const result = await new OpenCodeAgentMaterializer({
      resolveModel: (descriptor) =>
        descriptor.name === "shuttle-api"
          ? err({
              type: "ModelNotAvailableError",
              agentName: "shuttle-api",
              requestedModels: ["openai/gpt-9"],
              availableModels: [],
              message: "openai/gpt-9 is not available",
            })
          : ok(undefined),
    }).materialize(config());

    expect(result.report.failed).toEqual([
      {
        agentName: "shuttle-api",
        reason: "model_unresolved",
        message: "openai/gpt-9 is not available",
      },
    ]);
    const loomPrompt = String(result.translated.get("loom")?.prompt);
    expect(loomPrompt).toContain("**shuttle-web**");
    expect(loomPrompt).not.toContain("shuttle-api");
  });
});
