/**
 * Pi OpenAI Codex subscription fast mode: the registration seam.
 *
 * The mapping only exists once Pi routes its `openai-codex` traffic through
 * Weave's wrapped provider, and that single act — read the host version,
 * import pi-ai's codex provider, build a native provider, wrap it, hand it to
 * `ExtensionAPI.registerProvider` — is the one part of the feature that
 * touches the host. This module is that act and nothing else, so the wiring in
 * `extension-impl.ts` stays a call site and every probe can be substituted in
 * a test without a harness.
 *
 * The gate is the one `docs/specs/fast-provider-acceleration-contract.md`
 * resolved as OD-4: keep the declared peer floor, and register only when the
 * host's own public `VERSION` export is at least
 * {@link CODEX_FAST_MINIMUM_HOST_VERSION}, the provider subpath is proven to
 * be the host's own copy of that exact module, the provider subpath import
 * resolves with the expected factory, the factory yields a provider whose id
 * is exactly the Codex provider id, the wrapper accepts it, and
 * `registerProvider` is really callable. `options.fetch` on the codex SSE path
 * — the wrapper's only seam for header authority — first appears in pi-ai
 * 0.83.0, so an older host could set a priority body it can never route, and
 * that is precisely what this gate refuses to allow.
 *
 * The version alone is not that proof. A supported host package can sit next
 * to an older nested pi-ai copy, and a bare specifier's provenance says
 * nothing about a subpath import: `@earendil-works/pi-ai/providers/openai-codex`
 * resolves to its own file. This gate therefore demands positive provenance
 * for that exact subpath — redirected to the host copy, or already it — and
 * refuses registration for every other answer, including an unknown one.
 *
 * Deliberate properties:
 *
 * - **Fail closed, one bounded token.** Every failure resolves to a
 *   {@link CodexFastRegistrationDegradation}: a closed enum, never a message,
 *   a specifier, a stack, a URL, or a host diagnostic. The caller can log or
 *   journal the token as-is. Nothing was registered, so the host keeps its
 *   native provider and the capability reports the hook seam's `unsupported`.
 * - **No state.** Whether registration already happened is the caller's
 *   lifecycle question, not this module's. Keeping the answer here would put
 *   process-lifetime state in a module a test imports.
 * - **A freshly created native provider, always.** The provider handed to the
 *   host is built from the factory on every call, so a re-registration can
 *   never wrap something this adapter already wrapped.
 * - **Nothing throws.** The import, the factory call, the wrap, and the host
 *   call all run inside `neverthrow` boundaries.
 */

import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type {
  PiHostModuleProvenance,
  PiHostModuleProvenanceReason,
} from "../host-module-loader.js";
import type {
  CodexFastAttemptSink,
  CodexFastIntentPort,
  CodexWrappableProvider,
} from "./provider.js";
import { wrapCodexProviderForFast } from "./provider.js";
import { CODEX_PROVIDER_ID } from "./routing.js";

/**
 * The exact module specifier the seam imports. It is a literal at the import
 * site as well, because the bundler must be able to see it to keep the peer
 * dependency external instead of inlining a second copy of pi-ai.
 */
export const CODEX_PROVIDER_MODULE_SPECIFIER =
  "@earendil-works/pi-ai/providers/openai-codex";

/** The factory the provider subpath must expose. */
export const CODEX_PROVIDER_FACTORY_NAME = "openaiCodexProvider";

/**
 * The first host version whose codex SSE path honors `options.fetch`. Below
 * it the wrapper could set the body tier but never write the routing pair, so
 * the mapping must not run at all.
 */
export const CODEX_FAST_MINIMUM_HOST_VERSION = "0.83.0";

const MINIMUM_HOST_VERSION_PARTS = Object.freeze([0, 83, 0] as const);

/** Longest string this module will even attempt to read as a version. */
const MAX_HOST_VERSION_LENGTH = 64;

/** Exactly the shape the host's public `VERSION` export has. */
const HOST_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Why registration did not happen, in the order the gate evaluates. Every
 * token is safe to log, journal, and render.
 */
