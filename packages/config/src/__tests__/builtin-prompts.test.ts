/**
 * Focused tests for shipped builtin prompt files.
 *
 * These tests assert that:
 * 1. All 8 builtin prompt files exist and are non-empty.
 * 2. No file contains the placeholder text shipped before real prompts existed.
 * 3. No file contains banned tokens that would indicate Weave-repo-only policy
 *    or harness-specific tool names leaking into product-level defaults.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BUILTIN_AGENT_NAMES } from "../builtins.js";

/**
 * Tokens that must not appear in shipped builtin prompt files.
 *
 * - `AGENTS.md`   — Weave-repo-only policy file reference
 * - `bun run`     — harness/repo-specific CLI invocation
 * - `neverthrow`  — Weave-repo implementation detail
 * - `Zod`         — Weave-repo implementation detail
 * - `Task`        — OpenCode-specific harness tool name
 * - `TodoWrite`   — OpenCode-specific harness tool name
 * - `todowrite`   — lowercase variant of the above
 */
const BANNED_TOKENS = [
  "AGENTS.md",
  "bun run",
  "neverthrow",
  "Zod",
  "Task",
  "TodoWrite",
  "todowrite",
] as const;

const PLACEHOLDER_TEXT =
  "Placeholder — full prompt content is a future deliverable.";

/**
 * Absolute path to the prompts directory shipped with @weave/config.
 * Resolved relative to this test file: src/__tests__/ → src/ → packages/config/ → prompts/
 */
const PROMPTS_DIR = join(import.meta.dir, "..", "..", "prompts");

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
  });
});
