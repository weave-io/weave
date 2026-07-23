/**
 * Harness-neutral permission coverage proof.
 *
 * Adapters discover concrete tool inventories and interception state, then
 * call this pure engine helper with an explicit immutable context. The engine
 * never discovers harness tools or knows concrete harness names beyond the
 * opaque string identities supplied here.
 *
 * Concrete adapter wiring that fails tool-policy readiness on
 * `incomplete_coverage` is issue #21 "Enforce registered-tool policy".
 * This module supplies only the neutral proof primitive and its contract.
 *
 * See: docs/specs/34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md
 */

import { err, ok, Result } from "neverthrow";
import { snapshotArrayOnce } from "./array-snapshot.js";
import { utf8Bytes } from "./canonical.js";
import {
  type PermissionRegistryGeneration,
  readRegistryGenerationMeta,
  readRegistryInventory,
  validatePermissionRegistryGeneration,
} from "./registry.js";

const TOOL_IDENTITY_MAX_BYTES = 256;
const MAX_INVENTORY_SIZE = 4096;

const CONTEXT_FIELDS = [
  "registry",
  "nativeToolIdentities",
  "weaveOwnedToolIdentities",
  "interceptedToolIdentities",
  "bypassableToolIdentities",
  "unmanagedThirdPartyToolIdentities",
  "diagnostics",
] as const;

const DIAGNOSTICS_FIELDS = ["includeToolIdentities"] as const;

const INVENTORY_FIELDS = [
  "nativeToolIdentities",
  "weaveOwnedToolIdentities",
  "interceptedToolIdentities",
  "bypassableToolIdentities",
  "unmanagedThirdPartyToolIdentities",
] as const;

export type PermissionCoverageIncompleteReason =
  | "missing_registration"
  | "missing_interception"
  | "bypassable_call"
  | "generation_changed"
  | "inventory_changed"
  | "overlap_ambiguity"
  | "duplicate_identity";

export type PermissionCoverageError =
  | {
      readonly type: "invalid_coverage";
      readonly path?: string;
      readonly message?: string;
    }
  | {
      readonly type: "incomplete_coverage";
      readonly reason: PermissionCoverageIncompleteReason;
      readonly toolIdentity?: string;
      readonly message?: string;
    };

export interface PermissionCoverageDiagnosticsPolicy {
  readonly includeToolIdentities: boolean;
}

/**
 * Explicit adapter-supplied coverage context.
 *
 * - `nativeToolIdentities` / `weaveOwnedToolIdentities` MUST be registered and
 *   non-bypassably intercepted.
 * - Every identity present in the sealed registry (including registered
 *   third-party tools) MUST appear in `interceptedToolIdentities`.
 * - `unmanagedThirdPartyToolIdentities` may remain unregistered; Weave issues
 *   no permit for them.
 * - The engine snapshots plain data once and never re-enters getters/proxies.
 * - Inventory arrays use the shared one-shot descriptor snapshot (prototype,
 *   ownKeys, length, indexed data descriptors captured exactly once).
 */
export interface PermissionCoverageContext {
  readonly registry: PermissionRegistryGeneration;
  readonly nativeToolIdentities: readonly string[];
  readonly weaveOwnedToolIdentities: readonly string[];
  readonly interceptedToolIdentities: readonly string[];
  readonly bypassableToolIdentities: readonly string[];
  readonly unmanagedThirdPartyToolIdentities: readonly string[];
  readonly diagnostics: PermissionCoverageDiagnosticsPolicy;
}

export interface PermissionCoverageProof {
  readonly generationId: string;
  readonly metadataIdentity: string;
  readonly requiredCount: number;
  readonly registeredCount: number;
  readonly interceptedCount: number;
  readonly unmanagedCount: number;
  readonly requiredToolIdentities?: readonly string[];
  readonly registeredToolIdentities?: readonly string[];
  readonly interceptedToolIdentities?: readonly string[];
  readonly unmanagedToolIdentities?: readonly string[];
}

type SnapshotRecord = Record<string, unknown>;

type CapturedContext = Readonly<{
  registry: PermissionRegistryGeneration;
  generationId: string;
  metadataIdentity: string;
  registeredToolIdentities: readonly string[];
  nativeToolIdentities: readonly string[];
  weaveOwnedToolIdentities: readonly string[];
  interceptedToolIdentities: readonly string[];
  bypassableToolIdentities: readonly string[];
  unmanagedThirdPartyToolIdentities: readonly string[];
  includeToolIdentities: boolean;
}>;

const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const invalid = (message: string, path?: string): PermissionCoverageError => ({
  type: "invalid_coverage",
  ...(path === undefined ? {} : { path }),
  message,
});