export const CODEX_FAST_REGISTRATION_DEGRADATIONS = Object.freeze([
  "host-version-unsupported",
  "provider-module-unproven",
  "register-provider-unavailable",
  "provider-module-unavailable",
  "provider-factory-unavailable",
  "provider-identity-unexpected",
  "provider-not-wrappable",
  "register-provider-failed",
] as const);

export type CodexFastRegistrationDegradation =
  (typeof CODEX_FAST_REGISTRATION_DEGRADATIONS)[number];

export type CodexFastRegistrationFailure = {
  readonly reason: CodexFastRegistrationDegradation;
  /**
   * Present only for `provider-module-unproven`: the bounded token naming
   * why the subpath's provenance is not host-proven. A closed enum, never a
   * path, a specifier, or a loader diagnostic. The value is re-checked
   * against that enum here, so a probe that answers with an arbitrary string
   * cannot put its own text on this field.
   */
  readonly provenance?: PiHostModuleProvenanceReason;
};

/** What a successful registration reports: a token, not the provider. */
export type CodexFastRegistrationOutcome = {
  readonly providerId: typeof CODEX_PROVIDER_ID;
};

/**
 * The host-facing probes, injected so a test never needs a real Pi process,
 * a real host version, or the real pi-ai package.
 */
export type CodexFastRegistrationInput<TVersion, TModule, TRegistrar> = {
  /** The host's public `VERSION` export, read at the adapter boundary. */
  readonly readHostVersion: () => TVersion;
  /** Dynamic import of {@link CODEX_PROVIDER_MODULE_SPECIFIER}. */
  readonly importProviderModule: () => Promise<TModule>;
  /**
   * Provenance of {@link CODEX_PROVIDER_MODULE_SPECIFIER} itself — the exact
   * module the import above will load — as established by the host-module
   * proof. A proof about the bare `@earendil-works/pi-ai` package is not an
   * answer to this question and must never be passed here.
   */
  readonly readProviderModuleProvenance: () => PiHostModuleProvenance;
  /**
   * `ExtensionAPI.registerProvider`, already bound to the host object, or
   * absent when this host exposes no such surface. The generic keeps the
   * host's own callable type at this boundary; the parser below decides
   * whether it is usable before registration.
   */
  readonly registerProvider: TRegistrar | undefined;
  /** Read per stream call by the wrapper; never captured as a value. */
  readonly intentPort: CodexFastIntentPort;
  /** Where the wrapper reports one call's sanitized states. */
  readonly attemptSink: CodexFastAttemptSink;
};

function failure(
  reason: CodexFastRegistrationDegradation,
): CodexFastRegistrationFailure {
  return { reason };
}

function unprovenModuleFailure(
  provenance: PiHostModuleProvenanceReason,
): CodexFastRegistrationFailure {
  return { reason: "provider-module-unproven", provenance };
}

/** Values supplied by a host probe stay opaque until this module parses them. */
const HOST_INPUT_BOUNDARY = z.unknown();
type HostInput = z.input<typeof HOST_INPUT_BOUNDARY>;

/** A host object accepted only after its own descriptors pass inspection. */
interface HostObjectReference {
  readonly hostObjectMarker?: never;
}

type HostCallable = (...args: never[]) => HostInput;
type ProviderFactory = () => HostInput;
type HostRegistrar = (provider: CodexWrappableProvider) => void;

type HostObjectParseFailure = "host-object-unavailable";

/** Return a callable without replacing the host's original function. */
function isHostCallable(value: HostInput): value is HostCallable {
  return Result.fromThrowable(
    () => value instanceof Function,
    (): boolean => false,
  )().unwrapOr(false);
}

/** Reject arrays and callables before any member descriptor is inspected. */
const HOST_OBJECT_REFERENCE_SCHEMA = z.custom<HostObjectReference>(
  (value: HostInput): boolean => {
    const reference = Result.fromThrowable(
      (): boolean =>
        value !== null &&
        Object(value) === value &&
        Array.isArray(value) === false,
      (): boolean => false,
    )();
    return reference.isOk() && reference.value && !isHostCallable(value);
  },
);

