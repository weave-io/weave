import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { EffectiveToolPolicy } from "../tool-policy.js";
import { snapshotArrayOnce } from "./array-snapshot.js";
import {
  cloneAndFreezeJson,
  normalizePermissionRequests,
  permissionDigest,
  requestBindingKey,
  requestKey,
} from "./canonical.js";
import {
  invokePermissionResolver,
  lookupRegistryRegistration,
  type PermissionRegistryGeneration,
  readRegistryGenerationMeta,
  validatePermissionRegistryGeneration,
} from "./registry.js";
import type {
  Clock,
  DeniedPermissionRequestView,
  DurablePermissionGrantRecord,
  GrantIdentityEnvelope,
  GrantScope,
  IdSource,
  JsonValue,
  PendingPermissionRequestView,
  PermissionApprovalRepository,
  PermissionApprovalResponse,
  PermissionAuditEvent,
  PermissionCallInput,
  PermissionChallengeConsumeInput,
  PermissionDecision,
  PermissionError,
  PermissionExecutionSnapshot,
  PermissionGrantSummary,
  PermissionOutcome,
  PermissionPermitConsumeInput,
  PermissionRegistration,
  PermissionRequest,
} from "./types.js";

const invalid = (): PermissionError => ({ type: "invalid_output" });
const repositoryFailure = (): PermissionError => ({
  type: "repository_failure",
});
const failure = <T>(error: PermissionError): ResultAsync<T, PermissionError> =>
  errAsync(error);

type ObjectLike<T> = T & object;
type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type PrimitiveTag = "null" | "undefined" | "string" | "number" | "object";
type MutableCapturedChoice = {
  requestId: string;
  decision: "allow" | "deny";
  scope?: GrantScope;
  expiresAt?: number;
};
type CapturedChoice = Readonly<MutableCapturedChoice>;
type MutablePolicies = { [agentName: string]: EffectiveToolPolicy };

const POLICY_FIELDS = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
] as const;
type CapturedResponse = Readonly<{
  challenge: string;
  choices: readonly CapturedChoice[];
}>;
type CapturedCall = Readonly<{
  project: string;
  session: string;
  agentName: string;
  toolIdentity: string;
  registryGeneration: string;
  call: JsonValue;
  approvalUiAvailable: boolean;
}>;
type CapturedChallengeInput = Readonly<{
  challenge: string;
  project: string;
  session: string;
  agentName: string;
  toolIdentity: string;
  registryGeneration: string;
}>;
type CapturedPermitInput = Readonly<{
  permit: string;
  project: string;
  session: string;
  agentName: string;
  toolIdentity: string;
  registryGeneration: string;
  call: JsonValue;
}>;
type CapturedReplacement = Readonly<{
  registry: PermissionRegistryGeneration;
}>;

type Request = Readonly<{
  id: string;
  request: PermissionRequest;
  key: string;
  envelope: GrantIdentityEnvelope;
  view: PendingPermissionRequestView;
}>;
type Challenge = Readonly<{
  project: string;
  session: string;
  agent: string;
  tool: string;
  owner: string;
  revision: string;
  generation: string;
  policy: string;
  call: string;
  callInput: JsonValue;
  expires: number;
  requests: readonly Request[];
}>;
type Permit = {
  readonly project: string;
  readonly session: string;
  readonly agent: string;
  readonly tool: string;
  readonly owner: string;
  readonly revision: string;
  readonly generation: string;
  readonly policy: string;
  readonly call: string;
  readonly callInput: JsonValue;
  readonly expires: number;
  consumed: boolean;
  readonly bindings: readonly string[];
};

const primitiveTag = <T>(value: T): PrimitiveTag => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Object(value) === value) return "object";
  const tagged = Result.fromThrowable(
    () => Object.prototype.toString.call(value),
    () => "[object Object]",
  )();
  if (tagged.isErr()) return "object";
  if (tagged.value === "[object String]") return "string";
  if (tagged.value === "[object Number]") return "number";
  return "object";
};

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && value !== undefined && Object(value) === value;

function objectSnapshot<T>(
  value: T,
  allowed: readonly string[] | undefined,
  required: readonly string[],
): Result<SnapshotFields, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (!isObjectLike(value) || Array.isArray(value)) return err(invalid());
      if (Object.getPrototypeOf(value) !== Object.prototype)
        return err(invalid());
      const keys = Reflect.ownKeys(value);
      const allowedSet = allowed === undefined ? undefined : new Set(allowed);
      if (allowed !== undefined && keys.length > allowed.length)
        return err(invalid());
      if (keys.length < required.length) return err(invalid());
      const fields = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalid());
        const text = String(key);
        if (allowedSet !== undefined && !allowedSet.has(text))
          return err(invalid());
        const descriptor = Object.getOwnPropertyDescriptor(value, text);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(invalid());
        fields.set(text, descriptor);
      }
      for (const field of required) {
        if (!fields.has(field)) return err(invalid());
      }
      return ok(fields);
    },
    () => invalid(),
  )().andThen((result) => result);
}

function arraySnapshot<T>(
  value: T,
): Result<readonly PropertyDescriptor[], PermissionError> {
  return snapshotArrayOnce(value).mapErr(() => invalid());
}

const validText = <T>(value: T, max: number): value is T & string => {
  if (primitiveTag(value) !== "string") return false;
  const text = String(value);
  if (text.length === 0) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= text.length) return false;
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(text).byteLength <= max;
};

const decision = <T>(value: T): value is T & PermissionDecision =>
  value === "allow" || value === "deny" || value === "ask";

const actualRegistry = <T>(
  value: T,
): Result<PermissionRegistryGeneration, PermissionError> =>
  validatePermissionRegistryGeneration(value).mapErr(() => invalid());

type Callable = (...args: never[]) => never;

const isCallable = <T>(value: T): value is T & Callable => {
  const source = Result.fromThrowable(
    () => Function.prototype.toString.call(value),
    () => "",
  )();
  return source.isOk() && !source.value.trimStart().startsWith("class ");
};
const isClock = <T>(value: T): value is T & Clock => isCallable(value);
const isIdSource = <T>(value: T): value is T & IdSource => isCallable(value);

const hasCallableMethod = <T>(value: T, name: string): boolean => {
  if (!isObjectLike(value)) return false;
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined)
      return "value" in descriptor && isCallable(descriptor.value);
    current = Object.getPrototypeOf(current);
  }
  return false;
};

const isRepository = <T>(
  value: T,
): value is T & PermissionApprovalRepository => {
  const checked = Result.fromThrowable(
    () =>
      hasCallableMethod(value, "saveMany") &&
      hasCallableMethod(value, "list") &&
      hasCallableMethod(value, "revoke") &&
      hasCallableMethod(value, "match"),
    () => false,
  )();
  return checked.isOk() && checked.value;
};

const textField = (
  fields: SnapshotFields,
  name: string,
  max: number,
): Result<string, PermissionError> => {
  const value = fields.get(name)?.value;
  if (!validText(value, max)) return err(invalid());
  return ok(String(value));
};

