/**
 * template-renderer.test.ts
 *
 * What is left here is what a `.weave` file cannot reach. Everything the
 * renderer promises a *user* — which tags work, which paths are refused, how
 * escaping and escaped literals behave — is asserted through composed prompts
 * in `tests/dsl/prompt-templates.scenario.test.ts`.
 *
 * Still covered here:
 * - Function/callable values in the context. The context builder projects only
 *   strings, arrays and booleans, so no config can put a function there; this
 *   guards the lambda ban against a future context field.
 * - Renderer-internal validation driven by a caller-supplied `allowedPaths`
 *   set. Composition always passes `ALLOWED_TEMPLATE_PATHS`, so the
 *   parameterisation itself has no user-visible form.
 * - `extractTemplatePaths`, which has **no production caller** — see the
 *   no-caller finding in `docs/testing-strategy.md`.
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

// ---------------------------------------------------------------------------
// Nested sections
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// {{.}} current-item reference
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Escaped literals
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unknown paths
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unsafe paths
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Malformed syntax
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Source-aware validation
// ---------------------------------------------------------------------------

describe("renderTemplate — source-aware validation", () => {
  it.each([
    "{{example}}",
    "{{{example}}}",
    "{{> footer}}",
    "{{constructor.name}}",
    "{{= <% %> =}}",
  ])("preserves %s supplied by a context value", (literal) => {
    expect(
      render(
        "{{{description}}}",
        { description: literal },
        allowed("description"),
      ),
    ).toBe(literal);
  });

  it("still rejects unknown tags in an unused source branch", () => {
    expect(
      renderErr(
        "{{#show}}{{example}}{{/show}}",
        { show: false },
        allowed("show"),
      ).type,
    ).toBe("UnknownPath");
  });

  it("renders an allowed missing value as empty", () => {
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

  it("restores escaped source literals", () => {
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

// ---------------------------------------------------------------------------
// Strict full-path validation (typo detection)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spec 22 Unit 4 — Trust boundary: bounded template context for appends
// ---------------------------------------------------------------------------
