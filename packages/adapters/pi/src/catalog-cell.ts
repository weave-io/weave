/**
 * The one generation-scoped cell every non-pinned config consumer reads.
 *
 * Before this module the activated catalog was captured by closures at
 * `session_start`: the delegation controller, the recovery coordinator, the
 * workflow controller, the preflight tool registration and the workflows
 * projection each held their own reference to one immutable
 * `PiConfigActivationResult`. Nothing could ever change without replacing the
 * whole generation.
 *
 * The cell replaces those captures with one indirection so a later, validated
 * candidate can be published for *future* work without disturbing anything
 * already committed:
 *
 * - **One reference, swapped whole.** {@link PiCatalogCell.publish} assigns a
 *   single frozen {@link PiCatalogPublication}. There is no path that mutates
 *   a field of a live publication, so a reader can never observe a catalog
 *   whose descriptors came from one config and whose workflows came from
 *   another.
 * - **Generation-bound.** A cell belongs to exactly one generation and is
 *   invalidated when that generation is revoked or replaced. A stale closure
 *   that still holds the object reads nothing usable: no activation, no
 *   descriptors, no workflows, no deferred candidate.
 * - **Nothing pinned lives here.** The committed primary - its composed
 *   prompt, applied model, badge and delegation contract - is owned by
 *   `PiPrimarySession` and is unaffected by publication. Publishing changes
 *   what *future* dispatches resolve, never what the active primary is.
 *
 * This module performs no refresh of its own: it stores what a caller decided
 * to publish or defer.
 */

import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { Result } from "neverthrow";
import type { PiConfigActivationResult } from "./config-activator.js";
import type {
  PiConfigCatalogState,
  PiConfigSourceContents,
} from "./config-refresh.js";
import {
  createPiConfigSourceManifest,
  discoverPromptSourcePaths,
  type PiConfigSourceIdentity,
  type PiConfigSourceManifest,
  resolvePiConfigSourcePaths,
} from "./config-source-digests.js";
import type { PiPrimaryContractFacet } from "./primary-contract.js";

/** Workflow definitions exactly as the engine's execution context reads them. */
export type PiCatalogWorkflows = WorkflowExecutionContext["workflows"];

const EMPTY_DESCRIPTORS: ReadonlyMap<string, AgentDescriptor> = new Map();
const EMPTY_DISABLED_SKILLS: readonly string[] = Object.freeze([]);
const EMPTY_WORKFLOWS: PiCatalogWorkflows = Object.freeze({});

/**
 * One published catalog.
 *
 * `manifest` and `contents` are the digest state a refresh attempt needs. They
 * are `undefined` together exactly when the source graph could not be derived
 * for this generation; the catalog still serves every consumer, and refresh
 * stays unavailable rather than guessing which sources exist.
 */
export interface PiCatalogPublication {
  readonly activation: PiConfigActivationResult;
  readonly manifest: PiConfigSourceManifest | undefined;
  readonly contents: PiConfigSourceContents | undefined;
}

/**
 * A validated candidate that was held back because publishing it would change
 * the active primary's contract.
 *
 * It is stored, never applied: only an explicit primary reactivation or a
 * session replacement may act on it. `changedFacets` and `changedPaths` are
 * carried for diagnostics and are already free of config content.
 */
export interface PiDeferredCatalogCandidate {
  readonly state: PiConfigCatalogState;
  readonly changedFacets: readonly PiPrimaryContractFacet[];
  readonly changedPaths: readonly string[];
}

/**
 * Whether a write reached the cell.
 *
 * `"stale"` is an expected outcome, not a failure: a refresh that completes
 * after its generation was revoked has nothing to publish into.
 */
export type PiCatalogWriteOutcome = "accepted" | "stale";

/** The generation's published catalog and its deferred candidate, if any. */
export interface PiCatalogCell {
  /** The generation this cell belongs to. Never reassigned. */
  readonly generationId: string;
  /** `false` once invalidated; every read then returns nothing usable. */
  isLive(): boolean;
  /** The whole published catalog, or `undefined` once invalidated. */
  publication(): PiCatalogPublication | undefined;
  /** The live activation non-pinned consumers resolve against. */
  activation(): PiConfigActivationResult | undefined;
  /** Live descriptors by name; empty once invalidated. */
  descriptors(): ReadonlyMap<string, AgentDescriptor>;
  /** Live `disabled.skills`; empty once invalidated. */
  disabledSkills(): readonly string[];
  /** Live workflow definitions; empty once invalidated. */
  workflows(): PiCatalogWorkflows;
  /** The published source manifest; `undefined` when refresh is unavailable. */
  manifest(): PiConfigSourceManifest | undefined;
  /**
   * The published state a refresh attempt starts from; `undefined` when the
   * cell is invalidated or carries no digest state.
   */
  refreshState(): PiConfigCatalogState | undefined;
  /**
   * Replaces the publication with one assignment and drops any deferred
   * candidate, which the newly published state supersedes.
   */
  publish(next: PiConfigCatalogState): PiCatalogWriteOutcome;
  /** Stores the candidate a primary-contract guard held back. */
  defer(candidate: PiDeferredCatalogCandidate): PiCatalogWriteOutcome;
  /** Reads the deferred candidate without consuming it. */
  deferred(): PiDeferredCatalogCandidate | undefined;
  /** Reads and clears the deferred candidate. */
  takeDeferred(): PiDeferredCatalogCandidate | undefined;
  /** Drops everything, permanently. Idempotent; safe on every revoke path. */
  invalidate(): void;
}

