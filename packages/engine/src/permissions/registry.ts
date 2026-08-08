import { Err, err, Ok, ok, Result } from "neverthrow";
import {
  cloneAndFreezeJson,
  permissionDigest,
  sanitizePermissionDisplay,
  utf8Bytes,
} from "./canonical.js";
import type {
  JsonValue,
  PermissionError,
  PermissionRegistration,
  PermissionRegistrationContext,
  PermissionRegistrationMetadata,
  PermissionRequest,
  PermissionResolver,
} from "./types.js";

const invalid = (message: string): PermissionError => ({
  type: "invalid_registration",
  message,
});
const invalidRegistry = (message: string): PermissionError => ({
  type: "invalid_registry",
  message,
});
const transition = (message: string): PermissionError => ({
  type: "invalid_registry_transition",
  message,
});
const keys = [
  "toolIdentity",
  "owner",
  "revision",
  "summary",
  "details",
  "resolver",
] as const;

/**
 * Module-private construction token. Never assigned to a class, static, or
 * public property — only closed over by the module-private factory so JS
 * monkey patches cannot capture or supply it.
 */
const generationToken = Symbol("PermissionRegistryGeneration");
const generationBrand = new WeakSet<object>();

type RegistryGenerationState = {
  readonly registrations: ReadonlyMap<string, SafeRegistration>;
  readonly identity: string;
  readonly id: string;
};

/**
 * Non-virtual generation state for authoritative engine paths. Public
 * lookup/get/inventory remain informational; session authorization, permit
 * revalidation, replacement, and coverage verification MUST read through the
 * module-private accessors backed by this map (and matching #private fields).
 */
const generationState = new WeakMap<object, RegistryGenerationState>();

/** Opaque generation-ID source. Production uses `crypto.randomUUID`. */
type GenerationIdSource = () => string;

/**
 * Bound on collision retries while minting a generation ID. Crypto failures
 * fail immediately; only duplicate IDs consume retry budget.
 */
const MAX_GENERATION_ID_ATTEMPTS = 16;

/**
 * Process-lifetime uniqueness set for registry generation IDs.
 *
 * Tradeoff: every successfully issued ID is retained for the life of the
 * controller process and is never reused. This keeps generations unique while
 * any session that observed a prior generation may still exist. The set is
 * bounded only operationally by the number of successful seals in the process
 * (seals are rare controller events, not a per-call hot path). A sliding
 * eviction window is intentionally rejected because an evicted ID could be
 * reissued while a live session still binds the old generation.
 */
const issuedGenerationIds = new Set<string>();

const productionIdSource: GenerationIdSource = () => crypto.randomUUID();

/**
 * Test-only ID-source seam. Held in a module-private WeakMap keyed by builder
 * instance so tests never monkey-patch the production class surface.
 */
const builderIdSources = new WeakMap<object, GenerationIdSource>();

/**
 * Mint a controller-process-unique opaque generation ID.
 *
 * Check-and-reserve is a single synchronous critical section so concurrent
 * `seal()` calls in one JS process cannot both observe the same free ID.
 * The ID is reserved before any generation object is constructed; a later
 * construction failure does not release it for reuse.
 */
function reserveGenerationId(
  source: GenerationIdSource,
): Result<string, PermissionError> {
  for (let attempt = 0; attempt < MAX_GENERATION_ID_ATTEMPTS; attempt += 1) {
    const generated = Result.fromThrowable(source, () =>
      invalidRegistry("unable to create registry generation"),
    )();
    if (generated.isErr()) return err(generated.error);
    const id = generated.value;
    if (typeof id !== "string" || id.length === 0 || hasLoneSurrogate(id))
      return err(invalidRegistry("unable to create registry generation"));
    if (issuedGenerationIds.has(id)) continue;
    issuedGenerationIds.add(id);
    return ok(id);
  }
  return err(invalidRegistry("unable to create registry generation"));
}

const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
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

type SafeRegistration = Readonly<PermissionRegistration>;
type Metadata = Omit<PermissionRegistration, "resolver">;

function readOwnData(
  value: object,
  allowed: readonly string[],
): Result<Record<string, PropertyDescriptor>, PermissionError> {
  const allowedSet = new Set(allowed);
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedSet.has(key))
      return err(invalid("registration has unexpected metadata"));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return err(invalid("registration contains an accessor or hidden field"));
    descriptors[key] = descriptor;
  }
  return ok(descriptors);
}

