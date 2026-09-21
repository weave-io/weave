/**
 * DSL scenarios — the prompt template language.
 *
 * Bucket: DSL. Every prompt a user writes is a Mustache template rendered
 * against a fixed set of facts Weave knows about the agent. These scenarios
 * describe the two halves of that bargain: what a prompt may reach for, and
 * what happens when it reaches for anything else.
 *
 * The negative cases come in pairs with a positive one on purpose — a prompt
 * that fails to render and a prompt that renders nothing look identical from
 * the outside unless something proves the tag works when it is spelled right.
 */

import { describe, expect, it } from "bun:test";
import {
  agentNames,
  failures,
  promptFor,
  refusals,
  whenMaterialized,
} from "../support/scenario.js";

/** One agent whose prompt is whatever the scenario wants to render. */
function agentWithPrompt(prompt: string): string {
  return `
    agent probe {
      description "Probe (Specialist)"
      prompt "${prompt}"
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
      skills ["tdd", "code-review"]

      tool_policy {
        read allow
        write deny
        execute ask
        delegate deny
        network deny
      }
    }
  `;
}

describe("a user fills a prompt from everything Weave knows about the agent", () => {
  const config = `
    agent loom {
      description "Loom (Main Orchestrator)"
      prompt """
      I am {{agent.name}} — {{agent.description}}, running as {{agent.mode}}.
      My skills: {{#agent.skills}}[{{.}}]{{/agent.skills}}
      I may read: {{toolPolicy.effective.read}}, write: {{toolPolicy.effective.write}},
      execute: {{toolPolicy.effective.execute}}, delegate: {{toolPolicy.effective.delegate}},
      network: {{toolPolicy.effective.network}}.
      {{#delegation.targets}}
      -> {{name}} ({{description}}) category={{isCategory}}{{#triggers}} when: {{.}}{{/triggers}}
      {{/delegation.targets}}
      {{^agent.isCategory}}I am not a category shuttle.{{/agent.isCategory}}
      """
      models ["anthropic/claude-sonnet-4-5"]
      mode primary
      skills ["planning"]

      tool_policy {
        read allow
        write ask
        execute deny
        delegate allow
        network ask
      }
    }

    agent shuttle {
      description "Shuttle (Domain Specialist)"
      prompt """
      I am {{agent.name}}.
      {{#agent.isCategory}}I specialise in {{category.name}}: {{category.description}}.{{/agent.isCategory}}
      """
      models ["anthropic/claude-sonnet-4-5"]
      mode all

      triggers ["Use for writing and changing code"]
    }

    category frontend {
      description "Frontend UI, styling, accessibility"
    }
  `;

  it("fills in the agent's own identity", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "I am loom — Loom (Main Orchestrator), running as primary.",
    );
  });

  it("loops over the skills the user declared", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain("My skills: [planning]");
  });

  it("tells the model what it is allowed to do, in the words the user wrote", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "I may read: allow, write: ask,\nexecute: deny, delegate: allow,\nnetwork: ask.",
    );
  });

  it("loops over delegation targets with their descriptions and triggers", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "-> shuttle (Shuttle (Domain Specialist)) category=false when: Use for writing and changing code",
    );
    expect(promptFor(plan, "loom")).toContain(
      "-> shuttle-frontend (Frontend UI, styling, accessibility) category=true",
    );
  });

  it("takes the inverted branch for an agent that is not a category shuttle", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain("I am not a category shuttle.");
    expect(promptFor(plan, "shuttle")).toContain("I am shuttle.");
    expect(promptFor(plan, "shuttle")).not.toContain("I specialise in");
  });

  it("takes the category branch, with the category's own name and description", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "shuttle-frontend")).toContain(
      "I specialise in frontend: Frontend UI, styling, accessibility.",
    );
  });
});

