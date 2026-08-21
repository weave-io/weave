/**
 * Selection closure for the trunk-based release pipeline.
 *
 * A maintainer seeds a stable release with the public packages they mean to
 * ship. That seed is rarely the whole truth: a changeset is consumed as a
 * unit, and public artifacts bundle each other's source, so releasing one
 * package can force another. This module computes the smallest coherent
 * superset of the seed and explains every package it adds.
 *
 * Two rules close the set, applied to a fixed point:
 *
 * 1. **Shared-changeset atomicity.** A changeset naming several public
 *    packages is consumed atomically, so selecting one member selects all of
 *    them.
 * 2. **Artifact dependency/bundling.** A changeset's *changed sources* are the
 *    workspaces whose bytes it alters: the public packages it releases, plus
 *    the private workspaces it declares through `Bundled-source:`. When a
 *    selected package is related to a changed source, every other public
 *    package related to that same source joins the release, because their
 *    artifacts carry the same changed bytes.
 *
 * A public package is *related* to a changed source when it is that source,
 * when the workspace manifests give it a dependency path to that source, or
 * when the bundled-impact map declares that source's change as reaching it.
 * The manifest path is preferred as evidence because it is concrete; the
 * declared map is the safety net for a bundling relationship the manifests do
 * not spell out.
 *
 * The module is pure and total. It reads a boolean seed over the exact public
 * catalog, validated changesets, workspace manifest dependency data, and the
 * bundled-impact map, and returns a `Result`. It only ever adds, so a seed
 * member can never be dropped, and its output is a fixed point: closing an
 * already-closed selection adds nothing.
 *
 * Evidence is bounded by construction — two identifiers, one trigger, and
 * lists whose length is bounded by the closed workspace set — and every
 * ordering is derived from the catalog, so the output is byte-identical for
 * identical input.
 */
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import {
  PRIVATE_SOURCE_IMPACTS,
  type PublicImpactChangeset,
  type ValidatedChangeset,
} from "./changeset-policy.js";
import {
  PRIVATE_PACKAGE_NAMES,
  PRIVATE_WORKSPACE_NAMES,
  type PrivatePackageName,
  type PublicPackageName,
} from "./constants.js";
import { publishablePackageNames } from "./package-policy.js";

/** A workspace whose change can force a public package into a release. */
export type ChangedSourceName = PublicPackageName | PrivatePackageName;

/** The maintainer's seed: one boolean per catalog package. */
export type SelectionSeed = Readonly<Record<PublicPackageName, boolean>>;

/** One workspace's dependency edges, merged from every dependency field. */
export interface WorkspaceManifest {
  /** The workspace's package name. */
  name: string;
  /** Dependency names; entries outside the workspace set are ignored. */
  dependencies: readonly string[];
}

/** Public artifacts each private workspace's changed source reaches. */
export type BundledImpactMap = Readonly<
  Partial<Record<PrivatePackageName, readonly PublicPackageName[]>>
>;

export interface SelectionClosureInput {
  seed: SelectionSeed;
  /** Pending changesets, already validated by the changeset policy. */
  changesets: readonly ValidatedChangeset[];
  /** Dependency data for every workspace the closure may traverse. */
  manifests: readonly WorkspaceManifest[];
  /** Defaults to the policy's bundled-impact map. */
  bundledImpacts?: BundledImpactMap;
}

export type SelectionClosureError =
  | { type: "EmptySelection" }
  | { type: "UnknownWorkspace"; name: string }
  | { type: "DuplicateWorkspaceManifest"; name: string }
  | { type: "MissingWorkspaceManifest"; packageName: PublicPackageName };

/** How an added package reaches the changed source that pulled it in. */
export type SourceRelationship =
  | "changed-artifact"
  | "manifest-dependency"
  | "declared-impact";

export interface SharedChangesetEvidence {
  changesetId: string;
  sourceDigest: string;
  /** The already-selected member that made the changeset releasable. */
  trigger: PublicPackageName;
  /** Every public package the changeset releases, in catalog order. */
  members: readonly PublicPackageName[];
}

export interface ArtifactDependencyEvidence {
  changesetId: string;
  sourceDigest: string;
  /** The already-selected package that shares the changed source. */
  trigger: PublicPackageName;
  /** The workspace whose changed bytes both packages carry. */
  source: ChangedSourceName;
  relationship: SourceRelationship;
  /**
   * Workspace names from the added package to the changed source. Empty when
   * the added package is the changed source, or when only the bundled-impact
   * map declares the relationship.
   */
  dependencyPath: readonly string[];
}