const incomplete = (
  reason: PermissionCoverageIncompleteReason,
  message: string,
  toolIdentity?: string,
): PermissionCoverageError => ({
  type: "incomplete_coverage",
  reason,
  ...(toolIdentity === undefined ? {} : { toolIdentity }),
  message,
});

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

function snapshotPlainRecord(
  input: unknown,
  fields: readonly string[],
  path: string,
): Result<SnapshotRecord, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      if (typeof input !== "object" || input === null)
        return err(invalid(`${path} must be a plain object`, path));
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        return err(invalid(`${path} must be a plain object`, path));

      const keys = Reflect.ownKeys(input);
      if (keys.length !== fields.length)
        return err(invalid(`${path} has unexpected or missing fields`, path));

      const snapshot: SnapshotRecord = Object.create(null);
      const seen = new Set<string>();
      for (const key of keys) {
        if (typeof key !== "string" || !fields.includes(key))
          return err(invalid(`${path} has unexpected or missing fields`, path));
        if (seen.has(key))
          return err(invalid(`${path} has unexpected or missing fields`, path));
        seen.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            invalid(
              `${path}.${key} must be an own enumerable data property`,
              `${path}.${key}`,
            ),
          );
        snapshot[key] = descriptor.value;
      }
      for (const field of fields) {
        if (!seen.has(field))
          return err(invalid(`${path} has unexpected or missing fields`, path));
      }
      return ok(snapshot);
    },
    () => invalid(`${path} must be a plain object`, path),
  )().andThen((result) => result);
}

function captureToolIdentity(
  value: unknown,
  path: string,
): Result<string, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      if (typeof value !== "string" || value.length === 0)
        return err(invalid(`${path} must be a nonempty string`, path));
      if (hasLoneSurrogate(value))
        return err(invalid(`${path} contains a lone surrogate`, path));
      const bytes = utf8Bytes(value, TOOL_IDENTITY_MAX_BYTES);
      if (bytes.isErr())
        return err(
          invalid(
            `${path} exceeds ${TOOL_IDENTITY_MAX_BYTES} UTF-8 bytes`,
            path,
          ),
        );
      return ok(value);
    },
    () => invalid(`${path} must be a nonempty string`, path),
  )().andThen((result) => result);
}

function captureIdentityList(
  value: unknown,
  path: string,
): Result<readonly string[], PermissionCoverageError> {
  // One-shot descriptor snapshot: never reread live length/indices. A vanishing
  // inventory proxy must fail invalid_coverage, not yield zero-count readiness.
  const snapshotted = snapshotArrayOnce(value).mapErr(() =>
    invalid(`${path} must be a plain dense array`, path),
  );
  if (snapshotted.isErr()) return err(snapshotted.error);
  if (snapshotted.value.length > MAX_INVENTORY_SIZE)
    return err(
      invalid(`${path} exceeds ${MAX_INVENTORY_SIZE} identities`, path),
    );

  return Result.fromThrowable(
    () => {
      const captured: string[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < snapshotted.value.length; index += 1) {
        const entryPath = `${path}[${index}]`;
        const identity = captureToolIdentity(
          snapshotted.value[index],
          entryPath,
        );
        if (identity.isErr()) return err(identity.error);
        if (seen.has(identity.value))
          return err(
            incomplete(
              "duplicate_identity",
              "tool identity list contains a duplicate",
              identity.value,
            ),
          );
        seen.add(identity.value);
        captured.push(identity.value);
      }
      return ok(Object.freeze(captured.slice()) as readonly string[]);
    },
    () => invalid(`${path} must be a plain dense array`, path),
  )().andThen((result) => result);
}

function captureRegistrySnapshot(
  registry: PermissionRegistryGeneration,
): Result<
  {
    readonly generationId: string;
    readonly metadataIdentity: string;
    readonly registeredToolIdentities: readonly string[];
  },
  PermissionCoverageError