function validateRegistrationUnsafe(
  value: unknown,
): Result<SafeRegistration, PermissionError> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return err(invalid("registration must be an object"));
  const object = value as object;
  if (Object.getPrototypeOf(object) !== Object.prototype)
    return err(invalid("registration has an unsafe prototype"));
  const fields = readOwnData(object, keys);
  if (fields.isErr()) return err(fields.error);
  const requiredKeys = keys.filter((key) => key !== "details");
  if (
    requiredKeys.some((key) => !fields.value[key]) ||
    fields.value.resolver?.value === undefined
  )
    return err(invalid("registration is missing required fields"));
  const resolver = fields.value.resolver.value;
  if (typeof resolver !== "function")
    return err(invalid("resolver must be a function"));
  const toolIdentity = fields.value.toolIdentity.value;
  const owner = fields.value.owner.value;
  const revision = fields.value.revision.value;
  if (
    typeof toolIdentity !== "string" ||
    typeof owner !== "string" ||
    typeof revision !== "string" ||
    toolIdentity.length === 0 ||
    owner.length === 0 ||
    revision.length === 0
  )
    return err(
      invalid("registration identity fields must be nonempty strings"),
    );
  const identityFields: readonly [string, number, string][] = [
    [toolIdentity, 256, "tool identity"],
    [owner, 128, "owner"],
    [revision, 64, "semantic revision"],
  ];
  for (const [field, max, name] of identityFields) {
    if (hasLoneSurrogate(field))
      return err(invalid(`${name} contains a lone surrogate`));
    if (utf8Bytes(field, max).isErr())
      return err(invalid(`${name} exceeds ${max} UTF-8 bytes`));
  }
  const display = sanitizePermissionDisplay({
    summary: fields.value.summary?.value,
    ...(fields.value.details ? { details: fields.value.details.value } : {}),
  });
  if (display.isErr()) return err(invalid("invalid registration display"));
  return ok(
    Object.freeze({
      toolIdentity,
      owner,
      revision,
      summary: display.value.summary,
      ...(display.value.details === undefined
        ? {}
        : { details: display.value.details }),
      resolver: resolver as PermissionResolver,
    }),
  );
}

function validateRegistration(
  value: unknown,
): Result<SafeRegistration, PermissionError> {
  return Result.fromThrowable(
    () => validateRegistrationUnsafe(value),
    () => invalid("invalid registration"),
  )().andThen((result) => result);
}

function freezeMetadata(
  registration: SafeRegistration,
): PermissionRegistrationMetadata {
  const { resolver: _resolver, ...metadata } = registration;
  return Object.freeze(metadata);
}

function inventoryFromState(
  state: RegistryGenerationState,
): readonly PermissionRegistrationMetadata[] {
  const result = [...state.registrations.values()]
    .sort((a, b) => compareCodeUnits(a.toolIdentity, b.toolIdentity))
    .map(freezeMetadata);
  return Object.freeze(result);
}

function requireGenerationState(
  value: object,
): Result<RegistryGenerationState, PermissionError> {
  if (!generationBrand.has(value))
    return err(invalidRegistry("invalid registry generation"));
  const state = generationState.get(value);
  if (!state) return err(invalidRegistry("invalid registry generation"));
  return ok(state);
}

/**
 * Module-private factory bound once from the class static block. Never
 * exported and never installed on a public/static property.
 */
let createPermissionRegistryGeneration!: (
  source: readonly SafeRegistration[],
  identity: string,
  id: string,
) => PermissionRegistryGeneration;

function sealPermissionRegistryGeneration(
  source: readonly SafeRegistration[],
  identity: string,
  id: string,
): Result<PermissionRegistryGeneration, PermissionError> {
  return Result.fromThrowable(
    () => createPermissionRegistryGeneration(source, identity, id),
    () => invalidRegistry("invalid registry"),
  )();
}

/** Injectable dependencies for the non-root testing builder factory. */
export type PermissionRegistryBuilderTestingDeps = {
  readonly idSource: GenerationIdSource;
};

export class PermissionRegistryBuilder {
  #registrations = new Map<string, SafeRegistration>();
  #sealed = false;
  #poisoned = false;

