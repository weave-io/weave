/**
 * Resolves recommended model lists the way each harness would, for
 * `weave models check` (Spec 39, publication bar step 6).
 *
 * The rules mirror the adapters; they are restated here rather than imported
 * because the OpenCode 2 resolver lives inside that adapter, works on its SDK
 * catalog types, and is not part of its public API, and the Pi adapter's source
 * is outside this repository. This is the one place the CLI states them:
 *
 * - **OpenCode 2** ([live-catalog rules](../../../../docs/model-resolution.md#opencode-2-live-catalog-rules)):
 *   entries are tried in order; `provider/model` must match that provider's
 *   entry exactly; a bare `model` must match exactly one catalog entry (two or
 *   more is ambiguous and skipped); `#variant` must be offered by the model.
 * - **Pi**: the same first two steps (exact canonical `provider/id`, then a
 *   bare ID that is unique in the catalog). Pi's third step, a unique
 *   human-readable name, is not modelled: the fixtures carry no names.
 * - **Claude Code**: the first entry that is a tier (`opus`, `sonnet`,
 *   `haiku`) or in the adapter's allowlist, written as its tier. Claude Code
 *   maps each tier to its current model itself, so no catalog is involved.
 */

import { CLAUDE_CODE_AVAILABLE_MODELS } from "@weaveio/weave-adapter-claude-code";
import {
  CLAUDE_CODE_MODEL_TIERS,
  type ClaudeCodeModelTier,
  type ModelRecommendationsFile,
  RECOMMENDATIONS_HARNESSES,
  type RecommendationsHarness,
  selectRecommendationsSection,
} from "@weaveio/weave-config";
import type { CatalogModel, ProviderCatalog } from "./catalogs.js";
import { CATALOG_IDS, type CatalogId, PROVIDER_CATALOGS } from "./catalogs.js";

/** Why one entry did not resolve. */
export type EntryRejection =
  | "invalid"
  | "missing"
  | "ambiguous"
  | "variant-missing"
  | "not-a-tier";

/** How one agent's list resolved against one catalog. */
export interface AgentResolution {
  readonly agent: string;
  /** The resolved model (`provider/id`, or a tier), or `none`. */
  readonly model: string;
  /** Zero-based index of the entry that resolved. */
  readonly entryIndex?: number;
  /** Why each entry before the chosen one (or every entry) was skipped. */
  readonly skipped: readonly {
    readonly entry: string;
    readonly reason: EntryRejection;
  }[];
}

/** The catalog Claude Code is reported under: the provider of its tiers. */
export const CLAUDE_CODE_CATALOG: CatalogId = "anthropic";

/** One harness × catalog block of the report. */
export interface CatalogResolution {
  readonly harness: RecommendationsHarness;
  /** The section the harness reads: its own, or `default`. */
  readonly section: RecommendationsHarness | "default";
  readonly catalog: CatalogId;
  readonly agents: readonly AgentResolution[];
}

const NONE = "none";

interface ParsedEntry {
  readonly providerID?: string;
  readonly modelID: string;
  readonly variant?: string;
}

function parseEntry(entry: string): ParsedEntry | undefined {
  if (entry.length === 0 || entry.trim() !== entry) return undefined;
  const hash = entry.lastIndexOf("#");
  const modelPart = hash < 0 ? entry : entry.slice(0, hash);
  const variant = hash < 0 ? undefined : entry.slice(hash + 1);
  if (modelPart.length === 0 || variant === "") return undefined;
  const slash = modelPart.indexOf("/");
  if (slash < 0) return { modelID: modelPart, variant };
  const providerID = modelPart.slice(0, slash);
  const modelID = modelPart.slice(slash + 1);
  if (providerID.length === 0 || modelID.length === 0) return undefined;
  return { providerID, modelID, variant };
}

function matches(model: CatalogModel, parsed: ParsedEntry): boolean {
  if (parsed.providerID !== undefined && model.providerID !== parsed.providerID)
    return false;
  return model.id === parsed.modelID;
}

function tierOf(entry: string): ClaudeCodeModelTier | undefined {
  const tiers: readonly string[] = CLAUDE_CODE_MODEL_TIERS;
  if (tiers.includes(entry)) return entry as ClaudeCodeModelTier;
  if (!CLAUDE_CODE_AVAILABLE_MODELS.has(entry)) return undefined;
  return CLAUDE_CODE_MODEL_TIERS.find((tier) => entry.includes(tier));
}

/** Resolves recommended lists against catalog fixtures. */
export class RecommendationsResolver {
  constructor(
    private readonly catalogs: Readonly<
      Record<CatalogId, ProviderCatalog>
    > = PROVIDER_CATALOGS,
  ) {}

  /** The OpenCode 2 (and Pi) catalog rule for one agent's entries. */
  resolveInCatalog(
    agent: string,
    entries: readonly string[],
    catalog: ProviderCatalog,
  ): AgentResolution {
    const skipped: { entry: string; reason: EntryRejection }[] = [];
    for (const [entryIndex, entry] of entries.entries()) {
      const parsed = parseEntry(entry);
      if (parsed === undefined) {
        skipped.push({ entry, reason: "invalid" });
        continue;
      }
      const found = catalog.models.filter((model) => matches(model, parsed));
      if (found.length === 0) {
        skipped.push({ entry, reason: "missing" });
        continue;
      }
      if (parsed.providerID === undefined && found.length > 1) {
        skipped.push({ entry, reason: "ambiguous" });
        continue;
      }
      const model = found[0];
      if (model === undefined) continue;
      const variant = parsed.variant;
      if (variant !== undefined && !(model.variants ?? []).includes(variant)) {
        skipped.push({ entry, reason: "variant-missing" });
        continue;
      }
      const suffix = variant === undefined ? "" : `#${variant}`;
      return {
        agent,
        model: `${model.providerID}/${model.id}${suffix}`,
        entryIndex,
        skipped,
      };
    }
    return { agent, model: NONE, skipped };
  }

  /** The Claude Code tier rule for one agent's entries. */
  resolveClaudeCode(
    agent: string,
    entries: readonly string[],
  ): AgentResolution {
    const skipped: { entry: string; reason: EntryRejection }[] = [];
    for (const [entryIndex, entry] of entries.entries()) {
      const tier = tierOf(entry);
      if (tier === undefined) {
        skipped.push({ entry, reason: "not-a-tier" });
        continue;
      }
      return { agent, model: tier, entryIndex, skipped };
    }
    return { agent, model: NONE, skipped };
  }

  /**
   * Resolve every supported harness's section of `file`: OpenCode 2 and Pi
   * against each catalog, Claude Code once, under `anthropic`.
   */
  resolveFile(file: ModelRecommendationsFile): CatalogResolution[] {
    const report: CatalogResolution[] = [];
    for (const harness of RECOMMENDATIONS_HARNESSES) {
      const selected = selectRecommendationsSection(file, harness);
      if (selected === undefined) continue;
      const agents = Object.entries(selected.agents);
      if (harness === "claude-code") {
        report.push({
          harness,
          section: selected.source,
          catalog: CLAUDE_CODE_CATALOG,
          agents: agents.map(([name, entry]) =>
            this.resolveClaudeCode(name, entry.models),
          ),
        });
        continue;
      }
      for (const catalogId of CATALOG_IDS) {
        const catalog = this.catalogs[catalogId];
        report.push({
          harness,
          section: selected.source,
          catalog: catalogId,
          agents: agents.map(([name, entry]) =>
            this.resolveInCatalog(name, entry.models, catalog),
          ),
        });
      }
    }
    return report;
  }
}