/** What one cell is seeded with at `session_start`. */
export interface PiCatalogCellSeed {
  readonly generationId: string;
  readonly activation: PiConfigActivationResult;
  /** Digest state; omit when the source graph could not be derived. */
  readonly manifest?: PiConfigSourceManifest;
  /** Cached source bytes; only meaningful together with `manifest`. */
  readonly contents?: PiConfigSourceContents;
}

function toPublication(
  activation: PiConfigActivationResult,
  manifest: PiConfigSourceManifest | undefined,
  contents: PiConfigSourceContents | undefined,
): PiCatalogPublication {
  return Object.freeze({
    activation,
    manifest,
    contents: manifest === undefined ? undefined : (contents ?? new Map()),
  });
}

/**
 * Seeds one generation's cell.
 *
 * Callers create this only after boot activation has been validated, so a
 * live cell always carries a real catalog.
 */
export function createPiCatalogCell(seed: PiCatalogCellSeed): PiCatalogCell {
  let publication: PiCatalogPublication | undefined = toPublication(
    seed.activation,
    seed.manifest,
    seed.contents,
  );
  let deferredCandidate: PiDeferredCatalogCandidate | undefined;

  const live = (): PiCatalogPublication | undefined => publication;

  return {
    generationId: seed.generationId,
    isLive: () => publication !== undefined,
    publication: live,
    activation: () => live()?.activation,
    descriptors: () =>
      live()?.activation.descriptors.byName ?? EMPTY_DESCRIPTORS,
    disabledSkills: () =>
      live()?.activation.config.disabled?.skills ?? EMPTY_DISABLED_SKILLS,
    workflows: () => live()?.activation.config.workflows ?? EMPTY_WORKFLOWS,
    manifest: () => live()?.manifest,
    refreshState: () => {
      const current = live();
      if (current === undefined || current.manifest === undefined) {
        return undefined;
      }
      return {
        activation: current.activation,
        manifest: current.manifest,
        contents: current.contents ?? new Map(),
      };
    },
    publish: (next) => {
      if (publication === undefined) return "stale";
      // One assignment: readers see the previous catalog or the next one,
      // never a mixture of the two.
      publication = toPublication(
        next.activation,
        next.manifest,
        next.contents,
      );
      deferredCandidate = undefined;
      return "accepted";
    },
    defer: (candidate) => {
      if (publication === undefined) return "stale";
      deferredCandidate = candidate;
      return "accepted";
    },
    deferred: () => (publication === undefined ? undefined : deferredCandidate),
    takeDeferred: () => {
      if (publication === undefined) return undefined;
      const held = deferredCandidate;
      deferredCandidate = undefined;
      return held;
    },
    invalidate: () => {
      publication = undefined;
      deferredCandidate = undefined;
    },
  };
}

/** Identity and config the seed manifest is derived from. */
export interface PiCatalogSeedManifestInput {
  readonly identity: PiConfigSourceIdentity;
  /** The merged config the boot activation produced. */
  readonly config: WeaveConfig;
  /** Home directory override; defaults to the loader's own resolution. */
  readonly homeDir?: string;
}

/**
 * Derives the source manifest a freshly booted generation starts from.
 *
 * Pure: it resolves the config file locations, collects the prompt files the
 * merged config references, and records them as *not yet observed*. Nothing is
 * stat'ed, read, or hashed here, so seeding cannot slow, block, or fail boot.
 * The first probe therefore sees every present source as `appeared` and reads
 * it once - never a silent "assume unchanged".
 *
 * Returns `undefined` when the source graph could not be derived at all (for
 * example an unreadable home directory). The catalog still serves every
 * consumer; only refresh stays unavailable, which is the fail-closed side.
 */
export function derivePiCatalogSeedManifest(
  input: PiCatalogSeedManifestInput,
): PiConfigSourceManifest | undefined {
  const derive = Result.fromThrowable(
    (): PiConfigSourceManifest => {
      const paths = resolvePiConfigSourcePaths(
        input.homeDir === undefined
          ? { identity: input.identity }
          : { identity: input.identity, homeDir: input.homeDir },
      );
      return createPiConfigSourceManifest({
        identity: input.identity,
        globalConfigPath: paths.globalConfigPath,
        projectConfigPath: paths.projectConfigPath,
        promptFilePaths: discoverPromptSourcePaths(input.config),
      });
    },
    () => undefined,
  );
  return derive().match(
    (manifest) => manifest,
    () => undefined,
  );
}

/** Holds the current generation's cell, if any. */
export interface PiCatalogCellHolder {
  cell: PiCatalogCell | undefined;
}

export function createPiCatalogCellHolder(): PiCatalogCellHolder {
  return { cell: undefined };
}

/**
 * Invalidates and drops the held cell.
 *
 * Every teardown path calls this, so a revoked generation's cell can never
 * serve a later reader - including through a closure that captured the cell
 * object itself.
 */
export function clearPiCatalogCell(holder: PiCatalogCellHolder): void {
  holder.cell?.invalidate();
  holder.cell = undefined;
}
