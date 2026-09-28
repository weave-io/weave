import { err, ok, type Result } from "neverthrow";
import {
  V2Model as Model,
  type V2CatalogModelInfo as ModelInfo,
  V2Provider as Provider,
} from "../sdk-types.js";

export type OpenCode2ModelResolutionError =
  | { readonly type: "InvalidModelIntent"; readonly entryIndex: number }
  | { readonly type: "MissingModel"; readonly entryIndex: number }
  | { readonly type: "AmbiguousModel"; readonly entryIndex: number }
  | { readonly type: "InvalidVariant"; readonly entryIndex: number };

export interface OpenCode2ModelResolution {
  readonly ref?: Model.Ref;
  readonly source: "inherit" | "declared";
  readonly selectedIndex?: number;
  /** The agent's own `variant`, left off because the selected model does not offer it. */
  readonly droppedVariant?: string;
}

interface ParsedIntent {
  readonly providerID?: string;
  readonly modelID: string;
  readonly variant?: string;
}

function parseIntent(value: string): ParsedIntent | undefined {
  if (value.length === 0 || value.trim() !== value) return undefined;
  const hash = value.lastIndexOf("#");
  const modelPart = hash < 0 ? value : value.slice(0, hash);
  const variant = hash < 0 ? undefined : value.slice(hash + 1);
  if (modelPart.length === 0 || variant === "") return undefined;
  const slash = modelPart.indexOf("/");
  if (slash < 0) return { modelID: modelPart, variant };
  const providerID = modelPart.slice(0, slash);
  const modelID = modelPart.slice(slash + 1);
  if (providerID.length === 0 || modelID.length === 0) return undefined;
  return { providerID, modelID, variant };
}

function matchesModel(model: ModelInfo, intent: ParsedIntent): boolean {
  if (intent.providerID !== undefined && model.providerID !== intent.providerID)
    return false;
  return model.id === intent.modelID;
}

/**
 * The variant an entry runs with: `false` rejects the entry. A `#variant` on
 * the entry is part of it, so a model that lacks it cannot serve the entry.
 * The agent's own `variant` applies to whichever entry is selected (including
 * builtin fallbacks merged after the user's), so a model that lacks it runs
 * without a variant rather than costing the agent the model.
 */
function resolveVariant(
  model: ModelInfo,
  intent: ParsedIntent,
  descriptorVariant: string | undefined,
): { readonly id?: Model.VariantID; readonly dropped?: string } | false {
  const offered = (requested: string) =>
    model.variants.find((variant) => variant.id === requested)?.id;
  if (intent.variant !== undefined) {
    const found = offered(intent.variant);
    return found === undefined ? false : { id: Model.VariantID.make(found) };
  }
  if (descriptorVariant === undefined) return {};
  const found = offered(descriptorVariant);
  return found === undefined
    ? { dropped: descriptorVariant }
    : { id: Model.VariantID.make(found) };
}

/** Resolve ordered Weave model intent against the exact live native catalog. */
export function resolveOpenCode2Model(
  entries: readonly string[] | undefined,
  descriptorVariant: string | undefined,
  available: readonly ModelInfo[],
): Result<OpenCode2ModelResolution, OpenCode2ModelResolutionError[]> {
  if (entries === undefined || entries.length === 0)
    return ok({ source: "inherit" });

  const errors: OpenCode2ModelResolutionError[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const intent = parseIntent(entry);
    if (intent === undefined) {
      errors.push({ type: "InvalidModelIntent", entryIndex });
      continue;
    }
    const matches = available.filter((model) => matchesModel(model, intent));
    if (matches.length === 0) {
      errors.push({ type: "MissingModel", entryIndex });
      continue;
    }
    if (intent.providerID === undefined && matches.length > 1) {
      errors.push({ type: "AmbiguousModel", entryIndex });
      continue;
    }
    const model = matches[0];
    if (model === undefined) continue;
    const variant = resolveVariant(model, intent, descriptorVariant);
    if (variant === false) {
      errors.push({ type: "InvalidVariant", entryIndex });
      continue;
    }
    return ok({
      ref: {
        id: Model.ID.make(model.id),
        providerID: Provider.ID.make(model.providerID),
        ...(variant.id === undefined ? {} : { variant: variant.id }),
      },
      source: "declared",
      selectedIndex: entryIndex,
      ...(variant.dropped === undefined
        ? {}
        : { droppedVariant: variant.dropped }),
    });
  }
  return err(errors);
}
