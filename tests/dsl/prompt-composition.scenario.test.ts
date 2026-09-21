/**
 * DSL scenarios — prompt composition.
 *
 * Bucket: DSL. What a user writes in `prompt` / `prompt_append` is what the
 * model eventually reads, after Weave renders it as a Mustache template and
 * fills in what it knows about the agent. These are the promises behind
 * "the prompt I wrote is the prompt that runs".
 *
 * Prompt files are supplied through the reader an adapter passes to
 * `materializeAgents`, so a scenario describes the user's `prompts/` directory
 * without touching a disk.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weaveio/weave-core";
import {
  agent,
  agentNames,
  dedent,
  failures,
  promptFor,
  promptLibrary,
  whenMaterialized,
  whenMaterializedWith,
} from "../support/scenario.js";

describe("a user writes a plain prompt with no template tags", () => {
  it("passes it through unchanged", async () => {
    const plan = await whenMaterialized(`
      agent plain {
        prompt "You are plain. Do exactly this and nothing else."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agent(plan, "plain").descriptor.composedPrompt).toContain(
      "You are plain. Do exactly this and nothing else.",
    );
  });
});

describe("a user references the agent's own name in their prompt", () => {
  it("fills it in, so the prompt does not have to repeat the config", async () => {
    const plan = await whenMaterialized(`
      agent weaver {
        prompt "You are {{agent.name}}, and you work in {{agent.mode}} mode."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const composed = agent(plan, "weaver").descriptor.composedPrompt;

    expect(composed).toContain("You are weaver");
    expect(composed).toContain("subagent mode");
    expect(composed).not.toContain("{{agent.name}}");
  });
});

describe("a user appends guidance to an agent's prompt", () => {
  it("keeps the original prompt and adds the appended text after it", async () => {
    const plan = await whenMaterialized(`
      agent shuttle {
        prompt "BASE PROMPT."
        prompt_append "APPENDED GUIDANCE."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    const composed = agent(plan, "shuttle").descriptor.composedPrompt;

    expect(composed).toBe("BASE PROMPT.\n\nAPPENDED GUIDANCE.");
  });
});

describe("a user appends nothing at all", () => {
  it("leaves the prompt exactly as written, with no trailing section", async () => {
    const plan = await whenMaterialized(`
      agent bare {
        prompt "You are bare."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(promptFor(plan, "bare")).toBe("You are bare.");
  });
});

describe("a user keeps an agent's prompt in a file next to their config", () => {
  const config = `
    agent loom {
      prompt_file "loom.md"
      prompt_append_file "house-style.md"
      models ["anthropic/claude-sonnet-4-5"]
      mode primary
    }
  `;

  const promptFiles = {
    "loom.md": "You are {{agent.name}}, the orchestrator.",
    "house-style.md": "House style: short sentences.",
  };

  it("gives the model the file's contents, rendered like an inline prompt", async () => {
    const plan = await whenMaterialized(config, { promptFiles });

    expect(promptFor(plan, "loom")).toContain(
      "You are loom, the orchestrator.",
    );
  });

  it("appends the second file after the first, in the order they are declared", async () => {
    const plan = await whenMaterialized(config, { promptFiles });

    expect(promptFor(plan, "loom")).toBe(
      "You are loom, the orchestrator.\n\nHouse style: short sentences.",
    );
  });

  it("reads each file once however many agents share it", async () => {
    const prompts = promptLibrary(promptFiles);

    await whenMaterializedWith(
      `
        agent one {
          prompt_file "loom.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent two {
          prompt_file "loom.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }

        agent three {
          prompt_file "loom.md"
          prompt_append_file "house-style.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      prompts,
    );

    expect(prompts.reads.sort()).toEqual(["house-style.md", "loom.md"]);
  });
});

describe("a user points an agent at a prompt file that is not there", () => {
  const config = `
    agent typo {
      prompt_file "lom.md"
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }

    agent fine {
      prompt "You are fine."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }
  `;

  const promptFiles = { "loom.md": "You are loom." };

  it("names the agent whose file could not be read", async () => {
    const plan = await whenMaterialized(config, { promptFiles });

    expect(failures(plan)).toEqual(["typo: PromptFileReadError"]);
  });

  it("still resolves every other agent, so one typo is not a dead config", async () => {
    const plan = await whenMaterialized(config, { promptFiles });

    expect(agentNames(plan)).toEqual(["fine"]);
  });
});

describe("a user's appended prompt file is missing", () => {
  it("fails the agent rather than quietly dropping the guidance", async () => {
    const plan = await whenMaterialized(
      `
        agent shuttle {
          prompt "You are Shuttle."
          prompt_append_file "missing.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      { promptFiles: {} },
    );

    expect(failures(plan)).toEqual(["shuttle: PromptFileReadError"]);
    expect(agentNames(plan)).toEqual([]);
  });
});

describe("a user writes template tags in the appended guidance", () => {
  it("renders the append too, not only the primary prompt", async () => {
    const plan = await whenMaterialized(
      `
        agent shuttle {
          prompt "You are Shuttle."
          prompt_append_file "policy.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent

          tool_policy { write deny }
        }
      `,
      {
        promptFiles: {
          "policy.md":
            "{{agent.name}} may write: {{toolPolicy.effective.write}}.",
        },
      },
    );

    expect(promptFor(plan, "shuttle")).toContain("shuttle may write: deny.");
  });
});

describe("a user references a template path Weave does not provide", () => {
  it("fails composition instead of rendering an empty string", async () => {
    const plan = await whenMaterialized(`
      agent typo {
        prompt "You are {{agent.nmae}}."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agentNames(plan)).not.toContain("typo");
    expect(failures(plan)).toEqual(["typo: PromptTemplateError"]);
  });
});

describe("the bad template tag is in a prompt file rather than the config", () => {
  it("names the file, so the user knows which document to open", async () => {
    const plan = await whenMaterialized(
      `
        agent typo {
          prompt_file "typo.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      { promptFiles: { "typo.md": "You are {{agent.models}}." } },
    );

    expect(plan.errors).toEqual([
      expect.objectContaining({
        type: "DescriptorCompositionFailure",
        agentName: "typo",
        cause: expect.objectContaining({
          type: "PromptTemplateError",
          sourceKind: "prompt_file",
          promptFilePath: "typo.md",
        }),
      }),
    ]);
  });
});

describe("the bad template tag is in the appended guidance", () => {
  it("blames the append rather than the prompt the user did get right", async () => {
    const plan = await whenMaterialized(`
      agent typo {
        prompt "You are fine."
        prompt_append "But {{agent.temperature}} is not."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(plan.errors).toEqual([
      expect.objectContaining({
        cause: expect.objectContaining({
          type: "PromptTemplateError",
          sourceKind: "prompt_append",
        }),
      }),
    ]);
  });
});

describe("a user's own text happens to contain braces", () => {
  it("renders the prompt once, so text drawn from config is never re-rendered", async () => {
    const plan = await whenMaterialized(`
      agent router {
        description "{{example}}"
        prompt "{{{agent.description}}} {{#delegation.targets}}{{{description}}} {{#triggers}}{{{.}}}{{/triggers}}{{/delegation.targets}}"
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent helper {
        description "{{{example}}}"
        prompt "You are helper."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        triggers ["{{hint}}", "{{> footer}}", "{{=<% %>=}}"]
      }
    `);

    expect(promptFor(plan, "router")).toBe(
      "{{example}} {{{example}}} {{hint}}{{> footer}}{{=<% %>=}}",
    );
  });
});

describe("a user declares both an inline prompt and a prompt file", () => {
  it("is rejected, rather than one silently winning", () => {
    const result = parseConfig(
      dedent(`
        agent confused {
          prompt "Inline."
          prompt_file "confused.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `),
    );

    expect(result.isErr()).toBe(true);
  });
});

describe("a user declares an agent with no prompt at all", () => {
  it("is reported as a failure for that agent while the others still resolve", async () => {
    const plan = await whenMaterialized(`
      agent good {
        prompt "You are good."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }

      agent promptless {
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(agentNames(plan)).toEqual(["good"]);
    expect(failures(plan)).toEqual(["promptless: PromptSourceMissingError"]);
  });
});

describe("a user asks what an adapter is given for their agent", () => {
  it("hands over the composed prompt and never the sources it was built from", async () => {
    const plan = await whenMaterialized(
      `
        agent shuttle {
          prompt_file "shuttle.md"
          prompt_append "Extra guidance."
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      { promptFiles: { "shuttle.md": "You are Shuttle." } },
    );

    const descriptor = agent(plan, "shuttle").descriptor;

    expect(descriptor.composedPrompt).toBe(
      "You are Shuttle.\n\nExtra guidance.",
    );
    expect(Object.keys(descriptor)).not.toContain("prompt");
    expect(Object.keys(descriptor)).not.toContain("prompt_file");
    expect(Object.keys(descriptor)).not.toContain("prompt_append");
  });
});
