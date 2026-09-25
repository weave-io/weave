/**
 * materialization-availability.test.ts
 *
 * Delegation targets come from materialized agents, not from config
 * (ADR 0013, Spec 38 item 2). Pure-function tests of `materializeAgents()`:
 * the config is inline DSL, the harness report is fixture data, and no
 * harness or disk is involved.
 *
 * Covers:
 * - An agent whose descriptor fails to compose is offered to no router, with
 *   or without a harness report, and is recorded as `composition_failed`.
 * - A harness report's failures are offered to no router and keep their
 *   reason; an agent the report does not mention is `not_reported`.
 * - With no report, every agent that composes is offered.
 * - A review variant the harness refused is left out of review routing too.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import { okAsync } from "neverthrow";

import type { PromptFileReader } from "../compose.js";
import {
  type HarnessMaterializationReport,
  type MaterializationPlan,
  materializeAgents,
} from "../materialization.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = [
  "You are {{agent.name}}.",
  "{{#delegation.targets}}",
  "- **{{name}}** — {{description}}",
  "{{/delegation.targets}}",
  "{{#reviewRouting.groups}}",
  "{{#variants}}",
  "- review with {{name}}",
  "{{/variants}}",
  "{{/reviewRouting.groups}}",
].join("\n");

/** Loom routes; shuttle and two categories are the specialists it may pick. */
const CONFIG = `
agent loom {
  description "Router"
  prompt "${ROUTER_PROMPT.replaceAll("\n", "\\n")}"
  mode primary
}

agent shuttle {
  description "Generalist"
  prompt "You are shuttle."
  mode subagent
  tool_policy {
    delegate deny
  }
}

agent helper {
  description "Helper"
  prompt "You are helper."
  mode subagent
}

category api {
  description "HTTP handlers"
}

category broken {
  description "A category with a template typo"
  prompt_append "Focus on {{nope}}."
}
`;

function config(source: string = CONFIG): WeaveConfig {
  const parsed = parseConfig(source);
  if (parsed.isErr()) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

/** Every prompt here is inline, so the reader is never asked for a file. */
const NO_FILES: PromptFileReader = { read: () => okAsync("") };

async function materialize(
  harness?: HarnessMaterializationReport,
  source?: string,
): Promise<MaterializationPlan> {
  return (
    await materializeAgents({
      config: config(source),
      promptFileReader: NO_FILES,
      harness,
    })
  )._unsafeUnwrap();
}

function targetsOf(plan: MaterializationPlan, name: string): string[] {
  const agent = plan.agents.find((entry) => entry.agentName === name);
  if (agent === undefined) throw new Error(`no agent ${name}`);
  return agent.descriptor.delegationTargets.map((target) => target.name);
}

function promptOf(plan: MaterializationPlan, name: string): string {
  const agent = plan.agents.find((entry) => entry.agentName === name);
  if (agent === undefined) throw new Error(`no agent ${name}`);
  return agent.descriptor.composedPrompt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("materializeAgents — an agent that fails to compose", () => {
  it("is offered to no router, even with no harness report", async () => {
    const plan = await materialize();

    expect(targetsOf(plan, "loom")).toEqual([
      "shuttle",
      "helper",
      "shuttle-api",
    ]);
    expect(promptOf(plan, "loom")).not.toContain("shuttle-broken");
  });

  it("is recorded as unavailable because it did not compose", async () => {
    const plan = await materialize();

    expect(plan.unavailableAgents).toEqual([
      {
        agentName: "shuttle-broken",
        reason: "composition_failed",
        message: expect.stringContaining("nope"),
      },
    ]);
  });

  it("keeps the composition reason when the adapter's report omits the agent", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle", "helper", "shuttle-api"],
      failed: [],
    });

    expect(
      plan.unavailableAgents.map(({ agentName, reason }) => ({
        agentName,
        reason,
      })),
    ).toEqual([{ agentName: "shuttle-broken", reason: "composition_failed" }]);
  });
});

describe("materializeAgents — with a harness report", () => {
  it("offers only the agents the report lists as materialized", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle", "shuttle-api"],
      failed: [
        {
          agentName: "helper",
          reason: "name_taken",
          message: "the host already holds helper",
        },
      ],
    });

    expect(targetsOf(plan, "loom")).toEqual(["shuttle", "shuttle-api"]);
    expect(promptOf(plan, "loom")).not.toContain("helper");
  });

  it("records each refused agent with the reason the adapter gave", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle", "shuttle-api"],
      failed: [
        {
          agentName: "helper",
          reason: "translation_failed",
          message: "cannot translate",
        },
      ],
    });

    expect(plan.unavailableAgents).toContainEqual({
      agentName: "helper",
      reason: "translation_failed",
      message: "cannot translate",
    });
  });

  it("treats an agent the report does not mention as not materialized", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle"],
      failed: [],
    });

    expect(targetsOf(plan, "loom")).toEqual(["shuttle"]);
    expect(plan.unavailableAgents).toContainEqual({
      agentName: "shuttle-api",
      reason: "not_reported",
    });
  });

  it("lets a reported failure win over the same name listed as materialized", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle", "helper", "shuttle-api"],
      failed: [{ agentName: "helper", reason: "model_unresolved" }],
    });

    expect(targetsOf(plan, "loom")).toEqual(["shuttle", "shuttle-api"]);
  });

  it("still hands the adapter every descriptor that composed", async () => {
    const plan = await materialize({
      materialized: ["loom", "shuttle"],
      failed: [{ agentName: "helper", reason: "name_taken" }],
    });

    expect(plan.agents.map((entry) => entry.agentName)).toEqual([
      "loom",
      "shuttle",
      "helper",
      "shuttle-api",
    ]);
  });
});

describe("materializeAgents — with no harness report and nothing broken", () => {
  it("offers every agent that composes and records none as unavailable", async () => {
    const plan = await materialize(
      undefined,
      CONFIG.replace(/category broken \{[\s\S]*?\n\}\n/, ""),
    );

    expect(targetsOf(plan, "loom")).toEqual([
      "shuttle",
      "helper",
      "shuttle-api",
    ]);
    expect(plan.unavailableAgents).toEqual([]);
  });
});

describe("materializeAgents — review variants", () => {
  const WITH_REVIEWER = `${CONFIG.replace(/category broken \{[\s\S]*?\n\}\n/, "")}
agent weft {
  description "Reviewer"
  prompt "You are weft."
  mode subagent
  review_models ["openai/gpt-5", "google/gemini-3"]
}
`;

  it("leaves a refused variant out of the router's review routing", async () => {
    const all = await materialize(undefined, WITH_REVIEWER);
    const variants = all.agents
      .filter((entry) => entry.source === "review-variant")
      .map((entry) => entry.agentName);
    expect(variants).toHaveLength(2);
    const [kept = "", refused = ""] = variants;
    expect(promptOf(all, "loom")).toContain(`review with ${refused}`);

    const plan = await materialize(
      {
        materialized: all.agents
          .map((entry) => entry.agentName)
          .filter((name) => name !== refused),
        failed: [{ agentName: refused, reason: "name_taken" }],
      },
      WITH_REVIEWER,
    );

    expect(promptOf(plan, "loom")).toContain(`review with ${kept}`);
    expect(promptOf(plan, "loom")).not.toContain(refused);
  });
});