function parseHostObject<TValue>(
  value: TValue,
): Result<HostObjectReference, HostObjectParseFailure> {
  const parsed = Result.fromThrowable(
    () => HOST_OBJECT_REFERENCE_SCHEMA.safeParse(value),
    (): HostObjectParseFailure => "host-object-unavailable",
  )();
  if (parsed.isErr() || !parsed.value.success) {
    return err("host-object-unavailable");
  }
  return ok(parsed.value.data);
}

/** Read only own enumerable data; missing, inherited, and accessor fields fail. */
function readDataProperty(
  source: HostObjectReference,
  key: string,
): HostInput | undefined {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(source, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr()) return;
  const found = descriptor.value;
  if (found === undefined || !("value" in found) || found.enumerable !== true) {
    return;
  }
  return found.value;
}

/** Every reason that may cross the host-module provenance boundary. */
const PROVENANCE_REASON_SCHEMA = z.enum([
  "host-root-unproven",
  "host-package-mismatch",
  "no-local-copy",
  "already-host",
  "local-path-unsafe",
  "plugin-unavailable",
  "redirect-registered",
  "redirect-disabled",
  "outcome-missing",
  "specifier-unknown",
]);
const PROVENANCE_KIND_SCHEMA = z.enum(["host", "unproven"]);
const PROVENANCE_OUTCOME_SCHEMA = z.enum(["redirected", "already-host"]);

/** Keep the failure token inside the loader's closed enum. */
function isProvenanceReason<TValue>(
  value: TValue,
): value is TValue & PiHostModuleProvenanceReason {
  const parsed = Result.fromThrowable(
    () => PROVENANCE_REASON_SCHEMA.safeParse(value),
    (): boolean => false,
  )();
  return parsed.isOk() && parsed.value.success;
}

/** The one token used for every malformed or absent provenance answer. */
const PROVENANCE_REASON_FALLBACK: PiHostModuleProvenanceReason =
  "outcome-missing";
const UNPROVEN_PROVENANCE: PiHostModuleProvenance = Object.freeze({
  kind: "unproven",
  reason: PROVENANCE_REASON_FALLBACK,
});

/**
 * Narrow whatever the probe returned to the closed provenance shape.
 *
 * Only own enumerable data properties count. A callable, an array, an
 * accessor, an inherited field, a throwing proxy, or an unknown token becomes
 * the local fallback, so no caller-controlled text reaches a failure value.
 */
function narrowProviderModuleProvenance<TProvenance>(
  read: () => TProvenance,
): PiHostModuleProvenance {
  const narrowed = Result.fromThrowable(
    (): PiHostModuleProvenance => {
      const record = parseHostObject(read());
      if (record.isErr()) return UNPROVEN_PROVENANCE;

      const kind = PROVENANCE_KIND_SCHEMA.safeParse(
        readDataProperty(record.value, "kind"),
      );
      if (kind.success && kind.data === "host") {
        const outcome = PROVENANCE_OUTCOME_SCHEMA.safeParse(
          readDataProperty(record.value, "outcome"),
        );
        return outcome.success
          ? { kind: "host", outcome: outcome.data }
          : { kind: "unproven", reason: "specifier-unknown" };
      }

      const reason = readDataProperty(record.value, "reason");
      return isProvenanceReason(reason)
        ? { kind: "unproven", reason }
        : UNPROVEN_PROVENANCE;
    },
    (): PiHostModuleProvenance => UNPROVEN_PROVENANCE,
  )();
  return narrowed.isOk() ? narrowed.value : UNPROVEN_PROVENANCE;
}

/**
 * Read the provenance probe behind a boundary and accept only a positive
 * host verdict. An absent probe, a throwing probe, a malformed verdict, and
 * every `unproven` reason all refuse registration.
 */
function readProviderModuleProvenance<TProvenance>(
  read: () => TProvenance,
): Result<"redirected" | "already-host", CodexFastRegistrationFailure> {
  const provenance = narrowProviderModuleProvenance(read);
  return provenance.kind === "host"
    ? ok(provenance.outcome)
    : err(unprovenModuleFailure(provenance.reason));
}

