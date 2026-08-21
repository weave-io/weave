import { Err, err, Ok, ok, Result } from "neverthrow";
import {
  cloneAndFreezeJson,
  permissionDigest,
  sanitizePermissionDisplay,
  utf8Bytes,
} from "./canonical.js";
import type {
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

type ObjectLike<T> = T & object;
type SnapshotFields = ReadonlyMap<string, PropertyDescriptor>;
type MutableSafeRegistration = {
  toolIdentity: string;
  owner: string;
  revision: string;
  summary: string;
  details?: string;
  resolver: PermissionResolver;
};
type MutableDisplayInput = { summary: string; details?: string };
type RegistryGenerationState = {
  readonly generation: PermissionRegistryGeneration;
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
    if (id.length === 0 || hasLoneSurrogate(id))
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
function hasLoneSurrogate(value: string): boolean {
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
}

type SafeRegistration = Readonly<PermissionRegistration>;
type Metadata = Omit<PermissionRegistration, "resolver">;

const isObjectLike = <T>(value: T): value is ObjectLike<T> =>
  value !== null && value !== undefined && Object(value) === value;

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

const isCallable = <T>(value: T): value is T & PermissionResolver => {
  const source = Result.fromThrowable(
    () => Function.prototype.toString.call(value),
    () => "",
  )();
  return source.isOk() && !source.value.trimStart().startsWith("class ");
};

const parseText = <T>(
  value: T,
  max: number,
  name: string,
): Result<string, PermissionError> => {
  if (primitiveTag(value) !== "[object String]")
    return err(invalid(`${name} must be a nonempty string`));
  const text = String(value);
  if (text.length === 0 || hasLoneSurrogate(text))
    return err(invalid(`${name} must be a nonempty string`));
  if (utf8Bytes(text, max).isErr())
    return err(invalid(`${name} exceeds ${max} UTF-8 bytes`));
  return ok(text);
};

function readOwnData<T>(
  value: T,
  allowed: readonly string[],
): Result<SnapshotFields, PermissionError> {
  return Result.fromThrowable(
    () => {
      if (!isObjectLike(value))
        return err(invalid("registration must be an object"));
      if (Object.getPrototypeOf(value) !== Object.prototype)
        return err(invalid("registration has an unsafe prototype"));
      const allowedSet = new Set(allowed);
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of Reflect.ownKeys(value)) {
        if (Object.prototype.toString.call(key) !== "[object String]")
          return err(invalid("registration has unexpected metadata"));
        const text = String(key);
        if (!allowedSet.has(text))
          return err(invalid("registration has unexpected metadata"));
        const descriptor = Object.getOwnPropertyDescriptor(value, text);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          return err(
            invalid("registration contains an accessor or hidden field"),
          );
        descriptors.set(text, descriptor);
      }
      return ok(descriptors);
    },
    () => invalid("invalid registration"),
  )().andThen((result) => result);
}

function validateRegistrationUnsafe<T>(
  value: T,
): Result<SafeRegistration, PermissionError> {
  const fields = readOwnData(value, keys);
  if (fields.isErr()) return err(fields.error);
  const requiredKeys = keys.filter((key) => key !== "details");
  for (const key of requiredKeys) {
    if (!fields.value.has(key))
      return err(invalid("registration is missing required fields"));
  }
  const resolverValue = fields.value.get("resolver")?.value;
  if (resolverValue === undefined || !isCallable(resolverValue))
    return err(invalid("resolver must be a function"));
  const toolIdentity = parseText(
    fields.value.get("toolIdentity")?.value,
    256,
    "tool identity",
  );
  const owner = parseText(fields.value.get("owner")?.value, 128, "owner");
  const revision = parseText(
    fields.value.get("revision")?.value,
    64,
    "semantic revision",
  );
  if (toolIdentity.isErr() || owner.isErr() || revision.isErr())
    return err(
      invalid("registration identity fields must be nonempty strings"),
    );

  const displayInput: MutableDisplayInput = {
    summary: toolIdentity.value,
  };
  const summary = sanitizePermissionDisplay({
    summary: fields.value.get("summary")?.value,
  });
  if (summary.isErr()) return err(invalid("invalid registration display"));
  displayInput.summary = summary.value.summary;
  const detailsDescriptor = fields.value.get("details");
  if (detailsDescriptor !== undefined) {
    const details = sanitizePermissionDisplay({
      summary: displayInput.summary,
      details: detailsDescriptor.value,
    });
    if (details.isErr()) return err(invalid("invalid registration display"));
    if (details.value.details !== undefined)
      displayInput.details = details.value.details;
  }
  const safe: MutableSafeRegistration = {
    toolIdentity: toolIdentity.value,
    owner: owner.value,
    revision: revision.value,
    summary: displayInput.summary,
    resolver: resolverValue,
  };
  if (displayInput.details !== undefined) safe.details = displayInput.details;
  return ok(Object.freeze(safe));
}

function validateRegistration<T>(
  value: T,
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

function requireGenerationState<T>(
  value: T,
): Result<RegistryGenerationState, PermissionError> {
  if (!isObjectLike(value) || !generationBrand.has(value))
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
        return ok(void 0);
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
        generation: this,
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
export function lookupRegistryRegistration<T>(
  generation: T,
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
export function readRegistryInventory<T>(
  generation: T,
): Result<readonly PermissionRegistrationMetadata[], PermissionError> {
  return requireGenerationState(generation).map(inventoryFromState);
}

/**
 * Internal non-virtual generation id/identity for authorization, permit
 * revalidation, replacement, and coverage verification.
 */
export function readRegistryGenerationMeta<T>(
  generation: T,
): Result<{ readonly identity: string; readonly id: string }, PermissionError> {
  return requireGenerationState(generation).map((state) =>
    Object.freeze({ identity: state.identity, id: state.id }),
  );
}

/** Internal brand guard used by permission and execution-lifecycle code. */
export function validatePermissionRegistryGeneration<T>(
  value: T,
): Result<PermissionRegistryGeneration, PermissionError> {
  const state = requireGenerationState(value);
  if (state.isErr()) return err(state.error);
  if (!isObjectLike(value))
    return err(invalidRegistry("invalid registry generation"));
  return ok(state.value.generation);
}

const contextKeys = ["toolIdentity", "owner", "revision"] as const;
function safeContext<T>(
  value: T,
): Result<PermissionRegistrationContext, PermissionError> {
  return Result.fromThrowable(
    () => {
      const fields = readOwnData(value, contextKeys);
      if (fields.isErr()) return err(invalid("invalid resolver context"));
      const toolIdentity = parseText(
        fields.value.get("toolIdentity")?.value,
        256,
        "tool identity",
      );
      const owner = parseText(fields.value.get("owner")?.value, 128, "owner");
      const revision = parseText(
        fields.value.get("revision")?.value,
        64,
        "revision",
      );
      if (toolIdentity.isErr() || owner.isErr() || revision.isErr())
        return err(invalid("invalid resolver context"));
      return ok(
        Object.freeze({
          toolIdentity: toolIdentity.value,
          owner: owner.value,
          revision: revision.value,
        }),
      );
    },
    () => invalid("invalid resolver context"),
  )().andThen((result) => result);
}

export function invokePermissionResolver<T, U, V>(
  resolver: T,
  call: U,
  context: V,
): Result<readonly PermissionRequest[], PermissionError> {
  if (!isCallable(resolver))
    return err({
      type: "invalid_output",
      message: "permission resolver is not callable",
    });
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
