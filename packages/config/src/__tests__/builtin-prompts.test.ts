/**
 * Focused tests for shipped builtin prompt files.
 *
 * These tests assert that:
 * 1. All 8 builtin prompt files exist and are non-empty.
 * 2. No file contains the placeholder text shipped before real prompts existed.
 * 3. No file contains banned tokens that would indicate Weave-repo-only policy
 *    or harness-specific tool names leaking into product-level defaults.
 * 4. Intentional Mustache placeholders (e.g. {{{delegation.section}}}) are
 *    allowed — they are resolved at compose time, not in the source file.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getBuiltinConfig } from "../builtins.js";

/**
 * Tokens that must not appear in shipped builtin prompt files.
 *
 * - `AGENTS.md`   — Weave-repo-only policy file reference
 * - `bun run`     — harness/repo-specific CLI invocation
 * - `neverthrow`  — Weave-repo implementation detail
 * - `Zod`         — Weave-repo implementation detail
 * - `TodoWrite`   — OpenCode-specific harness tool name
 * - `todowrite`   — lowercase variant of the above
 *
 * Note: "Task" is intentionally NOT banned here — it is a common English word
 * that appears legitimately in prompt prose (e.g. "a task is done when...").
 * Harness-specific tool names like "TodoWrite" are banned instead.
 */
const BANNED_TOKENS = [
  "AGENTS.md",
  "bun run",
  "neverthrow",
  "Zod",
  "TodoWrite",
  "todowrite",
] as const;

/**
 * Tokens that indicate raw config, model, path, or harness data leaking into
 * a prompt source file. These must not appear in any builtin prompt file.
 */
const BANNED_LEAKAGE_TOKENS = [
  // Raw model identifiers
  "claude-sonnet",
  "gpt-4",
  "anthropic/",
  "openai/",
  // Absolute or repo-relative paths
  "packages/config",
  "packages/engine",
  "prompts/",
  ".weave/",
  // Harness-specific tool names
  "opencode",
  "OpenCode",
  // Secret / environment data patterns
  "process.env",
  "API_KEY",
  "SECRET",
] as const;

/**
 * Intentional Mustache placeholders that ARE allowed in source prompt files.
 * These are resolved at compose time by the template renderer.
 */
const ALLOWED_MUSTACHE_PLACEHOLDERS = [
  // Triple-brace (unescaped HTML) placeholders
  "{{{delegation.section}}}",
  "{{{delegation.mermaid}}}",
  // Double-brace scalar placeholders
  "{{agent.name}}",
  "{{agent.description}}",
  "{{agent.mode}}",
  "{{agent.skills}}",
  "{{agent.isCategory}}",
  "{{category.name}}",
  "{{category.description}}",
  "{{toolPolicy.effective.read}}",
  "{{toolPolicy.effective.write}}",
  "{{toolPolicy.effective.execute}}",
  "{{toolPolicy.effective.delegate}}",
  "{{toolPolicy.effective.network}}",
  // Section/loop placeholders (Mustache block tags)
  "{{#delegation.targets}}",
  "{{/delegation.targets}}",
  "{{#triggers}}",
  "{{/triggers}}",
  "{{trigger}}",
  "{{#isCategory}}",
  "{{/isCategory}}",
  "{{#agent.skills}}",
  "{{/agent.skills}}",
  "{{name}}",
  "{{description}}",
  "{{domains}}",
] as const;

const PLACEHOLDER_TEXT =
  "Placeholder — full prompt content is a future deliverable.";

/**
 * Absolute path to the prompts directory shipped with @weaveio/weave-config.
 * Resolved relative to this test file: src/__tests__/ → src/ → packages/config/ → prompts/
 */
const PROMPTS_DIR = join(import.meta.dir, "..", "..", "prompts");

const BUILTIN_AGENT_NAMES = Object.keys(
  getBuiltinConfig()._unsafeUnwrap().agents,
).sort();