export type SelectionReason =
  | { kind: "shared-changeset"; evidence: SharedChangesetEvidence }
  | { kind: "artifact-dependency"; evidence: ArtifactDependencyEvidence };

export interface SelectionAddition {
  package: PublicPackageName;
  reason: SelectionReason;
}

export interface SelectionClosure {
  /** The seed packages, in catalog order. */
  seed: readonly PublicPackageName[];
  /** Seed plus every addition, in catalog order. */
  selected: readonly PublicPackageName[];
  /** Every package the closure added, in catalog order, each explained. */
  added: readonly SelectionAddition[];
}

/**
 * Closes a seed selection over shared changesets and artifact dependencies.
 *
 * Returns `EmptySelection` when the seed selects nothing: a release with no
 * packages is a caller mistake, not an empty release.
 */
export function computeSelectionClosure(
  input: SelectionClosureInput,
): Result<SelectionClosure, SelectionClosureError> {
  const catalog = publishablePackageNames();
  const seed = catalog.filter((packageName) => input.seed[packageName]);
  if (seed.length === 0) return err({ type: "EmptySelection" });
  return buildWorkspaceGraph(input.manifests, catalog).map((graph) =>
    closeSelection(
      {
        catalog,
        changesets: orderChangesets(input.changesets),
        graph,
        bundledImpacts: input.bundledImpacts ?? PRIVATE_SOURCE_IMPACTS,
      },
      seed,
    ),
  );
}

interface ClosureContext {
  catalog: readonly PublicPackageName[];
  changesets: readonly PublicImpactChangeset[];
  graph: ReadonlyMap<string, readonly string[]>;
  bundledImpacts: BundledImpactMap;
}

interface SourceRelation {
  relationship: SourceRelationship;
  dependencyPath: readonly string[];
}

function closeSelection(
  context: ClosureContext,
  seed: readonly PublicPackageName[],
): SelectionClosure {
  const selected = new Set<PublicPackageName>(seed);
  const reasons = new Map<PublicPackageName, SelectionReason>();
  // Every productive round adds at least one of the finitely many catalog
  // packages, so the fixed point is reached within one round per package plus
  // the round that finds nothing.
  for (let round = 0; round <= context.catalog.length; round += 1) {
    const found = collectRound(context, selected);
    if (found.size === 0) break;
    for (const [packageName, reason] of found) {
      reasons.set(packageName, reason);
      selected.add(packageName);
    }
  }
  const added: SelectionAddition[] = [];
  for (const packageName of context.catalog) {
    const reason = reasons.get(packageName);
    if (reason === undefined) continue;
    added.push({ package: packageName, reason });
  }
  return {
    seed,
    selected: context.catalog.filter((packageName) =>
      selected.has(packageName),
    ),
    added,
  };
}

/**
 * Finds every package the current selection forces, explaining each once.
 * Changeset atomicity runs first, so a package reachable both ways is
 * explained by the changeset that consumes it.
 */
function collectRound(
  context: ClosureContext,
  selected: ReadonlySet<PublicPackageName>,
): ReadonlyMap<PublicPackageName, SelectionReason> {
  const found = new Map<PublicPackageName, SelectionReason>();
  for (const changeset of context.changesets) {
    const members = releaseMembers(context.catalog, changeset);
    const trigger = members.find((member) => selected.has(member));
    if (trigger === undefined) continue;
    for (const member of members) {
      if (selected.has(member) || found.has(member)) continue;
      found.set(member, {
        kind: "shared-changeset",
        evidence: {
          changesetId: changeset.identity.id,
          sourceDigest: changeset.identity.sourceDigest,
          trigger,
          members,
        },
      });
    }
  }
  for (const changeset of context.changesets)
    for (const source of changedSources(context.catalog, changeset)) {
      const trigger = context.catalog.find(
        (packageName) =>
          selected.has(packageName) &&
          relateToSource(context, packageName, source) !== null,
      );
      if (trigger === undefined) continue;
      for (const candidate of context.catalog) {
        if (selected.has(candidate) || found.has(candidate)) continue;
        const relation = relateToSource(context, candidate, source);
        if (relation === null) continue;
        found.set(candidate, {
          kind: "artifact-dependency",
          evidence: {
            changesetId: changeset.identity.id,
            sourceDigest: changeset.identity.sourceDigest,
            trigger,
            source,
            relationship: relation.relationship,
            dependencyPath: relation.dependencyPath,
          },
        });
      }
    }
  return found;
}