> {
  return Result.fromThrowable(
    () => {
      // Authoritative path: module-private non-virtual accessors, not public
      // instance/prototype lookup/get/inventory methods.
      const meta = readRegistryGenerationMeta(registry);
      if (meta.isErr())
        return err(
          invalid("registry generation metadata is invalid", "registry"),
        );
      const generationId = meta.value.id;
      const metadataIdentity = meta.value.identity;
      if (
        typeof generationId !== "string" ||
        generationId.length === 0 ||
        typeof metadataIdentity !== "string" ||
        metadataIdentity.length === 0
      )
        return err(
          invalid("registry generation metadata is invalid", "registry"),
        );

      const inventoryResult = readRegistryInventory(registry);
      if (inventoryResult.isErr())
        return err(invalid("registry inventory is invalid", "registry"));
      const inventory = inventoryResult.value;
      if (!Array.isArray(inventory))
        return err(invalid("registry inventory is invalid", "registry"));

      const registered: string[] = [];
      const seen = new Set<string>();
      for (const entry of inventory) {
        if (!entry || typeof entry !== "object")
          return err(
            invalid("registry inventory entry is invalid", "registry"),
          );
        const toolIdentity = (entry as { toolIdentity?: unknown }).toolIdentity;
        if (typeof toolIdentity !== "string" || toolIdentity.length === 0)
          return err(
            invalid("registry inventory entry is invalid", "registry"),
          );
        if (seen.has(toolIdentity))
          return err(
            incomplete(
              "duplicate_identity",
              "registry inventory contains a duplicate",
              toolIdentity,
            ),
          );
        seen.add(toolIdentity);
        registered.push(toolIdentity);
      }
      registered.sort(compareCodeUnits);
      return ok({
        generationId,
        metadataIdentity,
        registeredToolIdentities: Object.freeze(
          registered,
        ) as readonly string[],
      });
    },
    () => invalid("registry generation could not be snapshotted", "registry"),
  )().andThen((result) => result);
}

function captureContext(
  input: unknown,
): Result<CapturedContext, PermissionCoverageError> {
  const top = snapshotPlainRecord(input, CONTEXT_FIELDS, "context");
  if (top.isErr()) return err(top.error);

  const branded = validatePermissionRegistryGeneration(top.value.registry);
  if (branded.isErr())
    return err(
      invalid("registry must be a sealed branded generation", "registry"),
    );

  const registrySnapshot = captureRegistrySnapshot(branded.value);
  if (registrySnapshot.isErr()) return err(registrySnapshot.error);

  const lists: Record<(typeof INVENTORY_FIELDS)[number], readonly string[]> =
    Object.create(null);
  for (const field of INVENTORY_FIELDS) {
    const captured = captureIdentityList(top.value[field], field);
    if (captured.isErr()) return err(captured.error);
    lists[field] = captured.value;
  }

  const diagnostics = snapshotPlainRecord(
    top.value.diagnostics,
    DIAGNOSTICS_FIELDS,
    "diagnostics",
  );
  if (diagnostics.isErr()) return err(diagnostics.error);
  if (typeof diagnostics.value.includeToolIdentities !== "boolean")
    return err(
      invalid(
        "diagnostics.includeToolIdentities must be a boolean",
        "diagnostics.includeToolIdentities",
      ),
    );

  return ok(
    Object.freeze({
      registry: branded.value,
      generationId: registrySnapshot.value.generationId,
      metadataIdentity: registrySnapshot.value.metadataIdentity,
      registeredToolIdentities: registrySnapshot.value.registeredToolIdentities,
      nativeToolIdentities: lists.nativeToolIdentities,
      weaveOwnedToolIdentities: lists.weaveOwnedToolIdentities,
      interceptedToolIdentities: lists.interceptedToolIdentities,
      bypassableToolIdentities: lists.bypassableToolIdentities,
      unmanagedThirdPartyToolIdentities:
        lists.unmanagedThirdPartyToolIdentities,
      includeToolIdentities: diagnostics.value.includeToolIdentities,
    }),
  );
}

function findOverlap(
  left: readonly string[],
  right: ReadonlySet<string>,
): string | undefined {
  for (const identity of left) {
    if (right.has(identity)) return identity;
  }
  return undefined;
}

