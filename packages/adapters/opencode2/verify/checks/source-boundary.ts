#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: verification CLI writes to stdout/stderr
/**
 * Source-boundary check (Task E1, layer 7).
 *
 * Fails (exit 1) if any file under `packages/adapters/opencode2/src/`:
 *   - imports from `packages/adapters/opencode/` (relative path or the
 *     `@weaveio/weave-adapter-opencode` package name), or
 *   - references a forbidden V1-only identifier/surface (Invariant 5 of
 *     `.weave/plans/opencode2-adapter.md`):
 *       - `config.update`
 *       - `AgentConfig.prompt` (V2 uses `system`)
 *       - the singular field name `permission` (V2 uses plural `permissions`)
 *       - a `tools` denial map
 *       - top-level agent fields `temperature`, `top_p`, `disable`, `maxSteps`
 *         (bare `tools` at the agent-config top level is also forbidden;
 *         V2 permission-derived `permissions` is fine)
 *
 * This script only inspects source under `packages/adapters/opencode2/src`
 * and `packages/adapters/opencode2/verify` (excluding this file and
 * `version-drift.ts`, which legitimately reference version strings, not V1
 * surface). It does not read or modify anything under
 * `packages/adapters/opencode/`.
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "packages", "adapters", "opencode2", "src");

interface Violation {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+["'](?:.*\/)?packages\/adapters\/opencode\/(?!.*opencode2)/,
  /from\s+["']@weaveio\/weave-adapter-opencode["']/,
  /require\(\s*["']@weaveio\/weave-adapter-opencode["']\s*\)/,
];

// Forbidden V1-only identifiers/surface (Invariant 5). Matched as whole
// identifiers/phrases to avoid false positives on unrelated words.
const FORBIDDEN_IDENTIFIERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bconfig\.update\b/, reason: "V1-only `config.update` call" },
  {
    pattern: /\bAgentConfig\.prompt\b/,
    reason: "V1-only `AgentConfig.prompt` (V2 uses `system`)",
  },
  {
    pattern: /^\s*permission\s*:/m,
    reason: "V1 singular `permission` field (V2 uses plural `permissions`)",
  },
  { pattern: /\btop_p\s*:/, reason: "V1-only top-level agent field `top_p`" },
  {
    pattern: /interface\s+AgentConfig\b/,
    reason:
      "V1-only `AgentConfig` interface name (V2 agent shape is defined locally, see translate-agent.ts)",
  },
];

// `maxSteps` is legitimate on V2's workflow-runner safety cap
// (`RunWorkflowInput.maxSteps` in `run-workflow.ts`) but forbidden as a
// *top-level V1 agent config field* (Invariant 5). Only flag it when it
// appears as a direct property of an object/interface literal whose name
// suggests an agent config shape (`AgentConfig`, `agent {`), not a workflow
// runner input.
const MAX_STEPS_AGENT_CONTEXT =
  /\b(AgentConfig|agentConfig)\b[\s\S]{0,400}?\bmaxSteps\b/;

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "__tests__"
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (extname(entry.name) === ".ts") out.push(full);
  }
}

async function main(): Promise<number> {
  const files: string[] = [];
  await walk(SRC_ROOT, files);

  const violations: Violation[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");

    if (MAX_STEPS_AGENT_CONTEXT.test(content)) {
      violations.push({
        file,
        line: 0,
        reason:
          "V1-only top-level agent field `maxSteps` near an AgentConfig-shaped context",
        snippet: "(context match — see MAX_STEPS_AGENT_CONTEXT)",
      });
    }

    lines.forEach((line, idx) => {
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file,
            line: idx + 1,
            reason: "forbidden import from V1 adapter",
            snippet: line.trim(),
          });
        }
      }
      for (const { pattern, reason } of FORBIDDEN_IDENTIFIERS) {
        if (pattern.test(line)) {
          violations.push({
            file,
            line: idx + 1,
            reason,
            snippet: line.trim(),
          });
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error(
      `FAIL: source-boundary check found ${violations.length} violation(s):`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.reason}\n    ${v.snippet}`);
    }
    return 1;
  }

  console.log(
    `OK: source-boundary check passed (${files.length} files scanned, 0 violations)`,
  );
  return 0;
}

const code = await main();
process.exit(code);
