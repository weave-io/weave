import { describe, expect, it } from "bun:test";

import type { DispatchAgentEffect } from "@weaveio/weave-engine";
import {
  composeDelegatedPrompt,
  renderPrompt,
  slugify,
} from "../projection-helpers.js";

describe("renderPrompt", () => {
  it("substitutes a single known placeholder", () => {
    expect(renderPrompt("Hello {{name}}!", { name: "World" })).toBe(
      "Hello World!",
    );
  });

  it("substitutes multiple placeholders", () => {
    expect(renderPrompt("{{a}}-{{b}}-{{a}}", { a: "x", b: "y" })).toBe("x-y-x");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderPrompt("Hello {{unknown}}!", {})).toBe("Hello {{unknown}}!");
  });

  it("tolerates whitespace inside braces", () => {
    expect(renderPrompt("{{ name }}", { name: "value" })).toBe("value");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Implement Authentication")).toBe(
      "implement-authentication",
    );
  });

  it("collapses runs of non-alphanumeric characters", () => {
    expect(slugify("foo!!  bar??baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("falls back to 'untitled' for empty/all-punctuation input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });
});

describe("composeDelegatedPrompt", () => {
  it("wraps the agent's composedPrompt in a weave-step-dispatch envelope", () => {
    const effect = {
      kind: "dispatch-agent",
      runAgent: {
        kind: "run-agent",
        agentName: "shuttle",
        agentDescriptor: {
          name: "shuttle",
          composedPrompt: "Do the thing.",
          models: [],
          mode: "subagent",
          effectiveToolPolicy: {
            read: "allow",
            write: "allow",
            execute: "allow",
            delegate: "deny",
            network: "ask",
          },
          rawToolPolicy: undefined,
          delegationTargets: [],
          skills: [],
        },
      },
    } as unknown as DispatchAgentEffect;

    const text = composeDelegatedPrompt(effect);
    expect(text).toContain('agent="shuttle"');
    expect(text).toContain("Do the thing.");
  });
});