const captureCall = <T>(value: T): Result<CapturedCall, PermissionError> =>
  objectSnapshot(
    value,
    [
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
      "call",
      "approvalUiAvailable",
    ],
    [
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
      "call",
      "approvalUiAvailable",
    ],
  ).andThen((fields) => {
    const project = textField(fields, "project", 256);
    const session = textField(fields, "session", 256);
    const agentName = textField(fields, "agentName", 256);
    const toolIdentity = textField(fields, "toolIdentity", 256);
    const registryGeneration = textField(fields, "registryGeneration", 256);
    const approvalUiAvailable = fields.get("approvalUiAvailable")?.value;
    if (
      project.isErr() ||
      session.isErr() ||
      agentName.isErr() ||
      toolIdentity.isErr() ||
      registryGeneration.isErr() ||
      (approvalUiAvailable !== true && approvalUiAvailable !== false)
    )
      return err(invalid());
    return cloneAndFreezeJson(fields.get("call")?.value).andThen((call) =>
      ok(
        Object.freeze({
          project: project.value,
          session: session.value,
          agentName: agentName.value,
          toolIdentity: toolIdentity.value,
          registryGeneration: registryGeneration.value,
          call,
          approvalUiAvailable,
        }),
      ),
    );
  });

const captureChallengeInput = <T>(
  value: T,
): Result<CapturedChallengeInput, PermissionError> =>
  objectSnapshot(
    value,
    [
      "challenge",
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
    ],
    [
      "challenge",
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
    ],
  ).andThen((fields) => {
    const challenge = textField(fields, "challenge", 256);
    const project = textField(fields, "project", 256);
    const session = textField(fields, "session", 256);
    const agentName = textField(fields, "agentName", 256);
    const toolIdentity = textField(fields, "toolIdentity", 256);
    const registryGeneration = textField(fields, "registryGeneration", 256);
    if (
      challenge.isErr() ||
      project.isErr() ||
      session.isErr() ||
      agentName.isErr() ||
      toolIdentity.isErr() ||
      registryGeneration.isErr()
    )
      return err(invalid());
    return ok(
      Object.freeze({
        challenge: challenge.value,
        project: project.value,
        session: session.value,
        agentName: agentName.value,
        toolIdentity: toolIdentity.value,
        registryGeneration: registryGeneration.value,
      }),
    );
  });

const captureChoice = <T>(value: T): Result<CapturedChoice, PermissionError> =>
  objectSnapshot(
    value,
    ["requestId", "decision", "scope", "expiresAt"],
    ["requestId", "decision"],
  ).andThen((fields) => {
    const requestId = textField(fields, "requestId", 256);
    const rawDecision = fields.get("decision")?.value;
    if (
      requestId.isErr() ||
      (rawDecision !== "allow" && rawDecision !== "deny")
    )
      return err(invalid());
    const choice: MutableCapturedChoice = {
      requestId: requestId.value,
      decision: rawDecision,
    };
    if (fields.has("scope")) {
      const scope = fields.get("scope")?.value;
      if (scope !== undefined) {
        if (scope !== "once" && scope !== "session" && scope !== "durable")
          return err(invalid());
        choice.scope = scope;
      }
    }
    if (fields.has("expiresAt")) {
      const expiresAt = fields.get("expiresAt")?.value;
      if (expiresAt !== undefined) {
        if (primitiveTag(expiresAt) !== "number") return err(invalid());
        const numericExpiry = Number(expiresAt);
        if (!Number.isSafeInteger(numericExpiry) || numericExpiry < 0)
          return err(invalid());
        choice.expiresAt = numericExpiry;
      }
    }
    return ok(Object.freeze(choice));
  });

const captureResponse = <T>(
  value: T,
): Result<CapturedResponse, PermissionError> =>
  objectSnapshot(
    value,
    ["challenge", "choices"],
    ["challenge", "choices"],
  ).andThen((fields) => {
    const challenge = textField(fields, "challenge", 256);
    if (challenge.isErr()) return err(invalid());
    return arraySnapshot(fields.get("choices")?.value).andThen((choices) => {
      const captured: CapturedChoice[] = [];
      for (const descriptor of choices) {
        const checked = captureChoice(descriptor.value);
        if (checked.isErr()) return err(checked.error);
        captured.push(checked.value);
      }
      return ok(
        Object.freeze({
          challenge: challenge.value,
          choices: Object.freeze(captured),
        }),
      );
    });
  });

const capturePermit = <T>(
  value: T,
): Result<CapturedPermitInput, PermissionError> =>
  objectSnapshot(
    value,
    [
      "permit",
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
      "call",
    ],
    [
      "permit",
      "project",
      "session",
      "agentName",
      "toolIdentity",
      "registryGeneration",
      "call",
    ],
  ).andThen((fields) => {
    const permit = textField(fields, "permit", 256);
    const project = textField(fields, "project", 256);
    const session = textField(fields, "session", 256);
    const agentName = textField(fields, "agentName", 256);
    const toolIdentity = textField(fields, "toolIdentity", 256);
    const registryGeneration = textField(fields, "registryGeneration", 256);
    if (
      permit.isErr() ||
      project.isErr() ||
      session.isErr() ||
      agentName.isErr() ||
      toolIdentity.isErr() ||
      registryGeneration.isErr()
    )
      return err(invalid());
    return cloneAndFreezeJson(fields.get("call")?.value).andThen((call) =>
      ok(
        Object.freeze({
          permit: permit.value,
          project: project.value,
          session: session.value,
          agentName: agentName.value,
          toolIdentity: toolIdentity.value,
          registryGeneration: registryGeneration.value,
          call,
        }),
      ),
    );
  });

export interface PermissionSessionTestingOptions {
  project: string;
  session: string;
  registry: PermissionRegistryGeneration;
  policies: Readonly<Record<string, EffectiveToolPolicy>>;
  requestSchemaVersion: string;
  /**
   * Monotonic clock for challenge (5m) and permit (30s) deadlines.
   * Independent from wall clock so tests can roll either source back.
   */
  monotonicClock: Clock;
  /**
   * Wall clock for audit timestamps and durable grant createdAt/expiry.
   * Clamped by a nondecreasing high-water mark inside the session.
   */
  wallClock: Clock;
  ids: IdSource;
  repository: PermissionApprovalRepository;
  auditCapacity?: number;
}
export interface PermissionRegistryReplacement {
  readonly registry: PermissionRegistryGeneration;
}

let activateSessionInternal!: <T>(
  input: T,
) => ResultAsync<PermissionSession, PermissionError>;
const sessionConstructionToken = Symbol("PermissionSession");
const sessionBrand = new WeakSet<object>();
const sessionInstances = new WeakMap<object, PermissionSession>();

export class PermissionSession {
  static {
    activateSessionInternal = <T>(input: T) =>
      PermissionSession.#activate(input);
  }