describe("builtin prompt files", () => {
  for (const agentName of BUILTIN_AGENT_NAMES) {
    const fileName = `${agentName}.md`;
    const filePath = join(PROMPTS_DIR, fileName);

    describe(`${fileName}`, () => {
      it("exists and is readable", async () => {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        expect(exists).toBe(true);
      });

      it("is non-empty (more than 10 characters)", async () => {
        const content = await Bun.file(filePath).text();
        expect(content.trim().length).toBeGreaterThan(10);
      });

      it("does not contain placeholder text", async () => {
        const content = await Bun.file(filePath).text();
        expect(content).not.toContain(PLACEHOLDER_TEXT);
      });

      it("contains substantive Markdown (has at least one heading)", async () => {
        const content = await Bun.file(filePath).text();
        expect(content).toMatch(/^#+ /m);
      });

      for (const token of BANNED_TOKENS) {
        it(`does not contain banned token: "${token}"`, async () => {
          const content = await Bun.file(filePath).text();
          expect(content).not.toContain(token);
        });
      }

      for (const token of BANNED_LEAKAGE_TOKENS) {
        it(`does not leak raw config/model/path/harness token: "${token}"`, async () => {
          const content = await Bun.file(filePath).text();
          expect(content).not.toContain(token);
        });
      }

      it("does not contain unintended raw Mustache tags (only allowed placeholders permitted)", async () => {
        const content = await Bun.file(filePath).text();
        // Strip all allowed placeholders, then check no raw {{ or {{{ remain
        let stripped = content;
        for (const placeholder of ALLOWED_MUSTACHE_PLACEHOLDERS) {
          stripped = stripped.split(placeholder).join("");
        }
        // After removing allowed placeholders, no unescaped Mustache tags should remain
        expect(stripped).not.toMatch(/\{\{\{[^}]+\}\}\}/);
        expect(stripped).not.toMatch(/\{\{[^}]+\}\}/);
      });
    });
  }

  describe("weft.md — gate-style verdict output", () => {
    it("encodes APPROVE verdict", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "weft.md")).text();
      expect(content).toContain("APPROVE");
    });

    it("encodes REJECT or REQUEST CHANGES or BLOCK verdict", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "weft.md")).text();
      const hasReject =
        content.includes("REJECT") ||
        content.includes("REQUEST CHANGES") ||
        content.includes("BLOCK");
      expect(hasReject).toBe(true);
    });
  });

  describe("warp.md — gate-style verdict output", () => {
    it("encodes APPROVE verdict", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "warp.md")).text();
      expect(content).toContain("APPROVE");
    });

    it("encodes BLOCK verdict", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "warp.md")).text();
      expect(content).toContain("BLOCK");
    });
  });

  describe("loom.md — direct handling and delegation guidance", () => {
    it("allows direct handling of simple work", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      // Should mention handling work directly (not always delegating)
      const allowsDirect =
        content.includes("directly") ||
        content.includes("act directly") ||
        content.includes("handle");
      expect(allowsDirect).toBe(true);
    });

    it("steers complex or multi-step work toward delegation", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      const hasDelegation =
        content.includes("delegate") ||
        content.includes("Delegate") ||
        content.includes("hand off");
      expect(hasDelegation).toBe(true);
    });

    it("contains a delegation.targets loop for the specialist agents list", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      // loom uses a prose-first template: specialist agents are listed via
      // {{#delegation.targets}} loop rather than an embedded Mermaid diagram
      expect(content).toContain("{{#delegation.targets}}");
      expect(content).toContain("{{/delegation.targets}}");
    });
  });

  describe("loom.md — configuration self-modification routing", () => {
    it("mentions weave prompt self-modify command", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      expect(content).toContain("weave prompt self-modify");
    });

    it("instructs asking for config object type first, before scope", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      // Must mention object type
      const hasObjectType =
        content.includes("object type") || content.includes("config object");
      expect(hasObjectType).toBe(true);

      // Object-type step must appear before scope-clarification step in the text
      const objectTypeIdx = Math.min(
        content.includes("object type")
          ? content.indexOf("object type")
          : Infinity,
        content.includes("config object")
          ? content.indexOf("config object")
          : Infinity,
      );
      const scopeIdx = Math.min(
        content.includes("global") ? content.indexOf("global") : Infinity,
        content.includes("target scope")
          ? content.indexOf("target scope")
          : Infinity,
      );
      expect(objectTypeIdx).toBeLessThan(scopeIdx);
    });

    it("does NOT instruct asking about scope before object type", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      // The routing section must not lead with scope-first language
      // Find the routing section
      const routingStart = content.indexOf("## Routing");
      expect(routingStart).toBeGreaterThan(-1);
      const routingSection = content.slice(routingStart, routingStart + 600);

      // Within the routing section, object type must appear before scope
      const objectTypeIdx = Math.min(
        routingSection.includes("object type")
          ? routingSection.indexOf("object type")
          : Infinity,
        routingSection.includes("config object")
          ? routingSection.indexOf("config object")
          : Infinity,
      );
      const scopeIdx = Math.min(
        routingSection.includes("global")
          ? routingSection.indexOf("global")
          : Infinity,
        routingSection.includes("target scope")
          ? routingSection.indexOf("target scope")
          : Infinity,
      );
      expect(objectTypeIdx).toBeLessThan(scopeIdx);
    });

    it("references base docs: dsl-reference.md and config-loading.md", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      expect(content).toContain("docs/dsl-reference.md");
      expect(content).toContain("docs/config-loading.md");
    });

    it("references prompt-composition docs for prompt-related edits", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      expect(content).toContain("docs/prompt-composition.md");
    });

    it("instructs clarifying target scope after object type is known", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "loom.md")).text();
      // Scope clarification should still be present, just not first
      const hasScopeClarification =
        content.includes("global") ||
        content.includes("target scope") ||
        content.includes("ask");
      expect(hasScopeClarification).toBe(true);
    });
  });

  describe("tapestry.md — plan execution and delegation guidance", () => {
    it("contains the delegation.targets loop template placeholder", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "tapestry.md")).text();
      expect(content).toContain("{{#delegation.targets}}");
      expect(content).toContain("{{/delegation.targets}}");
    });

    it("describes step-by-step plan execution", async () => {
      const content = await Bun.file(join(PROMPTS_DIR, "tapestry.md")).text();
      const hasExecution =
        content.includes("step") ||
        content.includes("plan") ||
        content.includes("execute");
      expect(hasExecution).toBe(true);
    });
  });

  describe("non-delegating prompts — no artificial template tags", () => {
    const NON_DELEGATING = [
      "shuttle",
      "pattern",
      "thread",
      "spindle",
      "weft",
      "warp",
    ] as const;

    for (const agentName of NON_DELEGATING) {
      it(`${agentName}.md does not contain delegation.section placeholder`, async () => {
        const content = await Bun.file(
          join(PROMPTS_DIR, `${agentName}.md`),
        ).text();
        expect(content).not.toContain("{{{delegation.section}}}");
      });
    }
  });
});
