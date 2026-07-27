import type { Result } from "neverthrow";
import { ResultAsync, Result as ResultNs } from "neverthrow";
import type { PiModelInfo, PiModelRegistry } from "./types.js";

/**
 * Safely awaits an injected port call that is *typed* to return a
 * `ResultAsync<T, E>` (or any `PromiseLike<Result<T, E>>`), but whose
 * concrete implementation is supplied by a caller (test double, or a real
 * dependency with its own bugs) and therefore cannot be fully trusted to
 * honor that type at runtime - it may throw synchronously or reject its
 * promise despite `E` being declared `never`.
 *
 * Any such throw/rejection is captured and converted through `onThrow`
 * instead of becoming an unhandled rejection, fulfilling AGENTS.md's
 * "wrap third-party/injected calls with neverthrow" rule even at this
 * additional layer of indirection. A genuine `Err(e)` from the port is
 * still surfaced as `Err(e)`, not silently converted.
 */
export function safelyAwaitPortResult<T, E, F>(
  call: () => PromiseLike<Result<T, E>>,
  onThrow: (cause: unknown) => F,
): ResultAsync<T, E | F> {
  return ResultAsync.fromPromise(Promise.resolve().then(call), onThrow).andThen(
    (result) => result,
  );
}

/**
 * A closed, sanitized reason for a `safelyListAvailableModels` failure.
 * Deliberately does not embed anything derived from the thrown value -
 * Pi adapter contract bans private paths, environment values, and secrets from public
 * failures, and an injected host's exception content cannot be trusted not
 * to contain any of those.
 */
export const MODEL_REGISTRY_THREW_REASON = "model-registry-get-available-threw";

/**
 * Safely calls an injected `modelRegistry.getAvailable()` port. It is
 * *typed* as a plain synchronous array return, but - like any
 * adapter-supplied port - a misbehaving concrete implementation could still
 * throw. A throw here must not crash preflight or a `before_agent_start`
 * turn: Pi adapter contract's own fail-closed behavior for model resolution is to
 * retain the current authenticated model and degrade, so an unreadable
 * catalog is treated the same way as an empty one.
 *
 * The returned `Err` always carries a fixed, closed-set reason
 * (`MODEL_REGISTRY_THREW_REASON`) rather than any text derived from the
 * thrown value - callers must never surface arbitrary exception content in
 * logs or failure correlation fields (Pi adapter contract closed-failure contract).
 * Callers fall back to an empty list rather than letting the exception
 * escape (neverthrow-wrap-exceptions).
 */
export function safelyListAvailableModels(
  modelRegistry: Pick<PiModelRegistry, "getAvailable">,
): Result<readonly PiModelInfo[], string> {
  return ResultNs.fromThrowable(
    () => modelRegistry.getAvailable(),
    (): string => MODEL_REGISTRY_THREW_REASON,
  )();
}