const HOST_VERSION_SCHEMA = z
  .string()
  .max(MAX_HOST_VERSION_LENGTH)
  .regex(HOST_VERSION_PATTERN);

type HostVersionReadFailure = "host-version-unavailable";

function parseHostVersion<TVersion>(version: TVersion): string | undefined {
  const parsed = Result.fromThrowable(
    () => HOST_VERSION_SCHEMA.safeParse(version),
    (): boolean => false,
  )();
  if (parsed.isErr() || !parsed.value.success) return;
  return parsed.value.data;
}

/**
 * Accept only an exact `major.minor.patch` at or above the floor. A version
 * this module cannot parse — absent, prereleased, hostile, or overlong — is
 * not evidence of a supported host, so it fails the gate.
 */
export function isCodexFastHostVersionSupported<TVersion>(
  version: TVersion,
): boolean {
  const parsed = parseHostVersion(version);
  if (parsed === undefined) return false;

  const parts = parsed.split(".").map(Number);
  for (const [index, floor] of MINIMUM_HOST_VERSION_PARTS.entries()) {
    const part = parts[index];
    if (part === undefined || !Number.isSafeInteger(part)) {
      return false;
    }
    if (part > floor) {
      return true;
    }
    if (part < floor) {
      return false;
    }
  }
  return true;
}

/** Read and parse the host version without exposing a probe failure. */
function readHostVersionSafely<TVersion>(
  read: () => TVersion,
): Result<string, HostVersionReadFailure> {
  const observed = Result.fromThrowable(
    (): TVersion => read(),
    (): HostVersionReadFailure => "host-version-unavailable",
  )();
  if (observed.isErr()) return err(observed.error);

  const parsed = parseHostVersion(observed.value);
  return parsed === undefined ? err("host-version-unavailable") : ok(parsed);
}

const PROVIDER_FACTORY_SCHEMA = z.custom<ProviderFactory>(
  (value: HostInput): boolean => isHostCallable(value),
);

/** A callable provider with the exact fields the wrapper owns. */
type NativeCodexProvider = CodexWrappableProvider & HostObjectReference;

