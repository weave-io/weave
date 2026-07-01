/**
 * Prompt snapshot composition for `weave eval` provenance.
 *
 * Composes fully-rendered prompts for a named set of agents (by default
 * `loom`, `tapestry`, `shuttle`, `spindle`, `pattern`, `weft`, and `warp`)
 * using the existing `@weave/config` and `@weave/engine` APIs, then produces
 * eval-owned `PromptSnapshot` records
 * that include:
 *   - a stable SHA-256 hash of the composed prompt
 *   - byte and character lengths
 *   - source descriptors (builtin / file / inline / generated)
 *
 * Raw prompt text is returned separately in `RawPromptArtifact` records and
 * is only emitted when `rawArtifacts` is explicitly enabled. It is NEVER
 * included in the publishable `PromptSnapshot`.
 *
 * Design notes:
 *   - Hashing uses the Web Crypto API (`crypto.subtle.digest`) — Bun-native,
 *     no Node `crypto` import required.
 *   - Config loading is delegated to `@weave/config`'s `loadConfig()`.
 *   - Prompt composition is delegated to `@weave/engine`'s
 *     `composeAgentDescriptor()`.
 *   - All failures are returned as typed `ProvenanceError` values via
 *     `ResultAsync` — no exceptions propagate.
 */

import { loadConfig } from "@weave/config";
import { composeAgentDescriptor } from "@weave/engine";
import { errAsync, ok, ResultAsync } from "neverthrow";
import type {
  PromptSnapshot,
  PromptSourceDescriptor,
  ProvenanceError,
  RawPromptArtifact,
} from "./types.js";
import { EVAL_SHORT_AGENT_FILTERS } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The default set of agent names for which snapshots are composed.
 *
 * The default set is sourced from the shared eval suite registry short-agent
 * filters (`loom`, `tapestry`, `shuttle`, `spindle`, `pattern`, `weft`,
 * `warp`) so provenance stays aligned with the same seven-suite text-only
 * surface used by CLI filter validation and workflow sync tests.
 */
export const DEFAULT_SNAPSHOT_AGENTS = [...EVAL_SHORT_AGENT_FILTERS] as const;

// ---------------------------------------------------------------------------
// SHA-256 hashing (Web Crypto — Bun-native)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a UTF-8 encoded string.
 *
 * Uses the Web Crypto API (`crypto.subtle.digest`) which is available in Bun
 * and all modern runtimes without importing `node:crypto`.
 *
 * Deterministic: the same input string always produces the same output hash.
 * This property is the foundation of the hash-first provenance contract.
 */