/** Decides whether a public package carries a changed source's bytes. */
function relateToSource(
  context: ClosureContext,
  packageName: PublicPackageName,
  source: ChangedSourceName,
): SourceRelation | null {
  if (packageName === source)
    return { relationship: "changed-artifact", dependencyPath: [] };
  const path = shortestWorkspacePath(context.graph, packageName, source);
  if (path !== null)
    return { relationship: "manifest-dependency", dependencyPath: path };
  if (isDeclaredImpact(context.bundledImpacts, source, packageName))
    return { relationship: "declared-impact", dependencyPath: [] };
  return null;
}

function isDeclaredImpact(
  bundledImpacts: BundledImpactMap,
  source: ChangedSourceName,
  packageName: PublicPackageName,
): boolean {
  if (!isPrivatePackageName(source)) return false;
  return (bundledImpacts[source] ?? []).includes(packageName);
}

function isPrivatePackageName(name: string): name is PrivatePackageName {
  return PRIVATE_PACKAGE_NAMES.some((candidate) => candidate === name);
}

/** The public packages a changeset releases, in catalog order. */
function releaseMembers(
  catalog: readonly PublicPackageName[],
  changeset: PublicImpactChangeset,
): readonly PublicPackageName[] {
  return catalog.filter((packageName) => changeset.releases.has(packageName));
}

/** Every workspace whose bytes a changeset alters, in a canonical order. */
function changedSources(
  catalog: readonly PublicPackageName[],
  changeset: PublicImpactChangeset,
): readonly ChangedSourceName[] {
  return [
    ...releaseMembers(catalog, changeset),
    ...PRIVATE_PACKAGE_NAMES.filter((source) =>
      changeset.bundledSources.includes(source),
    ),
  ];
}

/** Public-impact changesets only, ordered by their stable identity. */
function orderChangesets(
  changesets: readonly ValidatedChangeset[],
): readonly PublicImpactChangeset[] {
  return [...changesets]
    .filter(
      (changeset): changeset is PublicImpactChangeset =>
        changeset.kind === "public-impact",
    )
    .sort((left, right) => {
      const byId = compareText(left.identity.id, right.identity.id);
      if (byId !== 0) return byId;
      return compareText(left.path, right.path);
    });
}

/**
 * Reduces the manifests to workspace-only dependency edges.
 *
 * Fails closed: an unknown or duplicated workspace, or a catalog package with
 * no manifest, would silently under-select, which is exactly the failure this
 * module exists to prevent.
 */
function buildWorkspaceGraph(
  manifests: readonly WorkspaceManifest[],
  catalog: readonly PublicPackageName[],
): Result<ReadonlyMap<string, readonly string[]>, SelectionClosureError> {
  const workspaces = new Set<string>([...catalog, ...PRIVATE_WORKSPACE_NAMES]);
  const graph = new Map<string, readonly string[]>();
  for (const manifest of manifests) {
    if (!workspaces.has(manifest.name))
      return err({ type: "UnknownWorkspace", name: manifest.name });
    if (graph.has(manifest.name))
      return err({ type: "DuplicateWorkspaceManifest", name: manifest.name });
    const dependencies = [
      ...new Set(
        manifest.dependencies.filter(
          (dependency) =>
            workspaces.has(dependency) && dependency !== manifest.name,
        ),
      ),
    ].sort(compareText);
    graph.set(manifest.name, dependencies);
  }
  for (const packageName of catalog)
    if (!graph.has(packageName))
      return err({ type: "MissingWorkspaceManifest", packageName });
  return ok(graph);
}

/**
 * Breadth-first shortest dependency path, or `null` when none exists. The
 * adjacency lists are sorted, so the chosen path is deterministic.
 */
function shortestWorkspacePath(
  graph: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): readonly string[] | null {
  if (from === to) return null;
  const previous = new Map<string, string>();
  const visited = new Set<string>([from]);
  let frontier: readonly string[] = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const current of frontier)
      for (const dependency of graph.get(current) ?? []) {
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        previous.set(dependency, current);
        if (dependency === to) return tracePath(previous, from, to);
        next.push(dependency);
      }
    frontier = next;
  }
  return null;
}

function tracePath(
  previous: ReadonlyMap<string, string>,
  from: string,
  to: string,
): readonly string[] {
  const path = [to];
  let cursor = to;
  while (cursor !== from) {
    const parent = previous.get(cursor);
    if (parent === undefined) break;
    path.push(parent);
    cursor = parent;
  }
  return path.reverse();
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
