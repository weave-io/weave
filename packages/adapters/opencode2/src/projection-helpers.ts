/**
 * Projection Helpers — pure adapter-internal utilities for the V2 command
 * surface and workflow runner.
 *
 * Provides small, dependency-free helpers shared across
 * `runtime-command-projection.ts`, `start-plan-execution.ts`, and
 * `run-workflow.ts`:
 *
 * - `renderPrompt` — a minimal Mustache-style `{{key}}` substitution used to
 *   render command prompt templates against a plain string-keyed context.
 * - `composeDelegatedPrompt` — builds the full text sent via
 *   `facade.session.prompt(...)` for a single `DispatchAgentEffect`.
 * - `slugify` — URL-safe slug derivation for execution instance ids.
 *
 * ## Boundary rule
 *
 * This module is adapter-internal and pure — no I/O, no `PluginContextFacade`
 * calls. It must not import from `packages/adapters/opencode/` (the V1
 * adapter). See `./errors.ts` header for the independent V2 error union
 * rationale.
 */

import type { DispatchAgentEffect } from "@weaveio/weave-engine";

// ---------------------------------------------------------------------------
// § 1 — renderPrompt — minimal Mustache-style substitution
// ---------------------------------------------------------------------------

/**
 * Render a command prompt template by replacing every `{{key}}` placeholder
 * with the corresponding value from `context`. Unknown placeholders are left
 * untouched (not replaced) so callers can detect missing context easily.
 *
 * This is intentionally minimal — no sections, no partials, no helpers. Full
 * Mustache composition for agent prompts is engine-owned (see
 * `docs/prompt-composition.md`); this helper is scoped to the V2 adapter's
 * own command templates only.
 */
export function renderPrompt(
  template: string,
  context: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = context[key];
    return value !== undefined ? value : match;
  });
}

// ---------------------------------------------------------------------------
// § 2 — slugify — URL-safe slug derivation
// ---------------------------------------------------------------------------

/**
 * Derive a URL-safe slug from an arbitrary human-readable string.
 *
 * Lowercases, replaces runs of non-alphanumeric characters with a single
 * hyphen, and trims leading/trailing hyphens. Empty input yields `"untitled"`.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

// ---------------------------------------------------------------------------
// § 3 — composeDelegatedPrompt — DispatchAgentEffect → prompt text
// ---------------------------------------------------------------------------

/**
 * Compose the prompt text to deliver via `facade.session.prompt(...)` for a
 * single `DispatchAgentEffect`.
 *
 * Uses the engine-composed prompt from `runAgent.agentDescriptor.composedPrompt`
 * unchanged — this module never re-derives or duplicates prompt composition;
 * it only wraps the already-composed text with adapter-owned framing so the
 * receiving agent knows which step/agent is being activated.
 */
export function composeDelegatedPrompt(effect: DispatchAgentEffect): string {
  const { agentName, agentDescriptor } = effect.runAgent;
  return `<weave-step-dispatch agent="${agentName}">\n${agentDescriptor.composedPrompt}\n</weave-step-dispatch>`;
}
