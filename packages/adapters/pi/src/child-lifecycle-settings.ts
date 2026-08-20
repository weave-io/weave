import type { WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS = Object.freeze({
  handshakeTimeoutMs: 30_000,
  replyTimeoutMs: 60_000,
  settlementInactivityTimeoutMs: 60 * 60 * 1_000,
  absoluteRuntimeBudgetMs: 6 * 60 * 60 * 1_000,
});

export const MAX_PI_CHILD_LIFECYCLE_SETTINGS = Object.freeze({
  handshakeTimeoutMs: 5 * 60 * 1_000,
  replyTimeoutMs: 15 * 60 * 1_000,
  settlementInactivityTimeoutMs: 24 * 60 * 60 * 1_000,
  absoluteRuntimeBudgetMs: 7 * 24 * 60 * 60 * 1_000,
});

export interface PiChildLifecycleSettings {
  readonly handshakeTimeoutMs: number;
  readonly replyTimeoutMs: number;
  readonly settlementInactivityTimeoutMs: number;
  readonly absoluteRuntimeBudgetMs: number;
}

export interface PiChildLifecycleSettingsIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

const positiveBoundedInteger = (maximum: number, fallback: number) =>
  z.number().int().finite().positive().max(maximum).default(fallback);

const PiChildLifecycleSettingsSchema = z
  .object({
    handshake_timeout_ms: positiveBoundedInteger(
      MAX_PI_CHILD_LIFECYCLE_SETTINGS.handshakeTimeoutMs,
      DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS.handshakeTimeoutMs,
    ),
    reply_timeout_ms: positiveBoundedInteger(
      MAX_PI_CHILD_LIFECYCLE_SETTINGS.replyTimeoutMs,
      DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS.replyTimeoutMs,
    ),
    settlement_inactivity_timeout_ms: positiveBoundedInteger(
      MAX_PI_CHILD_LIFECYCLE_SETTINGS.settlementInactivityTimeoutMs,
      DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS.settlementInactivityTimeoutMs,
    ),
    absolute_runtime_budget_ms: positiveBoundedInteger(
      MAX_PI_CHILD_LIFECYCLE_SETTINGS.absoluteRuntimeBudgetMs,
      DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS.absoluteRuntimeBudgetMs,
    ),
  })
  .strict();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function issueFromZod(issue: z.core.$ZodIssue): PiChildLifecycleSettingsIssue {
  return Object.freeze({
    code: issue.code,
    path: Object.freeze(
      issue.path.map((part) =>
        typeof part === "symbol" ? part.toString() : part,
      ),
    ),
    message: issue.message,
  });
}

export function resolvePiChildLifecycleSettings(
  config: WeaveConfig,
): Result<
  PiChildLifecycleSettings,
  readonly PiChildLifecycleSettingsIssue[]
> {
  const adapters = config.settings?.adapters;
  if (adapters === undefined) return ok(DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS);
  if (!isRecord(adapters)) {
    return err([
      {
        code: "invalid_type",
        path: ["settings", "adapters"],
        message: "must be an object",
      },
    ]);
  }
  const pi = adapters.pi;
  if (pi === undefined) return ok(DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS);
  if (!isRecord(pi)) {
    return err([
      {
        code: "invalid_type",
        path: ["settings", "adapters", "pi"],
        message: "must be an object",
      },
    ]);
  }
  const value = pi.child_lifecycle;
  if (value === undefined) return ok(DEFAULT_PI_CHILD_LIFECYCLE_SETTINGS);
  const parsed = PiChildLifecycleSettingsSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      Object.freeze(
        parsed.error.issues.map((issue) =>
          Object.freeze({
            ...issueFromZod(issue),
            path: Object.freeze([
              "settings",
              "adapters",
              "pi",
              "child_lifecycle",
              ...issue.path.map((part) =>
                typeof part === "symbol" ? part.toString() : part,
              ),
            ]),
          }),
        ),
      ),
    );
  }
  return ok(
    Object.freeze({
      handshakeTimeoutMs: parsed.data.handshake_timeout_ms,
      replyTimeoutMs: parsed.data.reply_timeout_ms,
      settlementInactivityTimeoutMs:
        parsed.data.settlement_inactivity_timeout_ms,
      absoluteRuntimeBudgetMs: parsed.data.absolute_runtime_budget_ms,
    }),
  );
}