  #o: PermissionSessionTestingOptions;
  #registry: PermissionRegistryGeneration;
  /**
   * Session-observed registry generation IDs. Initialized with the activation
   * generation and extended on each successful replacement. Replay of the
   * current or any previously observed ID is rejected as
   * `invalid_registry_transition`.
   */
  #observedGenerationIds = new Set<string>();
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  #policies: Readonly<Record<string, EffectiveToolPolicy>>;
  #fingerprints = new Map<string, string>();
  #grants = new Map<string, GrantScope>();
  #challenges = new Map<string, Challenge>();
  #challengeTombstones = new Set<string>();
  #expiredChallengeTombstones = new Set<string>();
  #permits = new Map<string, Permit>();
  #permitTombstones = new Set<string>();
  #expiredPermitTombstones = new Set<string>();
  #auditLog: PermissionAuditEvent[] = [];
  /** Nondecreasing high-water for challenge/permit deadline arithmetic. */
  #monotonicHighWater = 0;
  /** Nondecreasing high-water for audit and durable wall timestamps. */
  #wallHighWater = 0;

  private constructor(
    token: symbol,
    o: PermissionSessionTestingOptions,
    policies: Readonly<Record<string, EffectiveToolPolicy>>,
    fingerprints: ReadonlyMap<string, string>,
    initialGenerationId: string,
    monoSeed: number,
    wallSeed: number,
  ) {
    if (token !== sessionConstructionToken)
      throw new TypeError("invalid session construction token");
    sessionBrand.add(this);
    sessionInstances.set(this, this);
    this.#o = o;
    this.#registry = o.registry;
    this.#observedGenerationIds.add(initialGenerationId);
    this.#policies = policies;
    this.#monotonicHighWater = monoSeed;
    this.#wallHighWater = wallSeed;
    for (const [agent, fingerprint] of fingerprints)
      this.#fingerprints.set(agent, fingerprint);
    // Freeze the genuine instance so own-method shadowing of authorizeCall,
    // consumePermit, answer/cancel, replace, close, list/revoke/audit cannot
    // stick. ECMAScript #private state remains mutable internally.
    Object.freeze(this);
  }

