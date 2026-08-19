/**
 * Graph-copy limits owned by the config boundary.
 *
 * `copySafeGraph`'s general-purpose budget is intentionally small. Config
 * schemas have larger, explicit collection maxima: every public config list
 * accepts up to 512 entries, and a workflow can contain 512 steps with up to
 * 512 inputs and 512 outputs per step. The budget below is derived from that
 * largest accepted workflow shape instead of borrowing the generic limit.
 *
 * Dynamic config records are bounded by the safe schema boundary's 512 own
 * properties per object. Strings have no narrower schema field maximum, so
 * this owner keeps the core graph boundary's finite aggregate string limit:
 * 256 KiB for each of the 512 public collection slots.
 */
import type { SafeGraphCopyBudget } from "@weaveio/weave-core";

/** Maximum length of every bounded public config collection. */
export const MAX_PUBLIC_CONFIG_COLLECTION_LENGTH = 512;

/**
 * A two-layer merge can temporarily union two public-maximal collections before
 * the final schema re-entry reports the authoritative 512-item violation.
 */
const MAX_INTERMEDIATE_MERGED_COLLECTION_LENGTH =
  MAX_PUBLIC_CONFIG_COLLECTION_LENGTH * 2;

/** Maximum own properties accepted by a public dynamic config record. */
export const MAX_PUBLIC_CONFIG_RECORD_PROPERTIES = 512;

/** Maximum graph depth enforced by the core descriptor-safe boundary. */
const MAX_CONFIG_GRAPH_DEPTH = 64;

/** Core's finite per-slot string allowance, multiplied by public slots. */
const MAX_CONFIG_STRING_LENGTH =
  256 * 1024 * MAX_PUBLIC_CONFIG_COLLECTION_LENGTH;

/**
 * Number of fixed graph values per artifact declaration:
 * artifact object + `name` + `description`.
 */
const ARTIFACT_GRAPH_VALUES = 3;

/** Number of own fields on one artifact declaration. */
const ARTIFACT_PROPERTIES = 2;

/** Number of artifact declarations in the largest public workflow shape. */
const MAX_WORKFLOW_ARTIFACTS =
  MAX_PUBLIC_CONFIG_COLLECTION_LENGTH * MAX_PUBLIC_CONFIG_COLLECTION_LENGTH * 2;

/**
 * Each artifact list contributes its own array `length` plus one property for
 * every item. Include those array properties in the aggregate property limit.
 */
const MAX_WORKFLOW_ARTIFACT_LIST_PROPERTIES =
  MAX_PUBLIC_CONFIG_COLLECTION_LENGTH *
  2 *
  (MAX_PUBLIC_CONFIG_COLLECTION_LENGTH + 1);

/**
 * Fixed workflow/config fields, arrays, records, and adapter settings are
 * bounded separately by the public schemas. This finite reserve covers those
 * fields after the artifact product has been accounted for.
 */
const CONFIG_GRAPH_OVERHEAD = 65_536;

const MAX_WORKFLOW_GRAPH_NODES = MAX_WORKFLOW_ARTIFACTS * ARTIFACT_GRAPH_VALUES;
const MAX_WORKFLOW_GRAPH_PROPERTIES =
  MAX_WORKFLOW_ARTIFACTS * ARTIFACT_PROPERTIES +
  MAX_WORKFLOW_ARTIFACT_LIST_PROPERTIES;

/**
 * Budget for a schema-valid workflow or config layer graph.
 *
 * The values are deliberately finite. A graph that exceeds one of them is
 * rejected before schema parsing and is reported as a typed boundary error by
 * the owning merge API.
 */
export const CONFIG_GRAPH_COPY_BUDGET: SafeGraphCopyBudget = {
  maxDepth: MAX_CONFIG_GRAPH_DEPTH,
  maxNodes: MAX_WORKFLOW_GRAPH_NODES + CONFIG_GRAPH_OVERHEAD,
  maxProperties: MAX_WORKFLOW_GRAPH_PROPERTIES + CONFIG_GRAPH_OVERHEAD,
  maxPropertiesPerObject: MAX_PUBLIC_CONFIG_RECORD_PROPERTIES,
  maxArrayLength: MAX_INTERMEDIATE_MERGED_COLLECTION_LENGTH,
  maxStringLength: MAX_CONFIG_STRING_LENGTH,
};

/** Alias used to make workflow call sites state their owner explicitly. */
export const WORKFLOW_GRAPH_COPY_BUDGET: SafeGraphCopyBudget =
  CONFIG_GRAPH_COPY_BUDGET;
