/**
 * Generic adapter-command dispatch boundary.
 *
 * The engine validates opaque envelope shape and routes to a registered
 * adapter handler. Payload semantics, command names beyond the opaque string,
 * and result interpretation stay adapter-owned. No harness-specific types may
 * appear here — see `docs/architecture/adapter-boundary.md` and Spec 33 §15.2.
 */

import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const opaqueNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/u, "opaque name must be a lowercase identifier");

const payloadJsonSchema = z.string().max(256_000);

/** Opaque request envelope. Payload bytes are adapter-owned JSON text. */
export const AdapterCommandRequestSchema = z
  .object({
    adapter: opaqueNameSchema,
    command: opaqueNameSchema,
    payloadJson: payloadJsonSchema,
  })
  .strict();

export type AdapterCommandRequest = z.infer<typeof AdapterCommandRequestSchema>;

/** Opaque success envelope. Result bytes are adapter-owned JSON text. */
export const AdapterCommandResultSchema = z
  .object({
    resultJson: payloadJsonSchema,
  })
  .strict();

export type AdapterCommandResult = z.infer<typeof AdapterCommandResultSchema>;

/** Closed failure set for envelope validation and dispatch. */
export type AdapterCommandError =
  | {
      readonly type: "InvalidEnvelope";
      readonly issues: readonly string[];
    }
  | {
      readonly type: "AdapterNotRegistered";
      readonly adapter: string;
    }
  | {
      readonly type: "CommandNotRegistered";
      readonly adapter: string;
      readonly command: string;
    }
  | {
      readonly type: "HandlerFailed";
      readonly adapter: string;
      readonly command: string;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/**
 * One adapter-owned command handler. Receives opaque JSON text and returns
 * opaque JSON text. Failures are messages only — never harness objects.
 */
export type AdapterCommandHandler = (
  payloadJson: string,
) => ResultAsync<string, { readonly message: string }>;

/** Nested registry: adapter name → command name → handler. */
export type AdapterCommandRegistry = ReadonlyMap<
  string,
  ReadonlyMap<string, AdapterCommandHandler>
>;

/** Builds an immutable nested registry from a plain record. */
export function createAdapterCommandRegistry(
  adapters: Readonly<
    Record<string, Readonly<Record<string, AdapterCommandHandler>>>
  >,
): AdapterCommandRegistry {
  const outer = new Map<string, ReadonlyMap<string, AdapterCommandHandler>>();
  for (const [adapter, commands] of Object.entries(adapters)) {
    outer.set(adapter, new Map(Object.entries(commands)));
  }
  return outer;
}

// ---------------------------------------------------------------------------
// Validation + dispatch
// ---------------------------------------------------------------------------

/** Validates envelope shape only. Never inspects payload semantics. */
export function parseAdapterCommandRequest(
  value: unknown,
): Result<AdapterCommandRequest, AdapterCommandError> {
  const parsed = AdapterCommandRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      type: "InvalidEnvelope",
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      }),
    });
  }
  return ok(parsed.data);
}

/**
 * Validates the opaque envelope and routes to the registered handler.
 * Payload parsing and result shaping remain entirely adapter-owned.
 */
export function dispatchAdapterCommand(
  registry: AdapterCommandRegistry,
  request: unknown,
): ResultAsync<AdapterCommandResult, AdapterCommandError> {
  const envelope = parseAdapterCommandRequest(request);
  if (envelope.isErr()) return errAsync(envelope.error);

  const { adapter, command, payloadJson } = envelope.value;
  const commands = registry.get(adapter);
  if (commands === undefined) {
    return errAsync({ type: "AdapterNotRegistered", adapter });
  }
  const handler = commands.get(command);
  if (handler === undefined) {
    return errAsync({ type: "CommandNotRegistered", adapter, command });
  }

  return handler(payloadJson).mapErr(
    (failure): AdapterCommandError => ({
      type: "HandlerFailed",
      adapter,
      command,
      message: failure.message,
    }),
  ).andThen((resultJson) => {
    const result = AdapterCommandResultSchema.safeParse({ resultJson });
    if (!result.success) {
      return errAsync<AdapterCommandResult, AdapterCommandError>({
        type: "HandlerFailed",
        adapter,
        command,
        message: "handler returned an invalid opaque result envelope",
      });
    }
    return okAsync(result.data);
  });
}