  register(
    registration: PermissionRegistration,
  ): Result<void, PermissionError> {
    return Result.fromThrowable(
      () => {
        if (this.#sealed) return err(transition("builder is sealed"));
        if (this.#poisoned)
          return err({
            type: "invalid_registry" as const,
            message: "builder has been poisoned",
          });
        const checked = validateRegistration(registration);
        if (checked.isErr()) return err(checked.error);
        if (this.#registrations.has(checked.value.toolIdentity)) {
          this.#poisoned = true;
          return err({
            type: "duplicate_registration" as const,
            toolIdentity: checked.value.toolIdentity,
            message: "tool is already registered",
          });
        }
        this.#registrations.set(checked.value.toolIdentity, checked.value);
        return ok(undefined);
      },
      () => invalid("invalid registration"),
    )().andThen((result) => result);
  }

  seal(): Result<PermissionRegistryGeneration, PermissionError> {
    return Result.fromThrowable(
      () => {
        if (this.#sealed) return err(transition("builder is already sealed"));
        this.#sealed = true;
        if (this.#poisoned)
          return err({
            type: "invalid_registry" as const,
            message: "duplicate registration",
          });
        const sorted = [...this.#registrations.values()].sort((a, b) =>
          compareCodeUnits(a.toolIdentity, b.toolIdentity),
        );
        const metadata = sorted.map(
          ({ resolver: _resolver, ...safe }): Metadata => safe,
        );
        const digest = permissionDigest(metadata);
        if (digest.isErr())
          return err({
            type: "invalid_registry" as const,
            message: "unable to create registry identity",
          });
        const source = builderIdSources.get(this) ?? productionIdSource;
        const id = reserveGenerationId(source);
        if (id.isErr()) return err(id.error);
        return sealPermissionRegistryGeneration(sorted, digest.value, id.value);
      },
      () => ({
        type: "invalid_registry" as const,
        message: "invalid registry",
      }),
    )().andThen((result) => result);
  }
}

/**
 * Test-only builder factory with an injectable generation-ID source.
 * Intentionally omitted from the package root and permissions barrel so
 * production callers cannot inject generation IDs or observe issued IDs.
 * The seam is module-internal (WeakMap) and does not monkey-patch the class.
 */
export function createPermissionRegistryBuilderForTesting(
  deps: PermissionRegistryBuilderTestingDeps,
): PermissionRegistryBuilder {
  const builder = new PermissionRegistryBuilder();
  builderIdSources.set(builder, deps.idSource);
  return builder;
}

export class PermissionRegistryGeneration {
  readonly identity: string;
  readonly id: string;
  #registrations: ReadonlyMap<string, SafeRegistration>;

  static {
    createPermissionRegistryGeneration = (source, identity, id) =>
      new PermissionRegistryGeneration(generationToken, source, identity, id);
  }

  private constructor(
    token: symbol,
    source: readonly SafeRegistration[],
    identity: string,
    id: string,
  ) {
    if (token !== generationToken)
      throw new TypeError("invalid registry construction token");
    const registrations = new Map(
      source.map((registration) => [registration.toolIdentity, registration]),
    );
    this.#registrations = registrations;
    generationBrand.add(this);
    generationState.set(
      this,
      Object.freeze({
        registrations,
        identity,
        id,
      }),
    );
    this.identity = identity;
    this.id = id;
    Object.freeze(this);
  }

  /**
   * Informational registration lookup. Authoritative engine paths MUST use
   * {@link lookupRegistryRegistration} instead of this virtual method.
   */
  lookup(toolIdentity: string): PermissionRegistration | undefined {
    return this.#registrations.get(toolIdentity);
  }

  /**
   * Informational alias of {@link lookup}. Authoritative engine paths MUST
   * use {@link lookupRegistryRegistration}.
   */
  get(toolIdentity: string): PermissionRegistration | undefined {
    return this.lookup(toolIdentity);
  }

  /**
   * Informational frozen metadata inventory. Authoritative engine paths MUST
   * use {@link readRegistryInventory}.
   */
  inventory(): readonly PermissionRegistrationMetadata[] {
    const state = generationState.get(this);
    if (!state) return Object.freeze([]);
    return inventoryFromState(state);
  }
}

// Freeze constructor and prototype so static token capture, prototype method
// replacement, and similar monkey patches cannot redirect construction or
// public method dispatch after module initialization.
Object.freeze(PermissionRegistryGeneration.prototype);
Object.freeze(PermissionRegistryGeneration);
Object.freeze(PermissionRegistryBuilder.prototype);
Object.freeze(PermissionRegistryBuilder);

/**
 * Internal non-virtual registration lookup for authorization and permit
 * revalidation. Backed by module-private WeakMap state, not instance methods.
 */
export function lookupRegistryRegistration(
  generation: PermissionRegistryGeneration,
  toolIdentity: string,
): Result<PermissionRegistration | undefined, PermissionError> {
  return requireGenerationState(generation).map((state) =>
    state.registrations.get(toolIdentity),
  );
}

/**
 * Internal non-virtual inventory snapshot for coverage verification and other
 * authoritative engine paths.
 */
export function readRegistryInventory(
  generation: PermissionRegistryGeneration,
): Result<readonly PermissionRegistrationMetadata[], PermissionError> {
  return requireGenerationState(generation).map(inventoryFromState);
}

/**
 * Internal non-virtual generation id/identity for authorization, permit
 * revalidation, replacement, and coverage verification.
 */
export function readRegistryGenerationMeta(
  generation: PermissionRegistryGeneration,
): Result<{ readonly identity: string; readonly id: string }, PermissionError> {
  return requireGenerationState(generation).map((state) =>
    Object.freeze({ identity: state.identity, id: state.id }),
  );
}

/** Internal brand guard used by permission and execution-lifecycle code. */
export function validatePermissionRegistryGeneration(
  value: unknown,
): Result<PermissionRegistryGeneration, PermissionError> {
  if (typeof value !== "object" || value === null)
    return err(invalidRegistry("invalid registry generation"));
  const state = requireGenerationState(value);
  if (state.isErr()) return err(state.error);
  return ok(value as PermissionRegistryGeneration);
}

const contextKeys = ["toolIdentity", "owner", "revision"] as const;
function safeContext(
  value: PermissionRegistrationContext,
): Result<PermissionRegistrationContext, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return err(invalid("invalid resolver context"));
      const fields = readOwnData(value as object, contextKeys);
      if (fields.isErr() || contextKeys.some((key) => !fields.value[key]))
        return err(invalid("invalid resolver context"));
      const values: Record<string, string> = Object.create(null);
      for (const key of contextKeys) {
        let maxBytes = 256;
        if (key === "revision") maxBytes = 64;
        if (key === "owner") maxBytes = 128;
        const field = fields.value[key].value;
        if (
          typeof field !== "string" ||
          hasLoneSurrogate(field) ||
          utf8Bytes(field, maxBytes).isErr()
        )
          return err(invalid("invalid resolver context"));
        values[key] = field;
      }
      return ok(
        Object.freeze(values) as unknown as PermissionRegistrationContext,
      );
    },
    () => invalid("invalid resolver context"),
  )().andThen((result) => result);
}

export function invokePermissionResolver(
  resolver: PermissionResolver,
  call: JsonValue,
  context: PermissionRegistrationContext,
): Result<readonly PermissionRequest[], PermissionError> {
  const safeCall = cloneAndFreezeJson(call);
  if (safeCall.isErr()) return err(safeCall.error);
  const checkedContext = safeContext(context);
  if (checkedContext.isErr()) return err(checkedContext.error);
  const result = Result.fromThrowable(
    () => resolver({ call: safeCall.value, context: checkedContext.value }),
    (): PermissionError => ({
      type: "resolver_threw",
      message: "permission resolver threw",
    }),
  )();
  if (result.isErr()) return err(result.error);
  const inspected = Result.fromThrowable(
    () => {
      const returned = result.value;
      if (returned instanceof Err)
        return err({
          type: "resolver_returned_error" as const,
          message: "permission resolver returned an error",
        });
      if (!(returned instanceof Ok))
        return err({
          type: "invalid_output" as const,
          message: "permission resolver returned a non-Result",
        });
      return ok(returned.value);
    },
    () => ({
      type: "invalid_output" as const,
      message: "permission resolver returned an invalid Result",
    }),
  )().andThen((result) => result);
  if (inspected.isErr()) return err(inspected.error);
  return inspected;
}

export const resolvePermission = invokePermissionResolver;
