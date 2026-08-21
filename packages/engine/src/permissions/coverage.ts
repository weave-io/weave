/**
 * Harness-neutral permission coverage proof.
 *
 * Adapters discover concrete tool inventories and interception state, then
 * call this pure engine helper with an explicit immutable context. The engine
 * never discovers harness tools or knows concrete harness names beyond the
 * opaque string identities supplied here.
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
type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type ObjectLike<T> = T & object;
type CapturedInventoryLists = {
  readonly nativeToolIdentities: readonly string[];
  readonly weaveOwnedToolIdentities: readonly string[];
  readonly interceptedToolIdentities: readonly string[];
  readonly bypassableToolIdentities: readonly string[];
  readonly unmanagedThirdPartyToolIdentities: readonly string[];
};
type MutableInvalidCoverage = {
  type: "invalid_coverage";
  message: string;
  path?: string;
};
type MutableIncompleteCoverage = {
  type: "incomplete_coverage";
  reason: PermissionCoverageIncompleteReason;
  message: string;
  toolIdentity?: string;
};
type MutableCoverageProof = {
  generationId: string;
  metadataIdentity: string;
  requiredCount: number;
  registeredCount: number;
  interceptedCount: number;
  unmanagedCount: number;
  requiredToolIdentities?: readonly string[];
  registeredToolIdentities?: readonly string[];
  interceptedToolIdentities?: readonly string[];
  unmanagedToolIdentities?: readonly string[];
};

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

/** Explicit adapter-supplied coverage context. */
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

const completed = (): Result<void, PermissionCoverageError> => ok(void 0);

const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const invalid = (message: string, path?: string): PermissionCoverageError => {
  const error: MutableInvalidCoverage = { type: "invalid_coverage", message };
  if (path !== undefined) error.path = path;
  return error;
};

const incomplete = (
  reason: PermissionCoverageIncompleteReason,
  message: string,
  toolIdentity?: string,
): PermissionCoverageError => {
  const error: MutableIncompleteCoverage = {
    type: "incomplete_coverage",
    reason,
    message,
  };
  if (toolIdentity !== undefined) error.toolIdentity = toolIdentity;
  return error;
};

const primitiveTag = <T>(value: T): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Object(value) === value) return "object";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  return tagged.isOk() ? tagged.value : "[object Object]";
};

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && value !== undefined && Object(value) === value;

const parseText = <T>(
  value: T,
  path: string,
): Result<string, PermissionCoverageError> => {
  if (primitiveTag(value) !== "[object String]")
    return err(invalid(`${path} must be a nonempty string`, path));
  const text = String(value);
  if (text.length === 0 || /[\uD800-\uDFFF]/u.test(text))
    return err(invalid(`${path} must be a nonempty string`, path));
  return ok(text);
};

const parseBoolean = <T>(
  value: T,
  path: string,
): Result<boolean, PermissionCoverageError> => {
  if (primitiveTag(value) !== "[object Boolean]")
    return err(invalid(`${path} must be a boolean`, path));
  return ok(value === true);
};

function snapshotPlainRecord<T>(
  input: T,
  fields: readonly string[],
  path: string,
): Result<SnapshotFields, PermissionCoverageError> {
  return Result.fromThrowable(
    () => {
      if (!isObjectLike(input) || Array.isArray(input))
        return err(invalid(`${path} must be a plain object`, path));
      if (Object.getPrototypeOf(input) !== Object.prototype)
        return err(invalid(`${path} must be a plain object`, path));
      const keys = Reflect.ownKeys(input);
      if (keys.length !== fields.length)
        return err(invalid(`${path} has unexpected or missing fields`, path));
      const allowed = new Set(fields);
      const snapshot = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalid(`${path} has unexpected or missing fields`, path));
        const text = String(key);
        if (!allowed.has(text))
          return err(invalid(`${path} has unexpected or missing fields`, path));
        const descriptor = Object.getOwnPropertyDescriptor(input, text);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            invalid(
              `${path}.${String(key)} must be an own enumerable data property`,
              `${path}.${String(key)}`,
            ),
          );
        snapshot.set(text, descriptor);
      }
      for (const field of fields) {
        if (!snapshot.has(field))
          return err(invalid(`${path} has unexpected or missing fields`, path));
      }
      return ok(snapshot);
    },
    () => invalid(`${path} must be a plain object`, path),
  )().andThen((result) => result);
}

function captureToolIdentity<T>(
  value: T,
  path: string,
): Result<string, PermissionCoverageError> {
  return parseText(value, path).andThen((text) => {
    const bytes = utf8Bytes(text, TOOL_IDENTITY_MAX_BYTES);
    if (bytes.isErr())
      return err(
        invalid(`${path} exceeds ${TOOL_IDENTITY_MAX_BYTES} UTF-8 bytes`, path),
      );
    return ok(text);
  });
}

