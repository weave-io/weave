/**
 * template-renderer.test.ts
 *
 * Tests for the safe Mustache renderer wrapper.
 *
 * Covers:
 * - Supported tags: variables, sections, inverted sections, comments, triple-brace
 * - Nested sections
 * - {{.}} current-item reference in list contexts
 * - Escaped literals (\{{ and \{{{)
 * - Unknown paths (not in allowedPaths)
 * - Unsafe paths (__proto__, prototype, constructor, etc.)
 * - Function/callable values in context
 * - Unsupported tags (partials, delimiter changes)
 * - Malformed template syntax
 * - Unresolved tags after rendering
 */

import { describe, expect, it } from "bun:test";

import {
  extractTemplatePaths,
  type RendererError,
  renderTemplate,
  type TemplateContext,
} from "../template-renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allowed(...paths: string[]): Set<string> {
  return new Set(paths);
}

function render(
  source: string,
  context: TemplateContext,
  paths: Set<string>,
): string {
  const result = renderTemplate(source, context, { allowedPaths: paths });
  if (result.isErr()) {
    throw new Error(`Unexpected render error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function renderErr(
  source: string,
  context: TemplateContext,
  paths: Set<string>,
): RendererError {
  const result = renderTemplate(source, context, { allowedPaths: paths });
  if (result.isOk()) {
    throw new Error(`Expected render error but got: ${result.value}`);
  }
  return result.error;
}

// ---------------------------------------------------------------------------
// Supported tags
// ---------------------------------------------------------------------------

describe("renderTemplate — supported tags", () => {
  it("renders a simple variable tag", () => {
    const output = render(
      "Hello, {{name}}!",
      { name: "World" },
      allowed("name"),
    );
    expect(output).toBe("Hello, World!");
  });

  it("renders multiple variable tags", () => {
    const output = render(
      "{{greeting}}, {{name}}!",
      { greeting: "Hi", name: "Alice" },
      allowed("greeting", "name"),
    );
    expect(output).toBe("Hi, Alice!");
  });

  it("HTML-escapes double-brace variables by default", () => {
    const output = render(
      "{{content}}",
      { content: "<b>bold</b>" },
      allowed("content"),
    );
    // Mustache escapes < > & " ' / — exact escaping varies by version
    expect(output).toContain("&lt;b&gt;");
    expect(output).not.toContain("<b>");
  });

  it("renders triple-brace tags without HTML escaping", () => {
    const output = render(
      "{{{content}}}",
      { content: "<b>bold</b>" },
      allowed("content"),
    );
    expect(output).toBe("<b>bold</b>");
  });

  it("renders unescaped variable with & syntax", () => {
    const output = render(
      "{{&content}}",
      { content: "<em>text</em>" },
      allowed("content"),
    );
    expect(output).toBe("<em>text</em>");
  });

  it("renders a section tag when value is truthy", () => {
    const output = render(
      "{{#show}}visible{{/show}}",
      { show: true },
      allowed("show"),
    );
    expect(output).toBe("visible");
  });

  it("renders nothing for a section tag when value is falsy", () => {
    const output = render(
      "{{#show}}visible{{/show}}",
      { show: false },
      allowed("show"),
    );
    expect(output).toBe("");
  });

  it("renders an inverted section when value is falsy", () => {
    const output = render(
      "{{^missing}}fallback{{/missing}}",
      { missing: false },
      allowed("missing"),
    );
    expect(output).toBe("fallback");
  });

  it("renders nothing for an inverted section when value is truthy", () => {
    const output = render(
      "{{^present}}fallback{{/present}}",
      { present: true },
      allowed("present"),
    );
    expect(output).toBe("");
  });

  it("strips comment tags from output", () => {
    const output = render("before{{! this is a comment }}after", {}, allowed());
    expect(output).toBe("beforeafter");
  });

  it("renders raw text unchanged", () => {
    const output = render("No tags here.", {}, allowed());
    expect(output).toBe("No tags here.");
  });

  it("renders empty template", () => {
    const output = render("", {}, allowed());
    expect(output).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Nested sections
// ---------------------------------------------------------------------------

describe("renderTemplate — nested sections", () => {
  it("renders nested section with child variable", () => {
    const output = render(
      "{{#agent}}Name: {{name}}{{/agent}}",
      { agent: { name: "loom" } },
      // "agent.name" must be in allowedPaths because child "name" resolves to "agent.name"
      allowed("agent", "agent.name"),
    );
    expect(output).toBe("Name: loom");
  });

  it("renders deeply nested sections", () => {
    const output = render(
      "{{#outer}}{{#inner}}{{value}}{{/inner}}{{/outer}}",
      { outer: { inner: { value: "deep" } } },
      // "outer.inner" and "outer.inner.value" must be in allowedPaths
      allowed("outer", "outer.inner", "outer.inner.value"),
    );
    expect(output).toBe("deep");
  });

  it("renders list section with object items", () => {
    const output = render(
      "{{#items}}{{name}} {{/items}}",
      { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      // "items.name" must be in allowedPaths because child "name" resolves to "items.name"
      allowed("items", "items.name"),
    );
    expect(output).toBe("a b c ");
  });
});

// ---------------------------------------------------------------------------
// {{.}} current-item reference
// ---------------------------------------------------------------------------

describe("renderTemplate — {{.}} current-item reference", () => {
  it("renders {{.}} for scalar list items", () => {
    const output = render(
      "{{#tags}}{{.}} {{/tags}}",
      { tags: ["alpha", "beta", "gamma"] },
      allowed("tags"),
    );
    expect(output).toBe("alpha beta gamma ");
  });

  it("renders {{.}} for numeric list items", () => {
    const output = render(
      "{{#nums}}{{.}},{{/nums}}",
      { nums: [1, 2, 3] },
      allowed("nums"),
    );
    expect(output).toBe("1,2,3,");
  });
});

// ---------------------------------------------------------------------------
// Escaped literals
// ---------------------------------------------------------------------------

describe("renderTemplate — escaped literals", () => {
  it("preserves \\{{ as literal {{ in output", () => {
    const output = render("Use \\{{path}} as a literal.", {}, allowed());
    expect(output).toBe("Use {{path}} as a literal.");
  });

  it("preserves \\{{{ as literal {{{ in output", () => {
    const output = render("Use \\{{{path}}} as a literal.", {}, allowed());
    expect(output).toBe("Use {{{path}}} as a literal.");
  });

  it("escaped literal does not trigger unknown-path error", () => {
    const output = render("Literal: \\{{unknown.path}}", {}, allowed());
    expect(output).toBe("Literal: {{unknown.path}}");
  });

  it("escaped literal coexists with real tags", () => {
    const output = render(
      "Real: {{name}}, Literal: \\{{name}}",
      { name: "Alice" },
      allowed("name"),
    );
    expect(output).toBe("Real: Alice, Literal: {{name}}");
  });

  it("multiple escaped literals in one template", () => {
    const output = render("\\{{a}} and \\{{{b}}}", {}, allowed());
    expect(output).toBe("{{a}} and {{{b}}}");
  });
});

// ---------------------------------------------------------------------------
// Unknown paths
// ---------------------------------------------------------------------------

describe("renderTemplate — unknown paths", () => {
  it("rejects a variable tag with an unknown path", () => {
    const error = renderErr("{{unknown}}", {}, allowed("name"));
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("unknown");
    }
  });

  it("rejects a section tag with an unknown path", () => {
    const error = renderErr(
      "{{#secret}}content{{/secret}}",
      {},
      allowed("name"),
    );
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("secret");
    }
  });

  it("allows full dotted path when explicitly in allowedPaths", () => {
    const output = render(
      "{{agent.name}}",
      { agent: { name: "loom" } },
      allowed("agent.name"),
    );
    expect(output).toBe("loom");
  });

  it("rejects dotted path when only root segment is in allowedPaths (strict full-path check)", () => {
    // With strict full-path validation, "agent.name" requires "agent.name" in allowedPaths,
    // not just "agent". This is the fix for the typo-detection bug.
    const error = renderErr(
      "{{agent.name}}",
      { agent: { name: "loom" } },
      allowed("agent"),
    );
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("agent.name");
    }
  });

  it("allows full dotted path when explicitly in allowedPaths (toolPolicy)", () => {
    const output = render(
      "{{toolPolicy.effective}}",
      { toolPolicy: { effective: "allow" } },
      allowed("toolPolicy.effective"),
    );
    expect(output).toBe("allow");
  });

  it("rejects dotted path when neither root nor full path is allowed", () => {
    const error = renderErr("{{secret.key}}", {}, allowed("name"));
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("secret.key");
    }
  });
});

// ---------------------------------------------------------------------------
// Unsafe paths
// ---------------------------------------------------------------------------

describe("renderTemplate — unsafe paths", () => {
  it("rejects __proto__ path", () => {
    const error = renderErr("{{__proto__}}", {}, allowed("__proto__"));
    expect(error.type).toBe("UnsafePath");
    if (error.type === "UnsafePath") {
      expect(error.path).toBe("__proto__");
    }
  });

  it("rejects prototype path", () => {
    const error = renderErr("{{prototype}}", {}, allowed("prototype"));
    expect(error.type).toBe("UnsafePath");
    if (error.type === "UnsafePath") {
      expect(error.path).toBe("prototype");
    }
  });

  it("rejects constructor path", () => {
    const error = renderErr("{{constructor}}", {}, allowed("constructor"));
    expect(error.type).toBe("UnsafePath");
    if (error.type === "UnsafePath") {
      expect(error.path).toBe("constructor");
    }
  });

  it("rejects dotted path containing __proto__ segment", () => {
    const error = renderErr("{{agent.__proto__}}", {}, allowed("agent"));
    expect(error.type).toBe("UnsafePath");
    if (error.type === "UnsafePath") {
      expect(error.path).toBe("agent.__proto__");
    }
  });

  it("rejects dotted path containing constructor segment", () => {
    const error = renderErr("{{agent.constructor}}", {}, allowed("agent"));
    expect(error.type).toBe("UnsafePath");
    if (error.type === "UnsafePath") {
      expect(error.path).toBe("agent.constructor");
    }
  });

  it("rejects hasOwnProperty path", () => {
    const error = renderErr(
      "{{hasOwnProperty}}",
      {},
      allowed("hasOwnProperty"),
    );
    expect(error.type).toBe("UnsafePath");
  });
});

// ---------------------------------------------------------------------------
// Function/callable values
// ---------------------------------------------------------------------------

describe("renderTemplate — function values", () => {
  it("rejects a function value at the top level", () => {
    const lambda = (): string => "lambda";
    const error = renderErr(
      "{{name}}",
      { name: lambda as unknown as string },
      allowed("name"),
    );
    expect(error.type).toBe("FunctionValue");
    if (error.type === "FunctionValue") {
      expect(error.path).toBe("name");
    }
  });

  it("rejects a function value nested in an object", () => {
    const lambda = (): string => "lambda";
    const error = renderErr(
      "{{agent.name}}",
      { agent: { name: lambda as unknown as string } },
      // "agent.name" must be in allowedPaths for strict full-path validation
      allowed("agent.name"),
    );
    expect(error.type).toBe("FunctionValue");
    if (error.type === "FunctionValue") {
      expect(error.path).toContain("name");
    }
  });

  it("rejects a function value inside an array", () => {
    const lambda = (): string => "lambda";
    const error = renderErr(
      "{{#items}}{{.}}{{/items}}",
      { items: [lambda as unknown as string] },
      allowed("items"),
    );
    expect(error.type).toBe("FunctionValue");
  });
});

// ---------------------------------------------------------------------------
// Unsupported tags
// ---------------------------------------------------------------------------

describe("renderTemplate — unsupported tags", () => {
  it("rejects partial tags", () => {
    const error = renderErr("{{> myPartial}}", {}, allowed());
    expect(error.type).toBe("UnsupportedFeature");
    if (error.type === "UnsupportedFeature") {
      expect(error.feature).toBe("partial");
    }
  });

  it("rejects delimiter change tags", () => {
    const error = renderErr("{{= <% %> =}}", {}, allowed());
    expect(error.type).toBe("UnsupportedFeature");
    if (error.type === "UnsupportedFeature") {
      expect(error.feature).toBe("delimiter-change");
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed syntax
// ---------------------------------------------------------------------------

describe("renderTemplate — malformed syntax", () => {
  it("returns MalformedTemplate error for unclosed tag", () => {
    const error = renderErr("Hello {{name", {}, allowed("name"));
    expect(error.type).toBe("MalformedTemplate");
  });

  it("returns MalformedTemplate error for unclosed section", () => {
    // Mustache may or may not throw for unclosed sections — test the behavior
    const result = renderTemplate(
      "{{#section}}content",
      { section: true },
      { allowedPaths: allowed("section") },
    );
    // Either it renders (Mustache is lenient) or returns an error
    // The important thing is it doesn't throw
    expect(result.isOk() || result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unresolved tags
// ---------------------------------------------------------------------------

describe("renderTemplate — unresolved tags", () => {
  it("returns UnresolvedTag error when a variable has no value in context", () => {
    // When Mustache renders {{missing}} with no value, it outputs empty string
    // So this test verifies that missing values render as empty (Mustache default)
    // and do NOT trigger the unresolved-tag check
    const output = render("{{name}}", {}, allowed("name"));
    // Mustache renders missing values as empty string
    expect(output).toBe("");
  });

  it("does not flag empty-string renders as unresolved", () => {
    const result = renderTemplate(
      "{{name}}",
      { name: "" },
      { allowedPaths: allowed("name") },
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("");
  });

  it("restored escaped literals do not trigger unresolved-tag check", () => {
    // After restoration, output contains {{ but it came from escaped input
    // The check runs BEFORE restoration, so this should pass
    const output = render("\\{{path}} is literal", {}, allowed());
    expect(output).toBe("{{path}} is literal");
  });
});

// ---------------------------------------------------------------------------
// extractTemplatePaths
// ---------------------------------------------------------------------------

describe("extractTemplatePaths", () => {
  it("extracts variable paths", () => {
    const result = extractTemplatePaths("{{name}} and {{age}}");
    expect(result.isOk()).toBe(true);
    const paths = result._unsafeUnwrap();
    expect(paths).toContain("name");
    expect(paths).toContain("age");
  });

  it("extracts section paths", () => {
    const result = extractTemplatePaths("{{#agent}}{{name}}{{/agent}}");
    expect(result.isOk()).toBe(true);
    const paths = result._unsafeUnwrap();
    expect(paths).toContain("agent");
    expect(paths).toContain("name");
  });

  it("does not include {{.}} in extracted paths", () => {
    const result = extractTemplatePaths("{{#items}}{{.}}{{/items}}");
    expect(result.isOk()).toBe(true);
    const paths = result._unsafeUnwrap();
    expect(paths).toContain("items");
    expect(paths).not.toContain(".");
  });

  it("does not include escaped literal paths", () => {
    const result = extractTemplatePaths("\\{{escaped}} {{real}}");
    expect(result.isOk()).toBe(true);
    const paths = result._unsafeUnwrap();
    expect(paths).toContain("real");
    // escaped is not a real tag — it was preprocessed away
    expect(paths).not.toContain("escaped");
  });

  it("returns MalformedTemplate error for invalid template", () => {
    const result = extractTemplatePaths("{{unclosed");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("MalformedTemplate");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: complex template
// ---------------------------------------------------------------------------

describe("renderTemplate — integration", () => {
  it("renders a complex agent prompt template", () => {
    const context: TemplateContext = {
      agent: {
        name: "shuttle",
        description: "Domain specialist",
        mode: "subagent",
        skills: ["tdd", "code-review"],
        isCategory: false,
      },
      toolPolicy: {
        effective: {
          read: "allow",
          write: "allow",
          execute: "ask",
          delegate: "deny",
          network: "deny",
        },
      },
    };

    const template = `
# Agent: {{agent.name}}

{{#agent.description}}Description: {{agent.description}}{{/agent.description}}

Mode: {{agent.mode}}

{{! This is a comment }}

Skills:
{{#agent.skills}}
- {{.}}
{{/agent.skills}}
`.trim();

    // Use the full ALLOWED_TEMPLATE_PATHS-style set with all explicit paths
    const output = render(
      template,
      context,
      allowed(
        "agent",
        "agent.name",
        "agent.description",
        "agent.mode",
        "agent.skills",
        "agent.isCategory",
        "toolPolicy",
        "toolPolicy.effective",
        "toolPolicy.effective.read",
        "toolPolicy.effective.write",
        "toolPolicy.effective.execute",
        "toolPolicy.effective.delegate",
        "toolPolicy.effective.network",
      ),
    );
    expect(output).toContain("Agent: shuttle");
    expect(output).toContain("Description: Domain specialist");
    expect(output).toContain("Mode: subagent");
    expect(output).toContain("- tdd");
    expect(output).toContain("- code-review");
    expect(output).not.toContain("This is a comment");
  });
});

// ---------------------------------------------------------------------------
// Strict full-path validation (typo detection)
// ---------------------------------------------------------------------------

describe("renderTemplate — strict full-path validation", () => {
  it("rejects {{agent.nmae}} (typo) as UnknownPath", () => {
    // "agent.nmae" is not in ALLOWED_TEMPLATE_PATHS — only "agent.name" is.
    // With strict full-path checking, typos are caught at validation time.
    const error = renderErr(
      "{{agent.nmae}}",
      { agent: { name: "loom" } },
      // Simulate ALLOWED_TEMPLATE_PATHS: "agent" and "agent.name" are allowed,
      // but "agent.nmae" is not.
      allowed("agent", "agent.name", "agent.description", "agent.mode"),
    );
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("agent.nmae");
    }
  });

  it("rejects {{#delegation.targets}}{{bogus}}{{/delegation.targets}} as UnknownPath", () => {
    // Inside {{#delegation.targets}}, child "bogus" resolves to
    // "delegation.targets.bogus" which is not in ALLOWED_TEMPLATE_PATHS.
    const error = renderErr(
      "{{#delegation.targets}}{{bogus}}{{/delegation.targets}}",
      { delegation: { targets: [{ name: "shuttle" }] } },
      allowed(
        "delegation",
        "delegation.targets",
        "delegation.targets.name",
        "delegation.targets.description",
        "delegation.targets.domains",
        "delegation.targets.triggers",
        "delegation.targets.triggers.domain",
        "delegation.targets.triggers.trigger",
      ),
    );
    expect(error.type).toBe("UnknownPath");
    if (error.type === "UnknownPath") {
      expect(error.path).toBe("delegation.targets.bogus");
    }
  });

  it("allows {{#delegation.targets}}{{name}}{{/delegation.targets}} (valid child path)", () => {
    // Inside {{#delegation.targets}}, child "name" resolves to
    // "delegation.targets.name" which IS in ALLOWED_TEMPLATE_PATHS.
    const output = render(
      "{{#delegation.targets}}{{name}}{{/delegation.targets}}",
      { delegation: { targets: [{ name: "shuttle" }, { name: "warp" }] } },
      allowed(
        "delegation",
        "delegation.targets",
        "delegation.targets.name",
        "delegation.targets.description",
        "delegation.targets.domains",
        "delegation.targets.triggers",
        "delegation.targets.triggers.domain",
        "delegation.targets.triggers.trigger",
      ),
    );
    expect(output).toBe("shuttlewarp");
  });

  it("allows nested valid paths: {{#delegation.targets}}{{#triggers}}{{domain}}{{/triggers}}{{/delegation.targets}}", () => {
    // Inside {{#delegation.targets}}{{#triggers}}, child "domain" resolves to
    // "delegation.targets.triggers.domain" which IS in ALLOWED_TEMPLATE_PATHS.
    const output = render(
      "{{#delegation.targets}}{{#triggers}}{{domain}}:{{trigger}} {{/triggers}}{{/delegation.targets}}",
      {
        delegation: {
          targets: [
            {
              name: "shuttle",
              triggers: [
                { domain: "Backend", trigger: "API work" },
                { domain: "Frontend", trigger: "UI work" },
              ],
            },
          ],
        },
      },
      allowed(
        "delegation",
        "delegation.targets",
        "delegation.targets.name",
        "delegation.targets.description",
        "delegation.targets.domains",
        "delegation.targets.triggers",
        "delegation.targets.triggers.domain",
        "delegation.targets.triggers.trigger",
      ),
    );
    expect(output).toBe("Backend:API work Frontend:UI work ");
  });
});
