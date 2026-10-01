/**
 * The expectations file for `weave models check --expect` (Spec 39,
 * publication bar step 6).
 *
 * Shape: per harness, per catalog, the model each agent must resolve to, or
 * `none`:
 *
 * ```json
 * {
 *   "schema": 1,
 *   "harnesses": {
 *     "opencode2": { "github-copilot": { "shuttle": "github-copilot/claude-sonnet-5.5" }, ... },
 *     "claude-code": { "anthropic": { "shuttle": "sonnet" } },
 *     "pi": { "openai": { "shuttle": "openai/gpt-6-sol" }, ... }
 *   }
 * }
 * ```
 *
 * The file must cover exactly what the check resolves: every harness, every
 * catalog it is checked against, and every agent in the section it reads. A
 * missing or extra entry is a mismatch, so a list cannot gain an agent or a
 * harness section that nobody wrote an expectation for.
 */

import { z } from "zod";
import { CATALOG_IDS, type CatalogId } from "./catalogs.js";
import { type CatalogResolution, CLAUDE_CODE_CATALOG } from "./resolve.js";

const AgentExpectationsSchema = z.record(
  z.string().min(1),
  z.string().min(1, "an expectation is a model or none"),
);

const CatalogExpectationsSchema = z
  .object(
    Object.fromEntries(
      CATALOG_IDS.map((id) => [id, AgentExpectationsSchema.optional()]),
    ) as Record<CatalogId, z.ZodOptional<typeof AgentExpectationsSchema>>,
  )
  .strict();

const ClaudeCodeExpectationsSchema = z
  .object({ [CLAUDE_CODE_CATALOG]: AgentExpectationsSchema.optional() })
  .strict();

/** The expectations file. */
export const ModelExpectationsSchema = z
  .object({
    schema: z.literal(1),
    harnesses: z
      .object({
        opencode2: CatalogExpectationsSchema.optional(),
        "claude-code": ClaudeCodeExpectationsSchema.optional(),
        pi: CatalogExpectationsSchema.optional(),
      })
      .strict(),
  })
  .strict();

/** A validated expectations file. */
export type ModelExpectations = z.infer<typeof ModelExpectationsSchema>;

/** One difference between the report and the expectations. */
export interface ExpectationMismatch {
  readonly harness: string;
  readonly catalog: string;
  readonly agent: string;
  /** Undefined when the expectations file has no entry. */
  readonly expected?: string;
  /** Undefined when the check did not resolve this agent. */
  readonly actual?: string;
}

/** Format a mismatch as one line. */
export function describeMismatch(mismatch: ExpectationMismatch): string {
  const where = `${mismatch.harness} / ${mismatch.catalog} / ${mismatch.agent}`;
  if (mismatch.expected === undefined)
    return `${where}: resolved ${mismatch.actual}, but the expectations file has no entry`;
  if (mismatch.actual === undefined)
    return `${where}: expected ${mismatch.expected}, but the list has no such agent for this harness`;
  return `${where}: expected ${mismatch.expected}, resolved ${mismatch.actual}`;
}

function lookup(
  expectations: ModelExpectations,
  harness: string,
  catalog: string,
): Readonly<Record<string, string>> | undefined {
  const byHarness = expectations.harnesses as Record<
    string,
    Record<string, Record<string, string> | undefined> | undefined
  >;
  return byHarness[harness]?.[catalog];
}

/** Compare a resolution report with the expectations, both ways. */
export function compareExpectations(
  report: readonly CatalogResolution[],
  expectations: ModelExpectations,
): ExpectationMismatch[] {
  const mismatches: ExpectationMismatch[] = [];
  const covered = new Set<string>();
  for (const block of report) {
    const expected = lookup(expectations, block.harness, block.catalog) ?? {};
    for (const agent of block.agents) {
      covered.add(`${block.harness}\0${block.catalog}\0${agent.agent}`);
      const want = expected[agent.agent];
      if (want === agent.model) continue;
      mismatches.push({
        harness: block.harness,
        catalog: block.catalog,
        agent: agent.agent,
        expected: want,
        actual: agent.model,
      });
    }
  }
  const byHarness = expectations.harnesses as Record<
    string,
    Record<string, Record<string, string> | undefined> | undefined
  >;
  for (const [harness, catalogs] of Object.entries(byHarness)) {
    for (const [catalog, agents] of Object.entries(catalogs ?? {})) {
      for (const [agent, model] of Object.entries(agents ?? {})) {
        if (covered.has(`${harness}\0${catalog}\0${agent}`)) continue;
        mismatches.push({ harness, catalog, agent, expected: model });
      }
    }
  }
  return mismatches;
}