function captureIdentityList<T>(
  value: T,
  path: string,
): Result<readonly string[], PermissionCoverageError> {
  const snapshotted = snapshotArrayOnce(value).mapErr(() =>
    invalid(`${path} must be a plain dense array`, path),
  );
  if (snapshotted.isErr()) return err(snapshotted.error);
  if (snapshotted.value.length > MAX_INVENTORY_SIZE)
    return err(
      invalid(`${path} exceeds ${MAX_INVENTORY_SIZE} identities`, path),
    );

  const captured: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < snapshotted.value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const identity = captureToolIdentity(
      snapshotted.value[index]?.value,
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
  return ok(Object.freeze(captured.slice()));
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
      const meta = readRegistryGenerationMeta(registry);
      if (meta.isErr())
        return err(
          invalid("registry generation metadata is invalid", "registry"),
        );
      const inventoryResult = readRegistryInventory(registry);
      if (inventoryResult.isErr())
        return err(invalid("registry inventory is invalid", "registry"));

      const registered: string[] = [];
      const seen = new Set<string>();
      for (const entry of inventoryResult.value) {
        const identity = captureToolIdentity(
          entry.toolIdentity,
          "registry.inventory.toolIdentity",
        );
        if (identity.isErr())
          return err(invalid("registry inventory is invalid", "registry"));
        if (seen.has(identity.value))
          return err(
            incomplete(
              "duplicate_identity",
              "registry inventory contains a duplicate",
              identity.value,
            ),
          );
        seen.add(identity.value);
        registered.push(identity.value);
      }
      registered.sort(compareCodeUnits);
      return ok({
        generationId: meta.value.id,
        metadataIdentity: meta.value.identity,
        registeredToolIdentities: Object.freeze(registered.slice()),
      });
    },
    () => invalid("registry generation could not be snapshotted", "registry"),
  )().andThen((result) => result);
}

function captureContext<T>(
  input: T,
): Result<CapturedContext, PermissionCoverageError> {
  const top = snapshotPlainRecord(input, CONTEXT_FIELDS, "context");
  if (top.isErr()) return err(top.error);
  const registryValue = top.value.get("registry")?.value;
  const branded = validatePermissionRegistryGeneration(registryValue);
  if (branded.isErr())
    return err(
      invalid("registry must be a sealed branded generation", "registry"),
    );
  const registrySnapshot = captureRegistrySnapshot(branded.value);
  if (registrySnapshot.isErr()) return err(registrySnapshot.error);

  const nativeToolIdentities = captureIdentityList(
    top.value.get("nativeToolIdentities")?.value,
    "nativeToolIdentities",
  );
  const weaveOwnedToolIdentities = captureIdentityList(
    top.value.get("weaveOwnedToolIdentities")?.value,
    "weaveOwnedToolIdentities",
  );
  const interceptedToolIdentities = captureIdentityList(
    top.value.get("interceptedToolIdentities")?.value,
    "interceptedToolIdentities",
  );
  const bypassableToolIdentities = captureIdentityList(
    top.value.get("bypassableToolIdentities")?.value,
    "bypassableToolIdentities",
  );
  const unmanagedThirdPartyToolIdentities = captureIdentityList(
    top.value.get("unmanagedThirdPartyToolIdentities")?.value,
    "unmanagedThirdPartyToolIdentities",
  );
  if (nativeToolIdentities.isErr()) return err(nativeToolIdentities.error);
  if (weaveOwnedToolIdentities.isErr())
    return err(weaveOwnedToolIdentities.error);
  if (interceptedToolIdentities.isErr())
    return err(interceptedToolIdentities.error);
  if (bypassableToolIdentities.isErr())
    return err(bypassableToolIdentities.error);
  if (unmanagedThirdPartyToolIdentities.isErr())
    return err(unmanagedThirdPartyToolIdentities.error);
  const lists: CapturedInventoryLists = {
    nativeToolIdentities: nativeToolIdentities.value,
    weaveOwnedToolIdentities: weaveOwnedToolIdentities.value,
    interceptedToolIdentities: interceptedToolIdentities.value,
    bypassableToolIdentities: bypassableToolIdentities.value,
    unmanagedThirdPartyToolIdentities: unmanagedThirdPartyToolIdentities.value,
  };

  const diagnostics = snapshotPlainRecord(
    top.value.get("diagnostics")?.value,
    DIAGNOSTICS_FIELDS,
    "diagnostics",
  );
  if (diagnostics.isErr()) return err(diagnostics.error);
  const includeToolIdentities = parseBoolean(
    diagnostics.value.get("includeToolIdentities")?.value,
    "diagnostics.includeToolIdentities",
  );
  if (includeToolIdentities.isErr()) return err(includeToolIdentities.error);

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
      includeToolIdentities: includeToolIdentities.value,
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
  return completed();
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
      return completed();
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
      const proof: MutableCoverageProof = {
        generationId: context.generationId,
        metadataIdentity: context.metadataIdentity,
        requiredCount: required.length,
        registeredCount: registered.length,
        interceptedCount: intercepted.length,
        unmanagedCount: unmanaged.length,
      };
      if (context.includeToolIdentities) {
        proof.requiredToolIdentities = Object.freeze(required);
        proof.registeredToolIdentities = Object.freeze(registered);
        proof.interceptedToolIdentities = Object.freeze(intercepted);
        proof.unmanagedToolIdentities = Object.freeze(unmanaged);
      }
      return ok(Object.freeze(proof));
    },
    () => invalid("unable to build coverage proof"),
  )().andThen((result) => result);
}

/** Verify that an adapter-supplied inventory covers the sealed registry. */
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
