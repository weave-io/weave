import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  renderSelfModifyPrompt,
  resolveSelfModifyPaths,
  type SelfModifyContext,
} from "../self-modify.js";

const PROJECT_ROOT = "/home/user/my-project";

function globalCtx(): SelfModifyContext {
  return { scope: "global", projectRoot: PROJECT_ROOT };
}

function localCtx(): SelfModifyContext {
  return { scope: "local", projectRoot: PROJECT_ROOT };
}

describe("resolveSelfModifyPaths", () => {
  it("global scope resolves to ~/.weave paths", () => {
    const paths = resolveSelfModifyPaths(globalCtx());
    expect(paths.configPath).toMatch(/\.weave[/\\]config\.weave$/);
    expect(paths.promptsDir).toMatch(/\.weave[/\\]prompts$/);
    // Must be under home dir, not project root
    expect(paths.configPath).not.toContain(PROJECT_ROOT);
  });

  it("local scope resolves to <projectRoot>/.weave paths", () => {
    const paths = resolveSelfModifyPaths(localCtx());
    expect(paths.configPath).toBe(join(PROJECT_ROOT, ".weave", "config.weave"));
    expect(paths.promptsDir).toBe(join(PROJECT_ROOT, ".weave", "prompts"));
  });
});

describe("renderSelfModifyPrompt — determinism", () => {
  it("returns identical output for the same inputs (global)", () => {
    const a = renderSelfModifyPrompt(globalCtx());
    const b = renderSelfModifyPrompt(globalCtx());
    expect(a).toBe(b);
  });

  it("returns identical output for the same inputs (local)", () => {
    const a = renderSelfModifyPrompt(localCtx());
    const b = renderSelfModifyPrompt(localCtx());
    expect(a).toBe(b);
  });

  it("global and local outputs differ", () => {
    expect(renderSelfModifyPrompt(globalCtx())).not.toBe(
      renderSelfModifyPrompt(localCtx()),
    );
  });
});

describe("renderSelfModifyPrompt — scope label", () => {
  it("global output contains the global scope label", () => {
    const out = renderSelfModifyPrompt(globalCtx());
    expect(out).toContain("global (~/.weave/)");
  });

  it("local output contains the local scope label", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("local (.weave/)");
  });
});

describe("renderSelfModifyPrompt — config and prompt paths", () => {
  it("global output contains the global config path", () => {
    const out = renderSelfModifyPrompt(globalCtx());
    const paths = resolveSelfModifyPaths(globalCtx());
    expect(out).toContain(paths.configPath);
  });

  it("global output contains the global prompts dir", () => {
    const out = renderSelfModifyPrompt(globalCtx());
    const paths = resolveSelfModifyPaths(globalCtx());
    expect(out).toContain(paths.promptsDir);
  });

  it("local output contains the local config path", () => {
    const out = renderSelfModifyPrompt(localCtx());
    const paths = resolveSelfModifyPaths(localCtx());
    expect(out).toContain(paths.configPath);
  });

  it("local output contains the local prompts dir", () => {
    const out = renderSelfModifyPrompt(localCtx());
    const paths = resolveSelfModifyPaths(localCtx());
    expect(out).toContain(paths.promptsDir);
  });
});

describe("renderSelfModifyPrompt — base doc references", () => {
  it("references docs/reference/dsl.md", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("docs/reference/dsl.md");
  });

  it("references docs/reference/configuration.md", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("docs/reference/configuration.md");
  });

  it("references docs/reference/prompts.md for prompt-related changes", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("docs/reference/prompts.md");
  });
});

describe("renderSelfModifyPrompt — documentation audience split", () => {
  it("distinguishes internal contracts from public user guidance", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("docs/` and `packages/docs/");
    expect(out).toContain("serve different audiences");
    expect(out).toContain("public user guidance");
    expect(out).not.toContain("public mirror");
  });
});

describe("renderSelfModifyPrompt — current prompt composition guidance", () => {
  it("uses current delegation target iteration fields", () => {
    const out = renderSelfModifyPrompt(localCtx());

    expect(out).toContain("{{#delegation.targets}}");
    expect(out).toContain("{{name}}");
    expect(out).toContain("{{description}}");
    expect(out).toContain("{{#triggers}}");
    expect(out).toContain("{{.}}");
    expect(out).not.toContain("{{domains}}");
    expect(out).not.toContain("delegation.section");
    expect(out).not.toContain("delegation.mermaid");
    expect(out).not.toContain("fallback suppression");
    expect(out).not.toContain("Mermaid");
  });
});

describe("renderSelfModifyPrompt — target-aware rules", () => {
  it("global output mentions all-projects scope", () => {
    const out = renderSelfModifyPrompt(globalCtx());
    expect(out).toContain("all projects");
  });

  it("global output mentions preferring project-scope overrides", () => {
    const out = renderSelfModifyPrompt(globalCtx());
    expect(out).toContain("project-scope overrides");
  });

  it("local output mentions this-project-only scope", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("this project only");
  });

  it("local output mentions category shuttle auto-generation", () => {
    const out = renderSelfModifyPrompt(localCtx());
    expect(out).toContain("shuttle-<name>");
  });

  it("both scopes mention builtin agents and deep-merge semantics", () => {
    for (const ctx of [globalCtx(), localCtx()]) {
      const out = renderSelfModifyPrompt(ctx);
      expect(out).toContain("packages/config/src/builtins.ts");
      expect(out).toContain("deep-merge");
    }
  });
});