function isNativeCodexProvider(value: HostInput): value is NativeCodexProvider {
  const checked = Result.fromThrowable(
    (): boolean => {
      const record = HOST_OBJECT_REFERENCE_SCHEMA.safeParse(value);
      if (!record.success) return false;

      const id = z
        .literal(CODEX_PROVIDER_ID)
        .safeParse(readDataProperty(record.data, "id"));
      if (!id.success) return false;

      return (
        isHostCallable(readDataProperty(record.data, "stream")) &&
        isHostCallable(readDataProperty(record.data, "streamSimple"))
      );
    },
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
}

const NATIVE_PROVIDER_SCHEMA = z.custom<NativeCodexProvider>(
  isNativeCodexProvider,
);

/**
 * Read the provider factory from an already-imported module namespace. Only
 * an own, enumerable, callable data property counts, so a namespace whose
 * factory is a trap is treated as a host without one.
 */
function readProviderFactory<TModule>(
  module: TModule,
): Result<ProviderFactory, CodexFastRegistrationFailure> {
  const record = parseHostObject(module);
  if (record.isErr()) {
    return err(failure("provider-factory-unavailable"));
  }
  const parsed = Result.fromThrowable(
    () =>
      PROVIDER_FACTORY_SCHEMA.safeParse(
        readDataProperty(record.value, CODEX_PROVIDER_FACTORY_NAME),
      ),
    (): CodexFastRegistrationFailure => failure("provider-factory-unavailable"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  return parsed.value.success
    ? ok(parsed.value.data)
    : err(failure("provider-factory-unavailable"));
}

/**
 * Build one native provider. Identity is checked here rather than trusted:
 * eligibility rule 1 keys the whole mapping on the provider id, so a factory
 * that returned something else must never be wrapped under that name.
 */
function createNativeProvider(
  factory: ProviderFactory,
): Result<NativeCodexProvider, CodexFastRegistrationFailure> {
  const produced = Result.fromThrowable(
    (): HostInput => factory(),
    (): CodexFastRegistrationFailure => failure("provider-identity-unexpected"),
  )();
  if (produced.isErr()) return err(produced.error);

  const parsed = Result.fromThrowable(
    () => NATIVE_PROVIDER_SCHEMA.safeParse(produced.value),
    (): CodexFastRegistrationFailure => failure("provider-identity-unexpected"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  return parsed.value.success
    ? ok(parsed.value.data)
    : err(failure("provider-identity-unexpected"));
}

/**
 * Import the provider module. `fromThrowable` rather than `fromPromise`,
 * because the injected loader may throw synchronously before any promise
 * exists. The rejection value is discarded: a module-resolution diagnostic
 * names paths and loader internals, and none of that may reach a log.
 */
function importProviderModule<TModule>(
  load: () => Promise<TModule>,
): ResultAsync<TModule, CodexFastRegistrationFailure> {
  return ResultAsync.fromThrowable(
    async (): Promise<TModule> => await load(),
    (): CodexFastRegistrationFailure => failure("provider-module-unavailable"),
  )();
}

const HOST_REGISTRAR_SCHEMA = z.custom<HostRegistrar>(
  (value: HostInput): boolean => isHostCallable(value),
);

function readRegisterProvider<TRegistrar>(
  register: TRegistrar | undefined,
): Result<HostRegistrar, CodexFastRegistrationFailure> {
  const parsed = Result.fromThrowable(
    () => HOST_REGISTRAR_SCHEMA.safeParse(register),
    (): CodexFastRegistrationFailure =>
      failure("register-provider-unavailable"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  return parsed.value.success
    ? ok(parsed.value.data)
    : err(failure("register-provider-unavailable"));
}

/** Hand the wrapped provider to the host. A host that throws changes nothing. */
function callRegisterProvider(
  register: HostRegistrar,
  provider: CodexWrappableProvider,
): Result<void, CodexFastRegistrationFailure> {
  return Result.fromThrowable(
    (): void => {
      register(provider);
    },
    (): CodexFastRegistrationFailure => failure("register-provider-failed"),
  )();
}

/**
 * Register the wrapped Codex provider, or explain in one bounded token why
 * this host keeps its native one.
 *
 * A failure is never fatal: the caller logs the token, the host keeps the
 * provider it already had, and declared fast intent reports the hook seam's
 * terminal `unsupported` / `harness-seam-unavailable` exactly as it did
 * before this feature existed. Agent activation never depends on this call.
 */
export function registerCodexFastProvider<TVersion, TModule, TRegistrar>(
  input: CodexFastRegistrationInput<TVersion, TModule, TRegistrar>,
): ResultAsync<CodexFastRegistrationOutcome, CodexFastRegistrationFailure> {
  const version = readHostVersionSafely(input.readHostVersion);
  if (version.isErr() || !isCodexFastHostVersionSupported(version.value)) {
    return errAsync(failure("host-version-unsupported"));
  }
  // Header authority lives in the imported module, not in the host package
  // that reports the version, so the exact subpath must be proven before the
  // wrapper can ever mutate a request body. An unproven module is refused
  // here, before the import, so nothing of this adapter's is loaded or
  // registered and the host keeps the provider it already had.
  const provenance = readProviderModuleProvenance(
    input.readProviderModuleProvenance,
  );
  if (provenance.isErr()) {
    return errAsync(provenance.error);
  }

  const register = readRegisterProvider(input.registerProvider);
  if (register.isErr()) {
    return errAsync(register.error);
  }

  return importProviderModule(input.importProviderModule)
    .andThen((module) => readProviderFactory(module))
    .andThen((factory) => createNativeProvider(factory))
    .andThen((native) =>
      wrapCodexProviderForFast(
        native,
        input.intentPort,
        input.attemptSink,
      ).mapErr(() => failure("provider-not-wrappable")),
    )
    .andThen((wrapped) => callRegisterProvider(register.value, wrapped))
    .map(
      (): CodexFastRegistrationOutcome => ({
        providerId: CODEX_PROVIDER_ID,
      }),
    );
}
