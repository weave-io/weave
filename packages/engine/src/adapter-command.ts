/**
 * Generic adapter-command dispatch boundary.
 *
 * The engine validates opaque envelope shape and routes to a registered
 * adapter handler. Payload semantics, command names beyond the opaque string,
 * and result interpretation stay adapter-owned. No harness-specific types may
 * appear here — see `docs/architecture/adapter-boundary.md` and Spec 33 §15.2.
 */

import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
} from "neverthrow";
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

/** A record value accepted at the opaque envelope boundary before parsing. */
interface AdapterCommandInputRecord {
  readonly [key: string]: AdapterCommandInput;
}

/** A callable value accepted at the opaque envelope boundary before parsing. */
type AdapterCommandInputCallable = (
  ...args: readonly AdapterCommandInput[]
) => AdapterCommandInput;

/** Runtime candidates accepted at the opaque envelope boundary before parsing. */
export type AdapterCommandInput =
  | AdapterCommandInputRecord
  | readonly AdapterCommandInput[]
  | AdapterCommandInputCallable
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

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

const invalidEnvelope = (issues: readonly string[]): AdapterCommandError => ({
  type: "InvalidEnvelope",
  issues,
});

function snapshotAdapterCommandRequest(
  value: AdapterCommandInput,
): Result<ReadonlyMap<string, PropertyDescriptor>, AdapterCommandError> {
  const reflected = Result.fromThrowable(
    () => {
      const objectValue = new Object(value);
      if (value === null || objectValue !== value)
        return err(invalidEnvelope(["(root): expected a plain object"]));

      const callable = Result.fromThrowable(
        () => Function.prototype.toString.call(objectValue),
        () => "not-callable",
      )();
      if (callable.isOk())
        return err(
          invalidEnvelope(["(root): expected a non-callable object"]),
        );

      const prototype = Object.getPrototypeOf(objectValue);
      if (prototype !== Object.prototype && prototype !== null)
        return err(invalidEnvelope(["(root): expected a plain object"]));

      const keys = Reflect.ownKeys(objectValue);
      if (keys.length !== 3)
        return err(
          invalidEnvelope(["(root): expected exactly three envelope fields"]),
        );

      const allowed = new Set(["adapter", "command", "payloadJson"]);
      const fields = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        const parsedKey = z.string().safeParse(key);
        if (!parsedKey.success || !allowed.has(parsedKey.data))
          return err(
            invalidEnvelope([
              "(root): envelope fields must be named string fields",
            ]),
          );
        const descriptor = Object.getOwnPropertyDescriptor(
          objectValue,
          parsedKey.data,
        );
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        )
          return err(
            invalidEnvelope([
              `${parsedKey.data}: expected an own data property`,
            ]),
          );
        fields.set(parsedKey.data, descriptor);
      }
      if (fields.size !== 3)
        return err(invalidEnvelope(["(root): envelope fields must be unique"]));
      return ok(fields);
    },
    () => invalidEnvelope(["(root): unable to inspect envelope"]),
  )();
  return reflected.andThen((result) => result);
}

/** Validates envelope shape only. Never inspects payload semantics. */
export function parseAdapterCommandRequest(
  value: AdapterCommandInput,
): Result<AdapterCommandRequest, AdapterCommandError> {
  const snapshot = snapshotAdapterCommandRequest(value);
  if (snapshot.isErr()) return err(snapshot.error);

  const parsed = Result.fromThrowable(
    () => ({
      adapter: opaqueNameSchema.safeParse(
        snapshot.value.get("adapter")?.value,
      ),
      command: opaqueNameSchema.safeParse(
        snapshot.value.get("command")?.value,
      ),
      payloadJson: payloadJsonSchema.safeParse(
        snapshot.value.get("payloadJson")?.value,
      ),
    }),
    () => invalidEnvelope(["(root): unable to parse envelope"]),
  )();
  if (parsed.isErr()) return err(parsed.error);

  const { adapter, command, payloadJson } = parsed.value;
  const issues: string[] = [];
  if (!adapter.success) {
    issues.push(
      ...adapter.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "adapter";
        return `${path}: ${issue.message}`;
      }),
    );
  }
  if (!command.success) {
    issues.push(
      ...command.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "command";
        return `${path}: ${issue.message}`;
      }),
    );
  }
  if (!payloadJson.success) {
    issues.push(
      ...payloadJson.error.issues.map((issue) => {
        const path =
          issue.path.length > 0 ? issue.path.join(".") : "payloadJson";
        return `${path}: ${issue.message}`;
      }),
    );
  }
  if (!adapter.success || !command.success || !payloadJson.success)
    return err(invalidEnvelope(issues));

  return ok({
    adapter: adapter.data,
    command: command.data,
    payloadJson: payloadJson.data,
  });
}

/**
 * Validates the opaque envelope and routes to the registered handler.
 * Payload parsing and result shaping remain entirely adapter-owned.
 */
export function dispatchAdapterCommand(
  registry: AdapterCommandRegistry,
  request: AdapterCommandInput,
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

  return handler(payloadJson)
    .mapErr(
      (failure): AdapterCommandError => ({
        type: "HandlerFailed",
        adapter,
        command,
        message: failure.message,
      }),
    )
    .andThen((resultJson) => {
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
