/// <reference path="../../../../types/md.d.ts" />

import { homedir } from "node:os";
import { join } from "node:path";
import Mustache from "mustache";
import templateSource from "./self-modify.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SelfModifyScope = "global" | "local";

export interface SelfModifyContext {
  scope: SelfModifyScope;
  /** Absolute path to the project root. Used to resolve local paths. */
  projectRoot: string;
}

export interface SelfModifyPaths {
  /** Absolute path to the config file for this scope. */
  configPath: string;
  /** Absolute path to the prompts directory for this scope. */
  promptsDir: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical config and prompts paths for a given scope.
 *
 * - global → `~/.weave/config.weave` and `~/.weave/prompts/`
 * - local  → `<projectRoot>/.weave/config.weave` and `<projectRoot>/.weave/prompts/`
 */
export function resolveSelfModifyPaths(
  ctx: SelfModifyContext,
): SelfModifyPaths {
  if (ctx.scope === "global") {
    const root = join(homedir(), ".weave");
    return {
      configPath: join(root, "config.weave"),
      promptsDir: join(root, "prompts"),
    };
  }

  const root = join(ctx.projectRoot, ".weave");
  return {
    configPath: join(root, "config.weave"),
    promptsDir: join(root, "prompts"),
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the self-modification prompt for the given scope.
 *
 * The output is deterministic: same scope + projectRoot always produces the
 * same text. The canonical content lives in `self-modify.md`; this function
 * resolves paths and renders the Mustache template.
 *
 * Path placeholders (`configPath`, `promptsDir`) use triple-brace syntax in
 * the template so Mustache emits them as raw strings without HTML escaping.
 */
export function renderSelfModifyPrompt(ctx: SelfModifyContext): string {
  const paths = resolveSelfModifyPaths(ctx);
  const isGlobal = ctx.scope === "global";

  const scopeLabel = isGlobal ? "global (~/.weave/)" : "local (.weave/)";

  return Mustache.render(templateSource, {
    scope: scopeLabel,
    configPath: paths.configPath,
    promptsDir: paths.promptsDir,
    isGlobal,
    isLocal: !isGlobal,
  });
}
