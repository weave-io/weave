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
 * {@link CODEX_FAST_MINIMUM_HOST_VERSION}, the provider subpath import
 * resolves with the expected factory, the factory yields a provider whose id
 * is exactly the Codex provider id, the wrapper accepts it, and
 * `registerProvider` is really callable. `options.fetch` on the codex SSE path
 * — the wrapper's only seam for header authority — first appears in pi-ai
 * 0.83.0, so an older host could set a priority body it can never route, and
 * that is precisely what this gate refuses to allow.
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

import { errAsync, Result, ResultAsync } from "neverthrow";
import type { CodexFastAttemptSink, CodexFastIntentPort } from "./provider.js";
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
};

/** What a successful registration reports: a token, not the provider. */
export type CodexFastRegistrationOutcome = {
  readonly providerId: typeof CODEX_PROVIDER_ID;
};

/**
 * The host-facing probes, injected so a test never needs a real Pi process,
 * a real host version, or the real pi-ai package.
 */
export type CodexFastRegistrationInput = {
  /** The host's public `VERSION` export, read as an unknown. */
  readonly readHostVersion: () => unknown;
  /** Dynamic import of {@link CODEX_PROVIDER_MODULE_SPECIFIER}. */
  readonly importProviderModule: () => Promise<unknown>;
  /**
   * `ExtensionAPI.registerProvider`, already bound to the host object, or
   * absent when this host exposes no such surface.
   */
  readonly registerProvider: unknown;
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

/**
 * Accept only an exact `major.minor.patch` at or above the floor. A version
 * this module cannot parse — absent, prereleased, hostile, or overlong — is
 * not evidence of a supported host, so it fails the gate.
 */
export function isCodexFastHostVersionSupported(version: unknown): boolean {
  if (typeof version !== "string" || version.length > MAX_HOST_VERSION_LENGTH) {
    return false;
  }
  if (!HOST_VERSION_PATTERN.test(version)) {
    return false;
  }
  const parts = version.split(".").map(Number);
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

/** Read the host version behind a boundary: the export may be an accessor. */
const readHostVersionSafely = Result.fromThrowable(
  (read: () => unknown): unknown => read(),
  (): unknown => undefined,
);

/**
 * Read the provider factory from an already-imported module namespace. Only
 * an own, enumerable, callable data property counts, so a namespace whose
 * factory is a trap is treated as a host without one.
 */
const readProviderFactory = Result.fromThrowable(
  (module: unknown): ((...args: never[]) => unknown) => {
    if (typeof module !== "object" || module === null) {
      throw new Error("module-namespace-unexpected");
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      module,
      CODEX_PROVIDER_FACTORY_NAME,
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new Error("factory-missing");
    }
    return descriptor.value as (...args: never[]) => unknown;
  },
  (): CodexFastRegistrationFailure => failure("provider-factory-unavailable"),
);

/** The minimum shape the wrapper needs, proven before it is handed over. */
type NativeCodexProvider = {
  readonly id: string;
  stream: (...args: never[]) => unknown;
  streamSimple: (...args: never[]) => unknown;
};

/**
 * Build one native provider. Identity is checked here rather than trusted:
 * eligibility rule 1 keys the whole mapping on the provider id, so a factory
 * that returned something else must never be wrapped under that name.
 */
const createNativeProvider = Result.fromThrowable(
  (factory: (...args: never[]) => unknown): NativeCodexProvider => {
    const provider = (factory as () => unknown)();
    if (typeof provider !== "object" || provider === null) {
      throw new Error("provider-shape-unexpected");
    }
    const candidate = provider as {
      readonly id?: unknown;
      readonly stream?: unknown;
      readonly streamSimple?: unknown;
    };
    if (
      candidate.id !== CODEX_PROVIDER_ID ||
      typeof candidate.stream !== "function" ||
      typeof candidate.streamSimple !== "function"
    ) {
      throw new Error("provider-identity-unexpected");
    }
    return provider as NativeCodexProvider;
  },
  (): CodexFastRegistrationFailure => failure("provider-identity-unexpected"),
);

/**
 * Import the provider module. `fromThrowable` rather than `fromPromise`,
 * because the injected loader may throw synchronously before any promise
 * exists. The rejection value is discarded: a module-resolution diagnostic
 * names paths and loader internals, and none of that may reach a log.
 */
const importProviderModule = ResultAsync.fromThrowable(
  async (load: () => Promise<unknown>): Promise<unknown> => await load(),
  (): CodexFastRegistrationFailure => failure("provider-module-unavailable"),
);

/** Hand the wrapped provider to the host. A host that throws changes nothing. */
const callRegisterProvider = Result.fromThrowable(
  (register: (provider: unknown) => unknown, provider: unknown): void => {
    register(provider);
  },
  (): CodexFastRegistrationFailure => failure("register-provider-failed"),
);

/**
 * Register the wrapped Codex provider, or explain in one bounded token why
 * this host keeps its native one.
 *
 * A failure is never fatal: the caller logs the token, the host keeps the
 * provider it already had, and declared fast intent reports the hook seam's
 * terminal `unsupported` / `harness-seam-unavailable` exactly as it did
 * before this feature existed. Agent activation never depends on this call.
 */
export function registerCodexFastProvider(
  input: CodexFastRegistrationInput,
): ResultAsync<CodexFastRegistrationOutcome, CodexFastRegistrationFailure> {
  const version = readHostVersionSafely(input.readHostVersion).unwrapOr(
    undefined,
  );
  if (!isCodexFastHostVersionSupported(version)) {
    return errAsync(failure("host-version-unsupported"));
  }
  const register = input.registerProvider;
  if (typeof register !== "function") {
    return errAsync(failure("register-provider-unavailable"));
  }
  const registerProvider = register as (provider: unknown) => unknown;
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
    .andThen((wrapped) => callRegisterProvider(registerProvider, wrapped))
    .map(() => ({ providerId: CODEX_PROVIDER_ID }) as const);
}
