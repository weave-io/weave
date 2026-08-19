import { err, errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { getPermissionApprovalRepository } from "../runtime/permission-repository.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";
import {
  type PermissionRegistryGeneration,
  validatePermissionRegistryGeneration,
} from "./registry.js";
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
const POLICY_FIELDS = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
] as const;
type ObjectLike<T> = T & object;
type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type CapturedActivation = {
  readonly project: string;
  readonly session: string;
  readonly registry: PermissionRegistryGeneration;
  readonly policies: Readonly<Record<string, EffectiveToolPolicy>>;
  readonly requestSchemaVersion: string;
};

const invalidActivation = (): PermissionError => ({ type: "invalid_output" });

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
  maxBytes: number,
): Result<string, PermissionError> => {
  if (primitiveTag(value) !== "[object String]")
    return err(invalidActivation());
  const text = String(value);
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > maxBytes)
    return err(invalidActivation());
  return ok(text);
};

type PolicyDecision = EffectiveToolPolicy[keyof EffectiveToolPolicy];

const parseDecision = <T>(
  value: T,
): Result<PolicyDecision, PermissionError> => {
  if (primitiveTag(value) !== "[object String]")
    return err(invalidActivation());
  const text = String(value);
  if (text === "allow") return ok("allow");
  if (text === "deny") return ok("deny");
  if (text === "ask") return ok("ask");
  return err(invalidActivation());
};

function snapshotOwnFields<T>(
  input: T,
  allowed: readonly string[] | undefined,
  required: readonly string[],
): Result<SnapshotFields, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (!isObjectLike(input) || Array.isArray(input))
        return err(invalidActivation());
      if (Object.getPrototypeOf(input) !== Object.prototype)
        return err(invalidActivation());
      const keys = Reflect.ownKeys(input);
      if (allowed !== undefined && keys.length > allowed.length)
        return err(invalidActivation());
      if (keys.length < required.length) return err(invalidActivation());
      const allowedSet = allowed === undefined ? undefined : new Set(allowed);
      const fields = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalidActivation());
        const text = String(key);
        if (allowedSet !== undefined && !allowedSet.has(text))
          return err(invalidActivation());
        const descriptor = Object.getOwnPropertyDescriptor(input, text);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(invalidActivation());
        fields.set(text, descriptor);
      }
      for (const field of required) {
        if (!fields.has(field)) return err(invalidActivation());
      }
      return ok(fields);
    },
    () => invalidActivation(),
  )().andThen((result) => result);
}

function capturePolicies<T>(
  value: T,
): Result<Readonly<Record<string, EffectiveToolPolicy>>, PermissionError> {
  const top = snapshotOwnFields(value, undefined, []);
  if (top.isErr() || top.value.size === 0) return err(invalidActivation());
  const entries: Array<[string, EffectiveToolPolicy]> = [];
  for (const [agent, descriptor] of top.value) {
    const policyFields = snapshotOwnFields(
      descriptor.value,
      POLICY_FIELDS,
      POLICY_FIELDS,
    );
    if (policyFields.isErr()) return err(invalidActivation());
    const read = parseDecision(policyFields.value.get("read")?.value);
    const write = parseDecision(policyFields.value.get("write")?.value);
    const execute = parseDecision(policyFields.value.get("execute")?.value);
    const delegate = parseDecision(policyFields.value.get("delegate")?.value);
    const network = parseDecision(policyFields.value.get("network")?.value);
    if (
      read.isErr() ||
      write.isErr() ||
      execute.isErr() ||
      delegate.isErr() ||
      network.isErr()
    )
      return err(invalidActivation());
    const policy: EffectiveToolPolicy = {
      read: read.value,
      write: write.value,
      execute: execute.value,
      delegate: delegate.value,
      network: network.value,
    };
    entries.push([agent, Object.freeze(policy)]);
  }
  return ok(Object.freeze(Object.fromEntries(entries)));
}

/** Snapshot activation input without invoking accessors or live proxy reads. */
function snapshotActivationInput<T>(
  input: T,
): Result<CapturedActivation, PermissionError> {
  return Result.fromThrowable(
    () => {
      const fields = snapshotOwnFields(
        input,
        ACTIVATION_FIELDS,
        ACTIVATION_FIELDS,
      );
      if (fields.isErr()) return err(fields.error);
      const project = parseText(fields.value.get("project")?.value, 256);
      const session = parseText(
        fields.value.get("controllerSession")?.value,
        256,
      );
      const requestSchemaVersion = parseText(
        fields.value.get("requestSchemaVersion")?.value,
        64,
      );
      const registry = validatePermissionRegistryGeneration(
        fields.value.get("registry")?.value,
      );
      const policies = capturePolicies(fields.value.get("policies")?.value);
      if (
        project.isErr() ||
        session.isErr() ||
        requestSchemaVersion.isErr() ||
        registry.isErr() ||
        policies.isErr()
      )
        return err(invalidActivation());
      return ok(
        Object.freeze({
          project: project.value,
          session: session.value,
          registry: registry.value,
          policies: policies.value,
          requestSchemaVersion: requestSchemaVersion.value,
        }),
      );
    },
    () => invalidActivation(),
  )().andThen((result) => result);
}

const productionMonotonicClock = (): number => {
  const value = performance.now();
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
};
const productionWallClock = (): number => Date.now();
const productionIds = (): string => crypto.randomUUID();

/** Engine-owned permission lifecycle facade. */
export class PermissionService {
  #store: RuntimeStore;

  constructor(store: RuntimeStore) {
    this.#store = store;
  }

  activate<T>(input: T): ResultAsync<PermissionSession, PermissionError> {
    const captured = snapshotActivationInput(input);
    if (captured.isErr()) return errAsync(captured.error);
    const repository = getPermissionApprovalRepository(this.#store);
    if (repository.isErr()) return errAsync(repository.error);
    return activatePermissionSessionInternal({
      project: captured.value.project,
      session: captured.value.session,
      registry: captured.value.registry,
      policies: captured.value.policies,
      requestSchemaVersion: captured.value.requestSchemaVersion,
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
