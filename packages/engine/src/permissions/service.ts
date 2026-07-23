import { err, errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { getPermissionApprovalRepository } from "../runtime/permission-repository.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";
import type { PermissionRegistryGeneration } from "./registry.js";
import {
  activatePermissionSessionInternal,
  type PermissionSession,
} from "./session.js";
import type { PermissionError } from "./types.js";

/** Inputs controlled by the engine when it activates a permission session. */
export interface PermissionServiceActivationInput {
  readonly project: string;
  readonly controllerSession: string;
  readonly registry: PermissionRegistryGeneration;
  readonly policies: Readonly<Record<string, EffectiveToolPolicy>>;
  readonly requestSchemaVersion: string;
}

const ACTIVATION_FIELDS = [
  "project",
  "controllerSession",
  "registry",
  "policies",
  "requestSchemaVersion",
] as const;

type CapturedActivation = Readonly<{
  project: unknown;
  session: unknown;
  registry: unknown;
  policies: unknown;
  requestSchemaVersion: unknown;
}>;

const invalidActivation = (): PermissionError => ({ type: "invalid_output" });

/**
 * Snapshot activation input as an exact plain own-enumerable data-property
 * record. Captures each allowed field once from its descriptor value so getters
 * never run and live [[Get]] traps are never used between reads. Rejects extras,
 * omissions, accessors, symbols, and non-plain prototypes with closed errors.
 * Reflection traps that throw fail closed via Result.fromThrowable — neverthrow
 * ResultAsync stays settled as Err, never a rejected promise.
 */
function snapshotActivationInput(
  input: unknown,
): Result<CapturedActivation, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype
      )
        return err(invalidActivation());

      const keys = Reflect.ownKeys(input);
      if (keys.length !== ACTIVATION_FIELDS.length)
        return err(invalidActivation());

      const captured: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          !(ACTIVATION_FIELDS as readonly string[]).includes(key)
        )
          return err(invalidActivation());
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
          !descriptor ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(invalidActivation());
        if (Object.hasOwn(captured, key)) return err(invalidActivation());
        captured[key] = descriptor.value;
      }
      for (const field of ACTIVATION_FIELDS) {
        if (!Object.hasOwn(captured, field)) return err(invalidActivation());
      }

      return ok(
        Object.freeze({
          project: captured.project,
          session: captured.controllerSession,
          registry: captured.registry,
          policies: captured.policies,
          requestSchemaVersion: captured.requestSchemaVersion,
        }),
      );
    },
    () => invalidActivation(),
  )().andThen((result) => result);
}

/**
 * Steady monotonic source for challenge/permit deadlines. Uses `performance.now`
 * (Bun/Web Performance API) so wall-clock rollback cannot extend volatile TTL.
 * Values are floored to safe integers; high-water clamping lives in the session.
 */
const productionMonotonicClock = (): number => {
  const value = performance.now();
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
};

/** Wall clock for audit timestamps and durable grant createdAt/expiry. */
const productionWallClock = (): number => Date.now();

const productionIds = (): string => crypto.randomUUID();

/**
 * Engine-owned permission lifecycle facade. Adapters provide identity and
 * policy intent, but never a repository, clock, id source, grant, or envelope.
 */
export class PermissionService {
  #store: RuntimeStore;

  constructor(store: RuntimeStore) {
    this.#store = store;
  }

  activate(
    input: PermissionServiceActivationInput,
  ): ResultAsync<PermissionSession, PermissionError> {
    const captured = snapshotActivationInput(input);
    if (captured.isErr()) return errAsync(captured.error);
    const repository = getPermissionApprovalRepository(this.#store);
    if (repository.isErr()) return errAsync(repository.error);
    return activatePermissionSessionInternal({
      project: captured.value.project as string,
      session: captured.value.session as string,
      registry: captured.value.registry as PermissionRegistryGeneration,
      policies: captured.value.policies as Readonly<
        Record<string, EffectiveToolPolicy>
      >,
      requestSchemaVersion: captured.value.requestSchemaVersion as string,
      monotonicClock: productionMonotonicClock,
      wallClock: productionWallClock,
      ids: productionIds,
      repository: repository.value,
    });
  }
}

export function createPermissionService(
  store: RuntimeStore,
): PermissionService {
  return new PermissionService(store);
}