describe("a user reaches for config Weave does not put in the prompt", () => {
  /**
   * Every one of these is a plausible thing to try and none of them exists in
   * the template context. The contrast case above proves the tags that do
   * exist render, so a failure here is the guard working rather than a value
   * that was never going to arrive.
   */
  const rejected = [
    "{{agent.models}}",
    "{{agent.temperature}}",
    "{{agent.prompt_file}}",
    "{{agent.variant}}",
    "{{toolPolicy.raw.write}}",
    "{{config.agents}}",
    "{{domains}}",
    "{{delegation.section}}",
    "{{delegation.mermaid}}",
    "{{{delegation.section}}}",
  ];

  it.each(
    rejected,
  )("refuses to compose an agent whose prompt uses %s", async (tag) => {
    const plan = await whenMaterialized(agentWithPrompt(tag));

    expect(failures(plan)).toEqual(["probe: PromptTemplateError"]);
    expect(agentNames(plan)).toEqual([]);
  });

  it("refuses a misspelled path rather than rendering an empty gap", async () => {
    const plan = await whenMaterialized(
      agentWithPrompt("You are {{agent.nmae}}."),
    );

    expect(failures(plan)).toEqual(["probe: PromptTemplateError"]);
  });

  it("refuses a loop over something the context does not hold", async () => {
    const plan = await whenMaterialized(
      agentWithPrompt("{{#agent.skils}}{{.}}{{/agent.skils}}"),
    );

    expect(refusals(plan)).toEqual(["UnknownPath"]);
  });

  it("refuses a bad tag in a branch that would never have rendered", async () => {
    const plan = await whenMaterialized(
      agentWithPrompt(
        "{{#agent.isCategory}}I am {{category.invented}}{{/agent.isCategory}}",
      ),
    );

    expect(refusals(plan)).toEqual(["UnknownPath"]);
  });

  it("refuses an unknown field inside a delegation loop", async () => {
    const plan = await whenMaterialized(`
      agent router {
        prompt "{{#delegation.targets}}{{bogus}}{{/delegation.targets}}"
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent helper {
        prompt "You are helper."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(failures(plan)).toEqual(["router: PromptTemplateError"]);
  });
});

describe("a prompt tries to walk out of the context it was given", () => {
  /**
   * Each of these is rejected twice over — the segment is unsafe *and* the
   * path is not in the context — so the scenarios assert which refusal the
   * user is shown, not merely that one happened. Asserting only "it failed"
   * would stay green with the prototype guard removed.
   */
  const traversals = [
    "{{__proto__}}",
    "{{agent.__proto__.polluted}}",
    "{{constructor}}",
    "{{agent.constructor.name}}",
    "{{hasOwnProperty}}",
  ];

  it.each(
    traversals,
  )("refuses %s as prototype traversal rather than as a typo", async (tag) => {
    const plan = await whenMaterialized(agentWithPrompt(tag));

    expect(refusals(plan)).toEqual(["UnsafePath"]);
    expect(agentNames(plan)).toEqual([]);
  });

  const unsupported = ["{{> footer}}", "{{=<% %>=}}"];

  it.each(
    unsupported,
  )("refuses %s as a Mustache feature Weave does not offer", async (tag) => {
    const plan = await whenMaterialized(agentWithPrompt(tag));

    expect(refusals(plan)).toEqual(["UnsupportedTag"]);
    expect(agentNames(plan)).toEqual([]);
  });

  const malformed = ["You are {{agent.name", "{{#agent.skills}}[{{.}}]"];

  it.each(
    malformed,
  )("refuses a template left unclosed at %s", async (prompt) => {
    const plan = await whenMaterialized(agentWithPrompt(prompt));

    expect(refusals(plan)).toEqual(["MalformedSyntax"]);
  });

  it("refuses an appended file that tries the same escapes", async () => {
    const plan = await whenMaterialized(
      `
        agent probe {
          prompt "You are probe."
          prompt_append_file "extra.md"
          models ["anthropic/claude-sonnet-4-5"]
          mode subagent
        }
      `,
      { promptFiles: { "extra.md": "{{> footer}}" } },
    );

    expect(failures(plan)).toEqual(["probe: PromptTemplateError"]);
  });
});

describe("a prompt reaches for the session it is about to run in", () => {
  /**
   * The bounded context is what keeps a prompt from quoting an artifact, a
   * transcript or another agent's raw prompt back at the model. None of these
   * paths exists, and the contrast case above proves the ones that do exist
   * render, so these refusals are the boundary holding rather than a tag that
   * was never going to resolve.
   */
  const leaks = [
    "{{artifact.contents}}",
    "{{artifacts.0.content}}",
    "{{chat.history}}",
    "{{session.messages}}",
    "{{prompt.raw}}",
  ];

  it.each(leaks)("refuses a prompt that asks for %s", async (tag) => {
    const plan = await whenMaterialized(agentWithPrompt(tag));

    expect(refusals(plan)).toEqual(["UnknownPath"]);
  });

  it.each(leaks)("refuses appended guidance that asks for %s", async (tag) => {
    const plan = await whenMaterialized(`
      agent probe {
        prompt "You are probe."
        prompt_append "${tag}"
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(refusals(plan)).toEqual(["UnknownPath"]);
  });
});

describe("a user's prompt asks for something the agent simply does not have", () => {
  it("renders it as nothing, because the path exists even when the value does not", async () => {
    const plan = await whenMaterialized(`
      agent nameless {
        prompt "I am {{agent.name}}[{{agent.description}}] and I know {{#agent.skills}}{{.}}{{/agent.skills}}."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(promptFor(plan, "nameless")).toBe("I am nameless[] and I know .");
  });
});

describe("a user nominates review models for an agent", () => {
  /**
   * Each review model becomes its own agent, and a router that can delegate to
   * the source agent is told which variants exist so its prompt can fan a
   * review out across them.
   */
  const config = `
    agent loom {
      prompt """
      {{#reviewRouting.groups}}
      Reviewers for {{sourceAgent}}:{{#variants}} {{name}} ({{{model}}}){{/variants}}
      {{/reviewRouting.groups}}
      """
      models ["anthropic/claude-sonnet-4-5"]
      mode primary

      tool_policy { delegate allow }
    }

    agent weft {
      prompt "You are Weft."
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent

      review_models ["openai/gpt-5", "anthropic/claude-opus-4-1"]
    }
  `;

  it("lists every variant under the agent it reviews for", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "loom")).toContain(
      "Reviewers for weft: weft-openai-gpt-5 (openai/gpt-5) weft-anthropic-claude-opus-4-1 (anthropic/claude-opus-4-1)",
    );
  });

  it("needs the triple-brace form to print a model id with a slash in it", async () => {
    const escaped = await whenMaterialized(
      config.replace("{{{model}}}", "{{model}}"),
    );

    expect(promptFor(escaped, "loom")).toContain("(openai&#x2F;gpt-5)");
  });

  it("says nothing about review routing to an agent that cannot delegate", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "weft")).toBe("You are Weft.");
  });
});

describe("a user wants to write about Mustache tags in a prompt", () => {
  /**
   * The backslash count differs by string form because two layers read it: the
   * `.weave` lexer unescapes a double-quoted string and leaves a triple-quoted
   * one alone, and only then does the renderer see `\{{` and protect the tag.
   * So a double-quoted prompt needs `\\{{` and a triple-quoted one needs `\{{`
   * — recorded because a user who writes the wrong one gets their agent's name
   * interpolated where they wanted to show the tag, with no error.
   */
  it("leaves a doubly-escaped tag in a double-quoted prompt as literal text", async () => {
    const plan = await whenMaterialized(`
      agent teacher {
        prompt "Write \\\\{{agent.name}} to show a tag, and {{agent.name}} to use one."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(promptFor(plan, "teacher")).toBe(
      "Write {{agent.name}} to show a tag, and teacher to use one.",
    );
  });

  it("leaves a singly-escaped tag in a triple-quoted prompt as literal text", async () => {
    const plan = await whenMaterialized(`
      agent teacher {
        prompt """
        Write \\{{agent.name}} to show a tag, and {{agent.name}} to use one.
        """
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(promptFor(plan, "teacher")).toContain(
      "Write {{agent.name}} to show a tag, and teacher to use one.",
    );
  });

  it("keeps a comment out of the rendered prompt", async () => {
    const plan = await whenMaterialized(`
      agent quiet {
        prompt "Before.{{! a note to my future self }}After."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent
      }
    `);

    expect(promptFor(plan, "quiet")).toBe("Before.After.");
  });
});

describe("a user's description contains characters that mean something in HTML", () => {
  /**
   * Recorded, not endorsed: a prompt is not a web page, but `{{...}}` is
   * Mustache's HTML-escaping form, so the ampersand reaches the model as
   * `&amp;` unless the user writes the triple-brace form. Pinned here so the
   * escape hatch cannot disappear without a scenario noticing.
   */
  const config = `
    agent research {
      description "R&D <strong> specialist"
      prompt "Escaped: {{agent.description}} | Raw: {{{agent.description}}} | Also raw: {{&agent.description}}"
      models ["anthropic/claude-sonnet-4-5"]
      mode subagent
    }
  `;

  it("escapes it in a double-brace tag", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "research")).toContain(
      "Escaped: R&amp;D &lt;strong&gt; specialist",
    );
  });

  it("leaves it alone in a triple-brace or ampersand tag", async () => {
    const plan = await whenMaterialized(config);

    expect(promptFor(plan, "research")).toContain(
      "Raw: R&D <strong> specialist | Also raw: R&D <strong> specialist",
    );
  });

  /**
   * The same escaping reaches a router's delegation table, which is where it
   * costs something: an apostrophe in a trigger is the ordinary way to write
   * one, and `{{.}}` inside `{{#triggers}}` is the form the shipped `loom.md`
   * uses. Recorded as observed — the model is shown `&#39;`.
   */
  it("escapes an apostrophe in a trigger the same way, where a router's prompt lists it", async () => {
    const plan = await whenMaterialized(`
      agent loom {
        prompt "{{#delegation.targets}}{{#triggers}}- {{.}}{{/triggers}}{{/delegation.targets}}"
        models ["anthropic/claude-sonnet-4-5"]
        mode primary

        tool_policy { delegate allow }
      }

      agent thread {
        prompt "You are Thread."
        models ["anthropic/claude-sonnet-4-5"]
        mode subagent

        triggers ["Use when answering 'where is X' questions"]
      }
    `);

    expect(promptFor(plan, "loom")).toBe(
      "- Use when answering &#39;where is X&#39; questions",
    );
  });
});