  static #activate<T>(
    input: T,
  ): ResultAsync<PermissionSession, PermissionError> {
    const captured = objectSnapshot(
      input,
      [
        "project",
        "session",
        "registry",
        "policies",
        "requestSchemaVersion",
        "monotonicClock",
        "wallClock",
        "ids",
        "repository",
        "auditCapacity",
      ],
      [
        "project",
        "session",
        "registry",
        "policies",
        "requestSchemaVersion",
        "monotonicClock",
        "wallClock",
        "ids",
        "repository",
      ],
    );
    if (captured.isErr()) return failure(captured.error);
    const fields = captured.value;
    const project = textField(fields, "project", 256);
    const session = textField(fields, "session", 256);
    const requestSchemaVersion = textField(fields, "requestSchemaVersion", 64);
    if (project.isErr()) return failure(project.error);
    if (session.isErr()) return failure(session.error);
    if (requestSchemaVersion.isErr())
      return failure(requestSchemaVersion.error);

    const monotonicClockValue = fields.get("monotonicClock")?.value;
    const wallClockValue = fields.get("wallClock")?.value;
    const idsValue = fields.get("ids")?.value;
    const repositoryValue = fields.get("repository")?.value;
    if (
      !isClock(monotonicClockValue) ||
      !isClock(wallClockValue) ||
      !isIdSource(idsValue) ||
      !isRepository(repositoryValue)
    )
      return failure(invalid());

    const registry = actualRegistry(fields.get("registry")?.value);
    if (registry.isErr()) return failure(registry.error);
    const policies = objectSnapshot(
      fields.get("policies")?.value,
      undefined,
      [],
    );
    if (policies.isErr() || policies.value.size === 0)
      return failure(invalid());

    const copiedPolicies: MutablePolicies = Object.create(null);
    const fingerprints = new Map<string, string>();
    for (const [agent, descriptor] of policies.value) {
      if (!validText(agent, 256)) return failure(invalid());
      const rawPolicy = objectSnapshot(
        descriptor.value,
        POLICY_FIELDS,
        POLICY_FIELDS,
      );
      if (rawPolicy.isErr()) return failure(rawPolicy.error);
      const read = rawPolicy.value.get("read")?.value;
      const write = rawPolicy.value.get("write")?.value;
      const execute = rawPolicy.value.get("execute")?.value;
      const delegate = rawPolicy.value.get("delegate")?.value;
      const network = rawPolicy.value.get("network")?.value;
      if (
        !decision(read) ||
        !decision(write) ||
        !decision(execute) ||
        !decision(delegate) ||
        !decision(network)
      )
        return failure(invalid());
      const policy: EffectiveToolPolicy = Object.freeze({
        read,
        write,
        execute,
        delegate,
        network,
      });
      copiedPolicies[agent] = policy;
      const fingerprint = permissionDigest(policy);
      if (fingerprint.isErr()) return failure(fingerprint.error);
      fingerprints.set(agent, fingerprint.value);
    }

    let capacity = 512;
    if (fields.has("auditCapacity")) {
      const capacityValue = fields.get("auditCapacity")?.value;
      if (primitiveTag(capacityValue) !== "number") return failure(invalid());
      capacity = Number(capacityValue);
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
      return failure(invalid());

    const monoSeed = Result.fromThrowable(
      () => monotonicClockValue(),
      () => invalid(),
    )().andThen((value) =>
      Number.isSafeInteger(value) && value >= 0 ? ok(value) : err(invalid()),
    );
    if (monoSeed.isErr()) return failure(monoSeed.error);
    const wallSeed = Result.fromThrowable(
      () => wallClockValue(),
      () => invalid(),
    )().andThen((value) =>
      Number.isSafeInteger(value) && value >= 0 ? ok(value) : err(invalid()),
    );
    if (wallSeed.isErr()) return failure(wallSeed.error);

    const options: PermissionSessionTestingOptions = {
      project: project.value,
      session: session.value,
      registry: registry.value,
      policies: Object.freeze(copiedPolicies),
      requestSchemaVersion: requestSchemaVersion.value,
      monotonicClock: monotonicClockValue,
      wallClock: wallClockValue,
      ids: idsValue,
      repository: repositoryValue,
      auditCapacity: capacity,
    };
    const generationMeta = readRegistryGenerationMeta(registry.value);
    if (generationMeta.isErr()) return failure(generationMeta.error);
    return ResultAsync.fromSafePromise(
      Promise.resolve(
        new PermissionSession(
          sessionConstructionToken,
          options,
          options.policies,
          fingerprints,
          generationMeta.value.id,
          monoSeed.value,
          wallSeed.value,
        ),
      ),
    );
  }

  private serial<T>(
    work: () => Promise<Result<T, PermissionError>>,
  ): ResultAsync<T, PermissionError> {
    const execute = async (): Promise<Result<T, PermissionError>> => {
      const wrapped = await ResultAsync.fromThrowable(work, () => invalid())();
      if (wrapped.isErr()) return err(wrapped.error);
      return wrapped.value;
    };
    const run = this.#tail.then(execute, execute);
    this.#tail = run.then(
      () => void 0,
      () => void 0,
    );
    return ResultAsync.fromPromise(run, () => invalid()).andThen(
      (result) => result,
    );
  }

  /**
   * Read a clock source and clamp to a nondecreasing high-water mark.
   * A regressing source reuses the prior high-water so TTL arithmetic never
   * extends; invalid/throwing sources fail closed as `invalid_output`.
   */
  private readClock(
    source: Clock,
    highWater: "mono" | "wall",
  ): Result<number, PermissionError> {
    return Result.fromThrowable(
      () => source(),
      () => invalid(),
    )().andThen((value) => {
      if (!Number.isSafeInteger(value) || value < 0) return err(invalid());
      if (highWater === "mono") {
        if (value < this.#monotonicHighWater)
          return ok(this.#monotonicHighWater);
        this.#monotonicHighWater = value;
        return ok(value);
      }
      if (value < this.#wallHighWater) return ok(this.#wallHighWater);
      this.#wallHighWater = value;
      return ok(value);
    });
  }

  /** Monotonic time for challenge/permit deadlines and purge. */
  private monoNow(): Result<number, PermissionError> {
    return this.readClock(this.#o.monotonicClock, "mono");
  }

  /** Wall time for audit timestamps and durable grant comparisons. */
  private wallNow(): Result<number, PermissionError> {
    return this.readClock(this.#o.wallClock, "wall");
  }

  /**
   * Capture both clocks once per serialized operation. Monotonic drives
   * volatile TTL; wall drives audit/durable paths.
   */
  private sessionClocks(): Result<
    { readonly mono: number; readonly wall: number },
    PermissionError
  > {
    const mono = this.monoNow();
    if (mono.isErr()) return err(mono.error);
    const wall = this.wallNow();
    if (wall.isErr()) return err(wall.error);
    return ok({ mono: mono.value, wall: wall.value });
  }

  private purge(now: number): void {
    for (const [id, challenge] of this.#challenges)
      if (challenge.expires <= now) {
        this.#challenges.delete(id);
        this.#expiredChallengeTombstones.add(id);
      }
    for (const [id, permit] of this.#permits)
      if (permit.expires <= now) {
        this.#permits.delete(id);
        this.#expiredPermitTombstones.add(id);
      }
    while (
      this.#challengeTombstones.size + this.#expiredChallengeTombstones.size >
      256
    ) {
      if (this.#challengeTombstones.size) {
        const first = this.#challengeTombstones.values().next();
        if (!first.done) this.#challengeTombstones.delete(first.value);
      } else {
        const first = this.#expiredChallengeTombstones.values().next();
        if (!first.done) this.#expiredChallengeTombstones.delete(first.value);
      }
    }
    while (
      this.#permitTombstones.size + this.#expiredPermitTombstones.size >
      256
    ) {
      if (this.#permitTombstones.size) {
        const first = this.#permitTombstones.values().next();
        if (!first.done) this.#permitTombstones.delete(first.value);
      } else {
        const first = this.#expiredPermitTombstones.values().next();
        if (!first.done) this.#expiredPermitTombstones.delete(first.value);
      }
    }
  }

  private nextUniqueId(
    reserved: ReadonlySet<string>,
  ): Result<string, PermissionError> {
    const occupied = new Set([
      ...reserved,
      ...this.#challenges.keys(),
      ...this.#permits.keys(),
      ...this.#challengeTombstones,
      ...this.#expiredChallengeTombstones,
      ...this.#permitTombstones,
      ...this.#expiredPermitTombstones,
    ]);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = Result.fromThrowable(
        () => this.#o.ids(),
        () => invalid(),
      )();
      if (id.isErr()) return err(id.error);
      if (validText(id.value, 256) && !occupied.has(id.value))
        return ok(id.value);
    }
    return err(invalid());
  }

  private safeExpiry(
    now: number,
    ttl: number,
  ): Result<number, PermissionError> {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(ttl) ||
      ttl < 0 ||
      now > Number.MAX_SAFE_INTEGER - ttl
    )
      return err(invalid());
    return ok(now + ttl);
  }

  private challengeState(id: string): PermissionError {
    if (this.#expiredChallengeTombstones.has(id))
      return { type: "expired_challenge" };
    if (this.#challengeTombstones.has(id))
      return { type: "consumed_challenge" };
    return { type: "unknown_challenge" };
  }

  private permitState(id: string): PermissionError {
    if (this.#expiredPermitTombstones.has(id))
      return { type: "expired_permit" };
    if (this.#permitTombstones.has(id)) return { type: "consumed_permit" };
    return { type: "unknown_permit" };
  }

  private record(
    type: PermissionAuditEvent["type"],
    agentName: string,
    timestamp: number,
    toolIdentity?: string,
    count?: number,
    errorCategory?: PermissionError["type"],
    outcome?: "approved" | "rejected" | "policy_denied",
  ): void {
    type MutableAuditCommon = {
      project: string;
      agentName: string;
      toolIdentity?: string;
      timestamp: number;
    };
    const common: MutableAuditCommon = {
      project: this.#o.project,
      agentName,
      timestamp,
    };
    if (toolIdentity !== undefined) common.toolIdentity = toolIdentity;

    let event: PermissionAuditEvent;
    if (type === "authorization_denied") {
      if (outcome === "policy_denied") {
        if (count === undefined)
          event = Object.freeze({ ...common, type, outcome });
        else event = Object.freeze({ ...common, type, count, outcome });
      } else if (errorCategory) {
        if (count === undefined)
          event = Object.freeze({ ...common, type, errorCategory });
        else event = Object.freeze({ ...common, type, count, errorCategory });
      } else return;
    } else if (type === "approval_requested") {
      if (toolIdentity === undefined || count === undefined) return;
      event = Object.freeze({ ...common, type, toolIdentity, count });
    } else if (type === "approval_answered") {
      if (toolIdentity === undefined || count === undefined) return;
      if (outcome !== "approved" && outcome !== "rejected") return;
      event = Object.freeze({ ...common, type, toolIdentity, count, outcome });
    } else if (type === "permit_issued" || type === "permit_consumed") {
      if (toolIdentity === undefined) return;
      event = Object.freeze({ ...common, type, toolIdentity });
    } else {
      event = Object.freeze({ ...common, type });
    }
    this.#auditLog.push(event);
    while (this.#auditLog.length > (this.#o.auditCapacity ?? 512))
      this.#auditLog.shift();
  }

  private fail<T>(
    error: PermissionError,
    agent: string,
    timestamp: number,
    tool?: string,
  ): Result<T, PermissionError> {
    this.record(
      "authorization_denied",
      agent,
      timestamp,
      tool,
      undefined,
      error.type,
    );
    return err(error);
  }

  private envelope(
    reg: PermissionRegistration,
    agent: string,
    key: string,
  ): GrantIdentityEnvelope {
    return Object.freeze({
      projectIdentity: this.#o.project,
      agentName: agent,
      registrationOwner: reg.owner,
      toolIdentity: reg.toolIdentity,
      registrationRevision: reg.revision,
      policyFingerprint: this.#fingerprints.get(agent) ?? "",
      requestSchemaVersion: this.#o.requestSchemaVersion,
      requestDigest: key,
    });
  }

  private deniedView(request: PermissionRequest): DeniedPermissionRequestView {
    return request.unresolved
      ? Object.freeze({ display: request.display })
      : Object.freeze({
          capability: request.capability,
          operation: request.operation,
          target: request.target,
          display: request.display,
        });
  }

  private view(
    id: string,
    request: PermissionRequest,
  ): PendingPermissionRequestView {
    // permission contract: each pending request retains its own identity, decision,
    // source, and reason even when the UI groups them. Closed bounded fields
    // only — never raw policy objects, digests, or caller-controlled text.
    if (request.unresolved) {
      return Object.freeze({
        requestId: id,
        display: request.display,
        decision: "ask" as const,
        source: "resolver" as const,
        reason: "unresolved_request" as const,
      });
    }
    return Object.freeze({
      requestId: id,
      capability: request.capability,
      operation: request.operation,
      target: request.target,
      display: request.display,
      decision: "ask" as const,
      source: "policy" as const,
      reason: "policy_ask_without_grant" as const,
    });
  }

  private check(input: CapturedCall): PermissionError | undefined {
    if (this.#closed) return { type: "closed_session" };
    if (input.project !== this.#o.project || input.session !== this.#o.session)
      return { type: "mismatched_session" };
    if (!this.#fingerprints.has(input.agentName))
      return { type: "unknown_agent" };
    const meta = readRegistryGenerationMeta(this.#registry);
    if (meta.isErr() || input.registryGeneration !== meta.value.id)
      return { type: "stale_permission_state" };
    return undefined;
  }

  private lookup(
    toolIdentity: string,
  ): Result<PermissionRegistration | undefined, PermissionError> {
    // Authoritative path: non-virtual WeakMap-backed accessor, not the public
    // instance/prototype lookup method (which is informational only).
    return lookupRegistryRegistration(this.#registry, toolIdentity).mapErr(() =>
      invalid(),
    );
  }

  private repositoryCall<T>(
    operation: () => ResultAsync<T, PermissionError>,
  ): ResultAsync<T, PermissionError> {
    const execute = async (): Promise<Result<T, PermissionError>> => {
      const returned = await operation();
      const checked = Result.fromThrowable(
        () => {
          if (!returned.isErr()) return ok(returned.value);
          if (returned.error.type === "unknown_grant")
            return err({ type: "unknown_grant" as const });
          return err(repositoryFailure());
        },
        () => repositoryFailure(),
      )();
      if (checked.isErr()) return err(checked.error);
      return checked.value;
    };
    return ResultAsync.fromThrowable(execute, () =>
      repositoryFailure(),
    )().andThen((result) => result);
  }

  authorizeCall(
    input: PermissionCallInput,
  ): ResultAsync<PermissionOutcome, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const captured = captureCall(input);
    if (captured.isErr()) return failure(captured.error);
    return this.serial(() => this.authorizeCaptured(captured.value));
  }

  private async authorizeCaptured(
    input: CapturedCall,
  ): Promise<Result<PermissionOutcome, PermissionError>> {
    const now = this.sessionClocks();
    if (now.isErr()) return err(now.error);
    const mono = now.value.mono;
    const wall = now.value.wall;
    this.purge(mono);
    const bad = this.check(input);
    if (bad) return this.fail(bad, input.agentName, wall, input.toolIdentity);
    const registration = this.lookup(input.toolIdentity);
    if (registration.isErr())
      return this.fail(
        registration.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const reg = registration.value;
    if (!reg) return ok({ kind: "unmanaged" });
    const resolved = Result.fromThrowable(
      () =>
        invokePermissionResolver(reg.resolver, input.call, {
          toolIdentity: reg.toolIdentity,
          owner: reg.owner,
          revision: reg.revision,
        }),
      () => invalid(),
    )();
    if (resolved.isErr())
      return this.fail(
        resolved.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    if (resolved.value.isErr())
      return this.fail(
        resolved.value.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const normalized = normalizePermissionRequests(resolved.value.value);
    if (normalized.isErr())
      return this.fail(
        normalized.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const unique = new Map<string, PermissionRequest>();
    for (const request of normalized.value) {
      const key = requestBindingKey(request);
      if (key.isErr())
        return this.fail(key.error, input.agentName, wall, input.toolIdentity);
      if (!unique.has(key.value)) unique.set(key.value, request);
    }
    const policy = this.#policies[input.agentName];
    if (!policy)
      return this.fail({ type: "unknown_agent" }, input.agentName, wall);
    const entries = [...unique.entries()];
    const denied = entries.filter(
      ([, request]) =>
        !request.unresolved && policy[request.capability] === "deny",
    );
    if (denied.length) {
      this.record(
        "authorization_denied",
        input.agentName,
        wall,
        input.toolIdentity,
        denied.length,
        undefined,
        "policy_denied",
      );
      return ok({
        kind: "denied",
        requests: denied.map(([, request]) => this.deniedView(request)),
      });
    }
    const pending: Request[] = [];
    for (const [key, request] of entries) {
      if (!request.unresolved && policy[request.capability] === "allow")
        continue;
      let grantKey = "";
      if (!request.unresolved) {
        const result = requestKey(request);
        if (result.isErr())
          return this.fail(
            result.error,
            input.agentName,
            wall,
            input.toolIdentity,
          );
        grantKey = result.value;
      }
      const envelope = this.envelope(reg, input.agentName, grantKey);
      let granted =
        !request.unresolved && this.#grants.has(JSON.stringify(envelope));
      if (!granted && !request.unresolved) {
        const match = this.repositoryCall(() =>
          this.#o.repository.match(envelope, wall),
        );
        const result = await match;
        if (result.isErr())
          return this.fail(
            result.error,
            input.agentName,
            wall,
            input.toolIdentity,
          );
        granted = result.value !== undefined;
      }
      if (!granted) {
        const id = this.nextUniqueId(new Set(pending.map((item) => item.id)));
        if (id.isErr())
          return this.fail(id.error, input.agentName, wall, input.toolIdentity);
        pending.push(
          Object.freeze({
            id: id.value,
            request,
            key,
            envelope,
            view: this.view(id.value, request),
          }),
        );
      }
    }
    if (!pending.length) {
      const call = permissionDigest(input.call);
      if (call.isErr())
        return this.fail(call.error, input.agentName, wall, input.toolIdentity);
      return this.issueFromDigest(
        input,
        reg,
        call.value,
        entries.map(([key]) => key),
        mono,
        wall,
      );
    }
    if (
      pending.some((item) => item.request.unresolved) &&
      !input.approvalUiAvailable
    )
      return this.fail(
        { type: "unresolved_ui_unavailable" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    if (this.#challenges.size >= 128)
      return this.fail(
        { type: "challenge_capacity_exceeded" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const call = permissionDigest(input.call);
    if (call.isErr())
      return this.fail(call.error, input.agentName, wall, input.toolIdentity);
    const id = this.nextUniqueId(new Set(pending.map((item) => item.id)));
    if (id.isErr())
      return this.fail(id.error, input.agentName, wall, input.toolIdentity);
    const expires = this.safeExpiry(mono, 300000);
    if (expires.isErr())
      return this.fail(
        expires.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    this.#challenges.set(
      id.value,
      Object.freeze({
        project: input.project,
        session: input.session,
        agent: input.agentName,
        tool: input.toolIdentity,
        owner: reg.owner,
        revision: reg.revision,
        generation: input.registryGeneration,
        policy: this.#fingerprints.get(input.agentName) ?? "",
        call: call.value,
        callInput: input.call,
        expires: expires.value,
        requests: Object.freeze(pending),
      }),
    );
    this.record(
      "approval_requested",
      input.agentName,
      wall,
      input.toolIdentity,
      pending.length,
    );
    return ok({
      kind: "approval_required",
      challenge: id.value,
      requests: pending.map((item) => item.view),
    });
  }

  private preparePermit(
    input: Readonly<{
      project: string;
      session: string;
      agentName: string;
      toolIdentity: string;
      owner: string;
      revision: string;
      registryGeneration: string;
    }>,
    call: string,
    callInput: JsonValue,
    bindings: readonly string[],
    now: number,
    reserved = new Set<string>(),
  ): Result<
    {
      id: string;
      permit: Permit;
    },
    PermissionError
  > {
    this.purge(now);
    if (this.#permits.size >= 128)
      return err({ type: "permit_capacity_exceeded" });
    const id = this.nextUniqueId(reserved);
    if (id.isErr()) return err(id.error);
    const expires = this.safeExpiry(now, 30000);
    if (expires.isErr()) return err(expires.error);
    return ok({
      id: id.value,
      permit: {
        project: input.project,
        session: input.session,
        agent: input.agentName,
        tool: input.toolIdentity,
        owner: input.owner,
        revision: input.revision,
        generation: input.registryGeneration,
        policy: this.#fingerprints.get(input.agentName) ?? "",
        call,
        callInput,
        expires: expires.value,
        consumed: false,
        bindings: Object.freeze([...new Set(bindings)].sort()),
      },
    });
  }

  private issueFromDigest(
    input: CapturedCall,
    registration: PermissionRegistration,
    call: string,
    bindings: readonly string[],
    mono: number,
    wall: number,
  ): Result<PermissionOutcome, PermissionError> {
    const prepared = this.preparePermit(
      {
        project: input.project,
        session: input.session,
        agentName: input.agentName,
        toolIdentity: input.toolIdentity,
        owner: registration.owner,
        revision: registration.revision,
        registryGeneration: input.registryGeneration,
      },
      call,
      input.call,
      bindings,
      mono,
    );
    if (prepared.isErr())
      return this.fail(
        prepared.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    this.#permits.set(prepared.value.id, prepared.value.permit);
    this.record("permit_issued", input.agentName, wall, input.toolIdentity);
    return ok({ kind: "authorized", permit: prepared.value.id });
  }

  answerChallenge(
    input: PermissionChallengeConsumeInput,
    response: PermissionApprovalResponse,
  ): ResultAsync<PermissionOutcome, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const capturedInput = captureChallengeInput(input);
    if (capturedInput.isErr()) return failure(capturedInput.error);
    const capturedResponse = captureResponse(response);
    if (capturedResponse.isErr()) return failure(capturedResponse.error);
    return this.serial(() =>
      this.answerCaptured(capturedInput.value, capturedResponse.value),
    );
  }

  private async answerCaptured(
    input: CapturedChallengeInput,
    response: CapturedResponse,
  ): Promise<Result<PermissionOutcome, PermissionError>> {
    const now = this.sessionClocks();
    if (now.isErr()) return err(now.error);
    const mono = now.value.mono;
    const wall = now.value.wall;
    this.purge(mono);
    if (this.#closed)
      return this.fail({ type: "closed_session" }, "session", wall);
    const challenge = this.#challenges.get(input.challenge);
    if (!challenge)
      return this.fail(this.challengeState(input.challenge), "session", wall);
    if (challenge.expires <= mono)
      return this.fail(
        { type: "expired_challenge" },
        challenge.agent,
        wall,
        challenge.tool,
      );
    if (
      input.project !== challenge.project ||
      input.session !== challenge.session ||
      input.agentName !== challenge.agent ||
      input.toolIdentity !== challenge.tool ||
      input.registryGeneration !== challenge.generation
    )
      return this.fail(
        { type: "stale_challenge" },
        challenge.agent,
        wall,
        challenge.tool,
      );
    if (
      !validText(response.challenge, 256) ||
      response.challenge !== input.challenge ||
      response.choices.length !== challenge.requests.length
    )
      return this.fail(
        { type: "invalid_response" },
        challenge.agent,
        wall,
        challenge.tool,
      );
    const choices = new Map<string, CapturedChoice>();
    for (const choice of response.choices) {
      if (!validText(choice.requestId, 256))
        return this.fail(
          { type: "invalid_response" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      if (choice.decision !== "allow" && choice.decision !== "deny")
        return this.fail(
          { type: "invalid_response" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      if (choices.has(choice.requestId))
        return this.fail(
          { type: "invalid_response" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      choices.set(choice.requestId, choice);
    }
    if (
      choices.size !== challenge.requests.length ||
      challenge.requests.some((request) => !choices.has(request.id))
    )
      return this.fail(
        { type: "invalid_response" },
        challenge.agent,
        wall,
        challenge.tool,
      );
    for (const choice of choices.values()) {
      if (choice.decision === "deny") {
        if (choice.scope !== undefined || choice.expiresAt !== undefined)
          return this.fail(
            { type: "invalid_scope" },
            challenge.agent,
            wall,
            challenge.tool,
          );
        continue;
      }
      if (
        choice.scope !== "once" &&
        choice.scope !== "session" &&
        choice.scope !== "durable"
      )
        return this.fail(
          { type: "invalid_scope" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      if (choice.expiresAt !== undefined) {
        if (
          choice.scope !== "durable" ||
          !Number.isSafeInteger(choice.expiresAt) ||
          choice.expiresAt <= wall
        )
          return this.fail(
            { type: "invalid_scope" },
            challenge.agent,
            wall,
            challenge.tool,
          );
      }
    }
    const sessionGrantKeys: string[] = [];
    const durable: DurablePermissionGrantRecord[] = [];
    const reserved = new Set<string>();
    for (const request of challenge.requests) {
      const choice = choices.get(request.id);
      if (!choice)
        return this.fail(
          { type: "invalid_response" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      if (choice.decision !== "allow") continue;
      if (request.request.unresolved && choice.scope !== "once")
        return this.fail(
          { type: "invalid_scope" },
          challenge.agent,
          wall,
          challenge.tool,
        );
      if (choice.scope === "session")
        sessionGrantKeys.push(JSON.stringify(request.envelope));
      if (choice.scope === "durable") {
        const grantId = this.nextUniqueId(reserved);
        if (grantId.isErr())
          return this.fail(
            grantId.error,
            challenge.agent,
            wall,
            challenge.tool,
          );
        reserved.add(grantId.value);
        const record: DurablePermissionGrantRecord = {
          grantId: grantId.value,
          identity: request.envelope,
          scope: "durable",
          display: request.request.display,
          createdAt: wall,
          state: "active",
        };
        if (choice.expiresAt !== undefined)
          durable.push({ ...record, expiresAt: choice.expiresAt });
        else durable.push(record);
      }
    }
    const denied = response.choices.some(
      (choice) => choice.decision === "deny",
    );
    if (denied) {
      this.#challenges.delete(input.challenge);
      this.#challengeTombstones.add(input.challenge);
      this.record(
        "approval_answered",
        challenge.agent,
        wall,
        challenge.tool,
        challenge.requests.length,
        undefined,
        "rejected",
      );
      return ok({
        kind: "denied",
        requests: challenge.requests.map((request) =>
          this.deniedView(request.request),
        ),
      });
    }
    const permitBindings = new Set<string>();
    for (const request of challenge.requests) {
      const binding = requestBindingKey(request.request);
      if (binding.isErr())
        return this.fail(binding.error, challenge.agent, wall, challenge.tool);
      permitBindings.add(binding.value);
    }
    const prepared = this.preparePermit(
      {
        project: challenge.project,
        session: challenge.session,
        agentName: challenge.agent,
        toolIdentity: challenge.tool,
        owner: challenge.owner,
        revision: challenge.revision,
        registryGeneration: challenge.generation,
      },
      challenge.call,
      challenge.callInput,
      [...permitBindings],
      mono,
      new Set([
        ...reserved,
        ...challenge.requests.map((request) => request.id),
        input.challenge,
      ]),
    );
    if (prepared.isErr())
      return this.fail(prepared.error, challenge.agent, wall, challenge.tool);
    if (durable.length) {
      const saved = await this.repositoryCall(() =>
        this.#o.repository.saveMany(durable),
      );
      if (saved.isErr())
        return this.fail(saved.error, challenge.agent, wall, challenge.tool);
    }
    for (const key of sessionGrantKeys) this.#grants.set(key, "session");
    this.#permits.set(prepared.value.id, prepared.value.permit);
    this.#challenges.delete(input.challenge);
    this.#challengeTombstones.add(input.challenge);
    this.record(
      "approval_answered",
      challenge.agent,
      wall,
      challenge.tool,
      challenge.requests.length,
      undefined,
      "approved",
    );
    this.record("permit_issued", challenge.agent, wall, challenge.tool);
    return ok({ kind: "authorized", permit: prepared.value.id });
  }

  cancelChallenge(
    input: PermissionChallengeConsumeInput,
  ): ResultAsync<void, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const captured = captureChallengeInput(input);
    if (captured.isErr()) return failure(captured.error);
    return this.serial(() => this.cancelCaptured(captured.value));
  }

  private async cancelCaptured(
    input: CapturedChallengeInput,
  ): Promise<Result<void, PermissionError>> {
    const now = this.sessionClocks();
    if (now.isErr()) return err(now.error);
    const mono = now.value.mono;
    const wall = now.value.wall;
    this.purge(mono);
    if (this.#closed)
      return this.fail({ type: "closed_session" }, "session", wall);
    const current = this.#challenges.get(input.challenge);
    if (
      current &&
      (input.project !== current.project ||
        input.session !== current.session ||
        input.agentName !== current.agent ||
        input.toolIdentity !== current.tool ||
        input.registryGeneration !== current.generation)
    )
      return this.fail(
        { type: "stale_challenge" },
        current.agent,
        wall,
        current.tool,
      );
    if (!this.#challenges.delete(input.challenge))
      return this.fail(this.challengeState(input.challenge), "session", wall);
    this.#challengeTombstones.add(input.challenge);
    return ok(void 0);
  }

  consumePermit(
    input: PermissionPermitConsumeInput,
  ): ResultAsync<PermissionExecutionSnapshot, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const captured = capturePermit(input);
    if (captured.isErr()) return failure(captured.error);
    return this.serial(() => this.consumeCaptured(captured.value));
  }

  private async consumeCaptured(
    input: CapturedPermitInput,
  ): Promise<Result<PermissionExecutionSnapshot, PermissionError>> {
    const now = this.sessionClocks();
    if (now.isErr()) return err(now.error);
    const mono = now.value.mono;
    const wall = now.value.wall;
    this.purge(mono);
    if (this.#closed)
      return this.fail({ type: "closed_session" }, "session", wall);
    const permit = this.#permits.get(input.permit);
    if (!permit)
      return this.fail(this.permitState(input.permit), "session", wall);
    const generationMeta = readRegistryGenerationMeta(this.#registry);
    if (
      permit.project !== input.project ||
      permit.session !== input.session ||
      permit.agent !== input.agentName ||
      permit.tool !== input.toolIdentity ||
      permit.generation !== input.registryGeneration ||
      generationMeta.isErr() ||
      generationMeta.value.id !== permit.generation
    )
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    if (permit.expires <= mono)
      return this.fail(
        { type: "expired_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const inputDigest = permissionDigest(input.call);
    if (inputDigest.isErr() || inputDigest.value !== permit.call)
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const capturedDigest = permissionDigest(permit.callInput);
    if (capturedDigest.isErr() || capturedDigest.value !== permit.call)
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    if (this.#fingerprints.get(permit.agent) !== permit.policy)
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const registration = this.lookup(permit.tool);
    if (registration.isErr())
      return this.fail(
        registration.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const reg = registration.value;
    if (!reg || reg.owner !== permit.owner || reg.revision !== permit.revision)
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const resolved = Result.fromThrowable(
      () =>
        invokePermissionResolver(reg.resolver, permit.callInput, {
          toolIdentity: reg.toolIdentity,
          owner: reg.owner,
          revision: reg.revision,
        }),
      () => invalid(),
    )();
    if (resolved.isErr())
      return this.fail(
        resolved.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    if (resolved.value.isErr())
      return this.fail(
        resolved.value.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const normalized = normalizePermissionRequests(resolved.value.value);
    if (normalized.isErr())
      return this.fail(
        normalized.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    const bindingKeys = new Set<string>();
    for (const request of normalized.value) {
      const key = requestBindingKey(request);
      if (key.isErr())
        return this.fail(key.error, input.agentName, wall, input.toolIdentity);
      bindingKeys.add(key.value);
    }
    const expectedBindings = [...new Set(permit.bindings)].sort();
    const actualBindings = [...bindingKeys].sort();
    if (
      expectedBindings.length !== actualBindings.length ||
      expectedBindings.some((key, index) => key !== actualBindings[index])
    )
      return this.fail(
        { type: "stale_permit" },
        input.agentName,
        wall,
        input.toolIdentity,
      );
    // Return a fresh deep-frozen engine-owned snapshot. Adapters MUST execute
    // only this value — never the caller-owned consume input or a live proxy.
    const snapshot = cloneAndFreezeJson(permit.callInput);
    if (snapshot.isErr())
      return this.fail(
        snapshot.error,
        input.agentName,
        wall,
        input.toolIdentity,
      );
    permit.consumed = true;
    this.#permits.delete(input.permit);
    this.#permitTombstones.add(input.permit);
    this.record("permit_consumed", input.agentName, wall, input.toolIdentity);
    return ok(snapshot.value);
  }

  replaceRegistry(
    input: PermissionRegistryReplacement,
  ): ResultAsync<void, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const captured = objectSnapshot(input, ["registry"], ["registry"]);
    if (captured.isErr()) return failure(captured.error);
    const registry = actualRegistry(captured.value.get("registry")?.value);
    if (registry.isErr()) return failure(registry.error);
    const replacement: CapturedReplacement = Object.freeze({
      registry: registry.value,
    });
    return this.serial(() => this.replaceCaptured(replacement));
  }

  private async replaceCaptured(
    input: CapturedReplacement,
  ): Promise<Result<void, PermissionError>> {
    const now = this.sessionClocks();
    if (now.isErr()) return err(now.error);
    const mono = now.value.mono;
    const wall = now.value.wall;
    this.purge(mono);
    if (this.#closed)
      return this.fail({ type: "closed_session" }, "session", wall);
    // Non-virtual meta accessor — never read virtual `.id`.
    const nextMeta = readRegistryGenerationMeta(input.registry);
    if (nextMeta.isErr()) return this.fail(invalid(), "session", wall);
    // Reject current ID and any retired/previously observed generation ID.
    if (this.#observedGenerationIds.has(nextMeta.value.id))
      return this.fail(
        {
          type: "invalid_registry_transition",
          message: "registry generation already observed",
        },
        "session",
        wall,
      );
    // A fresh unseen generation can replace only while internally idle.
    if (
      this.#challenges.size ||
      [...this.#permits.values()].some(
        (permit) => !permit.consumed && permit.expires > mono,
      )
    )
      return this.fail({ type: "non_idle_replacement" }, "session", wall);
    // Record the ID before swap so a failed mid-transition cannot lose it.
    this.#observedGenerationIds.add(nextMeta.value.id);
    this.#registry = input.registry;
    this.record("registry_replaced", "session", wall);
    return ok(void 0);
  }

  close(): ResultAsync<void, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    return this.serial(async () => {
      const now = this.sessionClocks();
      if (now.isErr()) return err(now.error);
      // Advance both high-waters even when only wall is recorded.
      void now.value.mono;
      const wall = now.value.wall;
      if (this.#closed) return ok(void 0);
      this.#closed = true;
      this.#grants.clear();
      this.#challenges.clear();
      this.#permits.clear();
      this.record("session_closed", "session", wall);
      return ok(void 0);
    });
  }

  listDurableGrants(): ResultAsync<
    readonly PermissionGrantSummary[],
    PermissionError
  > {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    return this.serial(async () => {
      const now = this.sessionClocks();
      if (now.isErr()) return err(now.error);
      void now.value.mono;
      const wall = now.value.wall;
      if (this.#closed)
        return this.fail({ type: "closed_session" }, "session", wall);
      const result = await this.repositoryCall(() =>
        this.#o.repository.list(this.#o.project, wall),
      );
      if (result.isErr()) return this.fail(result.error, "session", wall);
      return ok(result.value);
    });
  }

  revokeDurableGrant(id: string): ResultAsync<void, PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const captured = Result.fromThrowable(
      () => id,
      () => invalid(),
    )().andThen((value) =>
      validText(value, 256) ? ok(value) : err(invalid()),
    );
    if (captured.isErr()) return failure(captured.error);
    return this.serial(async () => {
      const now = this.sessionClocks();
      if (now.isErr()) return err(now.error);
      void now.value.mono;
      const wall = now.value.wall;
      if (this.#closed)
        return this.fail({ type: "closed_session" }, "session", wall);
      const result = await this.repositoryCall(() =>
        this.#o.repository.revoke(this.#o.project, captured.value),
      );
      if (result.isErr()) return this.fail(result.error, "session", wall);
      this.record("grant_revoked", "session", wall);
      return ok(void 0);
    });
  }

  listAudit(): ResultAsync<readonly PermissionAuditEvent[], PermissionError> {
    const actual = validatePermissionSession(this);
    if (actual.isErr()) return failure(actual.error);
    const result = Result.fromThrowable(
      () => Object.freeze([...this.#auditLog]),
      () => invalid(),
    )();
    if (result.isErr()) return failure(result.error);
    return ResultAsync.fromSafePromise(Promise.resolve(result.value));
  }
}

// Capture originals before freeze so authoritative engine paths never perform
// virtual own/prototype method lookup on attacker-controlled surfaces.
const originalMethods = {
  authorizeCall: PermissionSession.prototype.authorizeCall,
  consumePermit: PermissionSession.prototype.consumePermit,
};

// Freeze constructor and prototype so static mutation and prototype method
// replacement cannot redirect construction or public method dispatch after
// module initialization. Activation remains available through the module-private
// `activateSessionInternal` closure bound in the static block before freeze.
Object.freeze(PermissionSession.prototype);
Object.freeze(PermissionSession);

/** Internal brand guard. This symbol is intentionally omitted from the root API. */
export function validatePermissionSession<T>(
  value: T,
): Result<PermissionSession, PermissionError> {
  if (!isObjectLike(value) || !sessionBrand.has(value)) return err(invalid());
  const session = sessionInstances.get(value);
  if (session === undefined) return err(invalid());
  return ok(session);
}

/**
 * Non-virtual authorization entry used by `beforeTool` and other engine paths.
 * Validates the brand, invokes the captured original `authorizeCall`, and wraps
 * so no throw or rejection escapes as an untyped failure.
 */
export function authorizePermissionSessionCall<T>(
  session: T,
  input: PermissionCallInput,
): ResultAsync<PermissionOutcome, PermissionError> {
  const actual = validatePermissionSession(session);
  if (actual.isErr()) return failure(actual.error);
  return ResultAsync.fromPromise(
    (async () => {
      const started = Result.fromThrowable(
        () => originalMethods.authorizeCall.call(actual.value, input),
        () => invalid(),
      )();
      if (started.isErr()) return err(started.error);
      return await started.value;
    })(),
    () => invalid(),
  ).andThen((result) => result);
}

/**
 * Non-virtual permit consumption entry for authoritative engine/adapter paths.
 * Public `session.consumePermit` on a frozen genuine instance is also safe
 * because the prototype method is immutable; this helper avoids virtual lookup.
 */
export function consumePermissionSessionPermit<T>(
  session: T,
  input: PermissionPermitConsumeInput,
): ResultAsync<PermissionExecutionSnapshot, PermissionError> {
  const actual = validatePermissionSession(session);
  if (actual.isErr()) return failure(actual.error);
  return ResultAsync.fromPromise(
    (async () => {
      const started = Result.fromThrowable(
        () => originalMethods.consumePermit.call(actual.value, input),
        () => invalid(),
      )();
      if (started.isErr()) return err(started.error);
      return await started.value;
    })(),
    () => invalid(),
  ).andThen((result) => result);
}

/** Internal activation path. It is not part of the package root API. */
export function activatePermissionSessionInternal<T>(
  input: T,
): ResultAsync<PermissionSession, PermissionError> {
  return activateSessionInternal(input);
}

/** Test-only activation path for injected repositories, clocks, and IDs. */
export function activatePermissionSessionForTesting<T>(
  input: T,
): ResultAsync<PermissionSession, PermissionError> {
  return activatePermissionSessionInternal(input);
}