function sha256Hex(content: string): ResultAsync<string, string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  return ResultAsync.fromPromise(
    crypto.subtle.digest("SHA-256", data).then((hashBuffer) =>
      Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ),
    (cause) =>
      `SHA-256 computation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

// ---------------------------------------------------------------------------
// Source descriptor inference
// ---------------------------------------------------------------------------

/**
 * Infer source descriptors for an agent from the resolved config.
 *
 * Examines `prompt`, `prompt_file`, `prompt_append`, and
 * `prompt_append_file` to produce a list of `PromptSourceDescriptor` records
 * that describe where each layer of the composed prompt came from — without
 * exposing the raw content.
 *
 * Heuristic for `"builtin"` vs `"file"` vs `"inline"`:
 *   - When a `prompt` string is present and no `prompt_file` is set, the
 *     source is `"inline"` (user-authored DSL) unless the agent name is in
 *     the builtin set, in which case it is `"builtin"` (embedded content).
 *   - When `prompt_file` is set, the source is `"file"`.
 *   - Category shuttle agents whose config was synthesized use `"generated"`.
 */
function inferSourceDescriptors(
  _agentName: string,
  agentConfig: {
    prompt?: string;
    prompt_file?: string;
    prompt_append?: string;
    prompt_append_file?: string;
  },
  isBuiltin: boolean,
): PromptSourceDescriptor[] {
  const descriptors: PromptSourceDescriptor[] = [];

  // Primary source
  if (agentConfig.prompt_file !== undefined) {
    descriptors.push({
      kind: "file",
      filePath: agentConfig.prompt_file,
      layer: "primary",
    });
  } else if (agentConfig.prompt !== undefined) {
    descriptors.push({
      kind: isBuiltin ? "builtin" : "inline",
      layer: "primary",
    });
  } else {
    // No prompt source — will fail at compose time; record as builtin placeholder
    descriptors.push({
      kind: isBuiltin ? "builtin" : "inline",
      layer: "primary",
    });
  }

  // Append source (optional)
  if (agentConfig.prompt_append_file !== undefined) {
    descriptors.push({
      kind: "file",
      filePath: agentConfig.prompt_append_file,
      layer: "append",
    });
  } else if (agentConfig.prompt_append !== undefined) {
    descriptors.push({
      kind: isBuiltin ? "builtin" : "inline",
      layer: "append",
    });
  }

  return descriptors;
}

// ---------------------------------------------------------------------------
// Single-agent snapshot composition
// ---------------------------------------------------------------------------

/**
 * Inputs for `composeSnapshot`.
 *
 * Separated from the public API so that dependencies (config, agent set) can
 * be injected cleanly for testing.
 */
export interface ComposeSnapshotInput {
  /** Resolved Weave configuration. */
  config: import("@weave/core").WeaveConfig;
  /** The agent name to compose a snapshot for. */
  agentName: string;
}

/**
 * Result of composing a single agent snapshot.
 *
 * Both the publishable `PromptSnapshot` and the local-only `RawPromptArtifact`
 * are returned so callers can decide whether to persist the raw content.
 */
export interface ComposeSnapshotResult {
  /** Publishable snapshot — no raw prompt text. */
  snapshot: PromptSnapshot;
  /** Local-only raw prompt artifact. Only emit when `rawArtifacts` is enabled. */
  rawArtifact: RawPromptArtifact;
}

/**
 * Compose a `PromptSnapshot` (and raw artifact) for a single agent.
 *
 * Uses `composeAgentDescriptor` from `@weave/engine` to produce the fully
 * rendered prompt, then hashes the result and collects source descriptors.
 *
 * Returns `err(ProvenanceError)` on:
 *   - Agent not found in config (`PromptCompositionError`)
 *   - Composition failure from the engine (`PromptCompositionError`)
 *   - SHA-256 hash failure (`HashComputationError`)
 */
export function composeSnapshot(
  input: ComposeSnapshotInput,
): ResultAsync<ComposeSnapshotResult, ProvenanceError> {
  const { config, agentName } = input;

  const agentConfig = config.agents[agentName];
  if (agentConfig === undefined) {
    return errAsync({
      type: "PromptCompositionError" as const,
      agentName,
      message: `Agent "${agentName}" not found in config`,
    } satisfies ProvenanceError);
  }

  // Infer source descriptors before composition (config-level view)
  const BUILTIN_AGENT_NAMES = new Set([
    "loom",
    "tapestry",
    "shuttle",
    "pattern",
    "thread",
    "spindle",
    "weft",
    "warp",
  ]);
  const isBuiltin = BUILTIN_AGENT_NAMES.has(agentName);
  const sources = inferSourceDescriptors(agentName, agentConfig, isBuiltin);

  return composeAgentDescriptor(agentName, agentConfig, config, config.agents)
    .mapErr(
      (composeErr): ProvenanceError => ({
        type: "PromptCompositionError",
        agentName,
        message: `Composition failed for agent "${agentName}": ${composeErr.message}`,
      }),
    )
    .andThen((descriptor) => {
      const { composedPrompt } = descriptor;
      const encoder = new TextEncoder();
      const encoded = encoder.encode(composedPrompt);
      const byteLength = encoded.length;
      const charLength = composedPrompt.length;

      return sha256Hex(composedPrompt)
        .mapErr(
          (hashErr): ProvenanceError => ({
            type: "HashComputationError",
            agentName,
            message: hashErr,
          }),
        )
        .andThen((hash) => {
          const snapshot: PromptSnapshot = {
            agentName,
            hash,
            byteLength,
            charLength,
            sources,
          };

          const rawArtifact: RawPromptArtifact = {
            agentName,
            composedPrompt,
          };

          return ok({ snapshot, rawArtifact });
        });
    });
}

// ---------------------------------------------------------------------------
// Public API — compose snapshots for multiple agents
// ---------------------------------------------------------------------------

/**
 * Options for `composeAgentSnapshots`.
 */
export interface ComposeAgentSnapshotsOptions {
  /**
   * Project root directory for config loading.
   * Defaults to `process.cwd()` when omitted.
   */
  projectRoot?: string;
  /**
   * The agent names to compose snapshots for.
   * Defaults to `DEFAULT_SNAPSHOT_AGENTS` (`["loom", "tapestry", "shuttle", "spindle", "pattern", "weft", "warp"]`).
   */
  agentNames?: readonly string[];
  /**
   * When `true`, include raw prompt text in the returned artifacts.
   * Defaults to `false`. Local-only; never publish.
   */
  rawArtifacts?: boolean;
}

/**
 * Result of composing snapshots for multiple agents.
 */
export interface ComposeAgentSnapshotsResult {
  /** Publishable snapshots, one per successfully composed agent. */
  snapshots: PromptSnapshot[];
  /**
   * Raw prompt artifacts.
   * Only populated when `rawArtifacts` option is `true`.
   * Must not be published.
   */
  rawArtifacts: RawPromptArtifact[];
  /**
   * Per-agent errors for agents that failed to compose.
   * Partial success: snapshots for other agents are still returned.
   */
  errors: ProvenanceError[];
}

/**
 * Compose prompt snapshots for the specified agents (default: Loom, Tapestry,
 * Shuttle, Spindle, Pattern, Weft, and Warp) using the merged Weave config
 * loaded from `projectRoot`.
 *
 * The function always succeeds at the top level — per-agent failures are
 * accumulated in `result.errors` rather than rejecting the entire result.
 * Only a config load failure causes a top-level `err`.
 *
 * @param options - Composition options (project root, agent names, raw mode).
 * @returns `ResultAsync<ComposeAgentSnapshotsResult, ProvenanceError>` —
 *          always `ok` unless config loading fails.
 */
export function composeAgentSnapshots(
  options: ComposeAgentSnapshotsOptions = {},
): ResultAsync<ComposeAgentSnapshotsResult, ProvenanceError> {
  const agentNames = options.agentNames ?? DEFAULT_SNAPSHOT_AGENTS;
  const emitRaw = options.rawArtifacts ?? false;

  return loadConfig(options.projectRoot)
    .mapErr(
      (configErrors): ProvenanceError => ({
        type: "ConfigLoadError",
        message: `Failed to load Weave config: ${configErrors.map((e) => e.type).join(", ")}`,
      }),
    )
    .andThen((config) => {
      const agentNameArray = Array.from(agentNames);

      // Settle all per-agent compositions using .match() to convert each
      // ResultAsync into a discriminated union — this is the canonical pattern
      // from materialization.ts for collecting per-item results from a
      // ResultAsync array without losing type information.
      const compositionPromises = agentNameArray.map((agentName) =>
        composeSnapshot({ config, agentName }).match<
          | { ok: true; value: ComposeSnapshotResult }
          | { ok: false; error: ProvenanceError }
        >(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
      );

      return ResultAsync.fromSafePromise(
        Promise.all(compositionPromises),
      ).andThen((settled) => {
        const snapshots: PromptSnapshot[] = [];
        const rawArtifactList: RawPromptArtifact[] = [];
        const errors: ProvenanceError[] = [];

        for (const item of settled) {
          if (item.ok) {
            snapshots.push(item.value.snapshot);
            if (emitRaw) {
              rawArtifactList.push(item.value.rawArtifact);
            }
          } else {
            errors.push(item.error);
          }
        }

        return ok({
          snapshots,
          rawArtifacts: rawArtifactList,
          errors,
        });
      });
    });
}
