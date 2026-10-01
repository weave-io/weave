/**
 * Provider catalog fixtures for `weave models check` (Spec 39, task 0.5).
 *
 * Each fixture is the slice of a provider's model catalog that the builtin
 * and recommended lists can name, as a harness host would list it. They ship
 * with the CLI, so the website's publish workflow resolves every list against
 * the same catalogs. Update a fixture when the provider's catalog changes, and
 * say where the new IDs were seen.
 *
 * The combined Copilot + OpenAI catalog exists for ambiguity: both providers
 * list `gpt-6-sol` and `gpt-6-luna`, so a bare entry for either matches twice.
 */

import anthropic from "./catalogs/anthropic.json" with { type: "json" };
import githubCopilot from "./catalogs/github-copilot.json" with {
  type: "json",
};
import openai from "./catalogs/openai.json" with { type: "json" };
import openrouter from "./catalogs/openrouter.json" with { type: "json" };

/** One model as a host's catalog lists it. */
export interface CatalogModel {
  readonly providerID: string;
  readonly id: string;
  /** Variant IDs the model offers; absent means none. */
  readonly variants?: readonly string[];
}

/** A catalog fixture. */
export interface ProviderCatalog {
  readonly id: string;
  readonly description: string;
  /** When the fixture was last checked against the provider. */
  readonly updated: string;
  readonly models: readonly CatalogModel[];
}

/** The catalogs every list is checked against, in report order. */
export const CATALOG_IDS = [
  "github-copilot",
  "anthropic",
  "openai",
  "openrouter",
  "github-copilot+openai",
] as const;

/** A catalog fixture's ID. */
export type CatalogId = (typeof CATALOG_IDS)[number];

const githubCopilotCatalog: ProviderCatalog = githubCopilot;
const anthropicCatalog: ProviderCatalog = anthropic;
const openaiCatalog: ProviderCatalog = openai;
const openrouterCatalog: ProviderCatalog = openrouter;

/** Every catalog fixture, keyed by ID. */
export const PROVIDER_CATALOGS: Readonly<Record<CatalogId, ProviderCatalog>> = {
  "github-copilot": githubCopilotCatalog,
  anthropic: anthropicCatalog,
  openai: openaiCatalog,
  openrouter: openrouterCatalog,
  "github-copilot+openai": {
    id: "github-copilot+openai",
    description:
      "A host with both GitHub Copilot and OpenAI connected: bare OpenAI IDs match twice and are ambiguous.",
    updated: githubCopilotCatalog.updated,
    models: [...githubCopilotCatalog.models, ...openaiCatalog.models],
  },
};