function verifySemantics(
  context: CapturedContext,
): Result<void, PermissionCoverageError> {
  const native = new Set(context.nativeToolIdentities);
  const weave = new Set(context.weaveOwnedToolIdentities);
  const unmanaged = new Set(context.unmanagedThirdPartyToolIdentities);
  const intercepted = new Set(context.interceptedToolIdentities);
  const registered = new Set(context.registeredToolIdentities);

  const nativeWeave = findOverlap(context.nativeToolIdentities, weave);
  if (nativeWeave !== undefined)
    return err(
      incomplete(
        "overlap_ambiguity",
        "native and weave-owned inventories overlap",
        nativeWeave,
      ),
    );

  const nativeUnmanaged = findOverlap(context.nativeToolIdentities, unmanaged);
  if (nativeUnmanaged !== undefined)
    return err(
      incomplete(
        "overlap_ambiguity",
        "native and unmanaged inventories overlap",
        nativeUnmanaged,
      ),
    );

  const weaveUnmanaged = findOverlap(
    context.weaveOwnedToolIdentities,
    unmanaged,
  );
  if (weaveUnmanaged !== undefined)
    return err(
      incomplete(
        "overlap_ambiguity",
        "weave-owned and unmanaged inventories overlap",
        weaveUnmanaged,
      ),
    );

  for (const identity of context.registeredToolIdentities) {
    if (unmanaged.has(identity))
      return err(
        incomplete(
          "overlap_ambiguity",
          "registered tool cannot also be listed as unmanaged",
          identity,
        ),
      );
  }

  for (const identity of context.nativeToolIdentities) {
    if (!registered.has(identity))
      return err(
        incomplete(
          "missing_registration",
          "native tool lacks registration",
          identity,
        ),
      );
  }

  for (const identity of context.weaveOwnedToolIdentities) {
    if (!registered.has(identity))
      return err(
        incomplete(
          "missing_registration",
          "weave-owned tool lacks registration",
          identity,
        ),
      );
  }

  for (const identity of context.registeredToolIdentities) {
    if (!intercepted.has(identity))
      return err(
        incomplete(
          "missing_interception",
          "registered tool lacks interception",
          identity,
        ),
      );
  }

  for (const identity of context.bypassableToolIdentities) {
    if (native.has(identity) || weave.has(identity) || registered.has(identity))
      return err(
        incomplete(
          "bypassable_call",
          "required or registered tool is marked bypassable",
          identity,
        ),
      );
  }

  return ok(undefined);
}

function assertStableSnapshot(
  context: CapturedContext,
): Result<void, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      const liveMeta = readRegistryGenerationMeta(context.registry);
      if (
        liveMeta.isErr() ||
        liveMeta.value.id !== context.generationId ||
        liveMeta.value.identity !== context.metadataIdentity
      )
        return err(
          incomplete(
            "generation_changed",
            "registry generation changed during coverage verification",
          ),
        );

      const live = captureRegistrySnapshot(context.registry);
      if (live.isErr()) return err(live.error);
      if (
        live.value.generationId !== context.generationId ||
        live.value.metadataIdentity !== context.metadataIdentity
      )
        return err(
          incomplete(
            "generation_changed",
            "registry generation changed during coverage verification",
          ),
        );

      if (
        live.value.registeredToolIdentities.length !==
          context.registeredToolIdentities.length ||
        live.value.registeredToolIdentities.some(
          (identity, index) =>
            identity !== context.registeredToolIdentities[index],
        )
      )
        return err(
          incomplete(
            "inventory_changed",
            "registry inventory changed during coverage verification",
          ),
        );

      return ok(undefined);
    },
    () =>
      incomplete(
        "generation_changed",
        "registry generation changed during coverage verification",
      ),
  )().andThen((result) => result);
}

function buildProof(
  context: CapturedContext,
): Result<PermissionCoverageProof, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      const required = [
        ...context.nativeToolIdentities,
        ...context.weaveOwnedToolIdentities,
      ].sort(compareCodeUnits);
      const registered = [...context.registeredToolIdentities].sort(
        compareCodeUnits,
      );
      const intercepted = [...context.interceptedToolIdentities].sort(
        compareCodeUnits,
      );
      const unmanaged = [...context.unmanagedThirdPartyToolIdentities].sort(
        compareCodeUnits,
      );

      const proof: PermissionCoverageProof = {
        generationId: context.generationId,
        metadataIdentity: context.metadataIdentity,
        requiredCount: required.length,
        registeredCount: registered.length,
        interceptedCount: intercepted.length,
        unmanagedCount: unmanaged.length,
        ...(context.includeToolIdentities
          ? {
              requiredToolIdentities: Object.freeze(required),
              registeredToolIdentities: Object.freeze(registered),
              interceptedToolIdentities: Object.freeze(intercepted),
              unmanagedToolIdentities: Object.freeze(unmanaged),
            }
          : {}),
      };
      return ok(Object.freeze(proof));
    },
    () => invalid("unable to build coverage proof"),
  )().andThen((result) => result);
}

/**
 * Verify that an adapter-supplied inventory and interception claim covers the
 * sealed registry generation for tool-policy readiness.
 *
 * Returns an immutable proof on success. Adapters map `incomplete_coverage`
 * and `invalid_coverage` to the required `tool-policy-mapping` readiness
 * failure for the controller generation.
 */
export function verifyPermissionCoverage(
  context: PermissionCoverageContext,
): Result<PermissionCoverageProof, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      const captured = captureContext(context);
      if (captured.isErr()) return err(captured.error);
      const semantics = verifySemantics(captured.value);
      if (semantics.isErr()) return err(semantics.error);
      const stable = assertStableSnapshot(captured.value);
      if (stable.isErr()) return err(stable.error);
      return buildProof(captured.value);
    },
    () => invalid("coverage context could not be verified"),
  )().andThen((result) => result);
}
