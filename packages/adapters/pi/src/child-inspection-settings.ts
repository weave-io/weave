import type { WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/** Pi adapter contract child-inspection defaults. */
export const DEFAULT_PI_CHILD_INSPECTION_SETTINGS = Object.freeze({
  persist_history: true,
  max_bytes_per_child: 4_194_304,
  max_bytes_total: 67_108_864,
  orphan_retention_days: 30,
  recovery_enabled: true,
  recovery_countdown_seconds: 10,
} as const);

const MAX_BYTES_PER_CHILD = {
  min: 65_536,
  max: 67_108_864,
} as const;
const MAX_BYTES_TOTAL = {
  min: 1_048_576,
  max: 1_073_741_824,
} as const;
const ORPHAN_RETENTION_DAYS = {
  min: 1,
  max: 3_650,
} as const;
const RECOVERY_COUNTDOWN_SECONDS = {
  min: 0,
  max: 60,
} as const;

/**
 * The only Pi-owned settings block. `.strict()` is deliberate: accepting a
 * misspelled key would make the operator believe a safety limit was active
 * when Pi was using its default instead.
 */
export const PiChildInspectionSettingsSchema = z
  .object({
    persist_history: z
      .boolean()
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.persist_history),
    max_bytes_per_child: z
      .number()
      .int()
      .finite()
      .min(MAX_BYTES_PER_CHILD.min)
      .max(MAX_BYTES_PER_CHILD.max)
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.max_bytes_per_child),
    max_bytes_total: z
      .number()
      .int()
      .finite()
      .min(MAX_BYTES_TOTAL.min)
      .max(MAX_BYTES_TOTAL.max)
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.max_bytes_total),
    orphan_retention_days: z
      .number()
      .int()
      .finite()
      .min(ORPHAN_RETENTION_DAYS.min)
      .max(ORPHAN_RETENTION_DAYS.max)
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.orphan_retention_days),
    recovery_enabled: z
      .boolean()
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.recovery_enabled),
    recovery_countdown_seconds: z
      .number()
      .int()
      .finite()
      .min(RECOVERY_COUNTDOWN_SECONDS.min)
      .max(RECOVERY_COUNTDOWN_SECONDS.max)
      .default(DEFAULT_PI_CHILD_INSPECTION_SETTINGS.recovery_countdown_seconds),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.max_bytes_total < settings.max_bytes_per_child) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_bytes_total"],
        message: "must be greater than or equal to max_bytes_per_child",
      });
    }
  });

export type PiChildInspectionSettings = Readonly<
  z.infer<typeof PiChildInspectionSettingsSchema>
>;

export interface PiChildInspectionSettingsIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly keys?: readonly string[];
}

export type PiChildInspectionSettingsResolution =
  | {
      readonly status: "valid";
      readonly settings: PiChildInspectionSettings;
    }
  | {
      readonly status: "invalid";
      readonly issues: readonly PiChildInspectionSettingsIssue[];
    };

export type PiChildInspectionSettingsChoice = "defaults" | "health-only";
export type PiChildInspectionSettingsMode =
  | "configured"
  | "defaults"
  | "health-only";

/** The immutable settings object passed to every child-inspection seam. */
export interface PiChildInspectionEffectiveSettings {
  readonly settings: PiChildInspectionSettings;
  readonly mode: PiChildInspectionSettingsMode;
  readonly issues: readonly PiChildInspectionSettingsIssue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function freezeSettings(
  settings: z.infer<typeof PiChildInspectionSettingsSchema>,
): PiChildInspectionSettings {
  return Object.isFrozen(settings) ? settings : Object.freeze({ ...settings });
}

function issueFromZod(issue: z.core.$ZodIssue): PiChildInspectionSettingsIssue {
  const keys =
    issue.code === "unrecognized_keys" && "keys" in issue
      ? (issue.keys as readonly string[])
      : undefined;
  return Object.freeze({
    code: issue.code,
    path: Object.freeze(
      issue.path.map((segment) =>
        typeof segment === "symbol" ? segment.toString() : segment,
      ),
    ),
    message: issue.message,
    ...(keys === undefined ? {} : { keys: Object.freeze([...keys]) }),
  });
}

function invalid(
  issues: readonly PiChildInspectionSettingsIssue[],
): Result<never, readonly PiChildInspectionSettingsIssue[]> {
  return err(Object.freeze([...issues]));
}

/**
 * Validates one `child_inspection` value and returns every Zod issue. The
 * result never contains a partly parsed object: consumers must choose the
 * defaults or health-only policy before activation can continue.
 */
export function parsePiChildInspectionSettings(
  value: unknown,
): Result<
  PiChildInspectionSettings,
  readonly PiChildInspectionSettingsIssue[]
> {
  const parsed = PiChildInspectionSettingsSchema.safeParse(value);
  if (!parsed.success) {
    return invalid(Object.freeze(parsed.error.issues.map(issueFromZod)));
  }
  return ok(freezeSettings(parsed.data));
}

/**
 * Reads only Pi's nested child-inspection block. Other adapter blocks are
 * intentionally opaque and are not validated by this Pi-local parser.
 */
export function resolvePiChildInspectionSettings(
  config: Pick<WeaveConfig, "settings">,
): Result<
  PiChildInspectionSettingsResolution,
  readonly PiChildInspectionSettingsIssue[]
> {
  const settings = config.settings;
  if (settings === undefined || settings.adapters === undefined) {
    return ok({
      status: "valid",
      settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    });
  }

  const adapters = settings.adapters;
  if (adapters.pi === undefined) {
    return ok({
      status: "valid",
      settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    });
  }

  if (!isRecord(adapters.pi)) {
    return invalid([
      Object.freeze({
        code: "invalid_type",
        path: ["settings", "adapters", "pi"],
        message: "expected an object",
      }),
    ]);
  }

  if (adapters.pi.child_inspection === undefined) {
    return ok({
      status: "valid",
      settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    });
  }

  const parsed = parsePiChildInspectionSettings(adapters.pi.child_inspection);
  return parsed.match(
    (settings) => ok({ status: "valid", settings }),
    (issues) => ok({ status: "invalid", issues }),
  );
}

export function effectivePiChildInspectionSettings(
  resolution: PiChildInspectionSettingsResolution,
  choice?: PiChildInspectionSettingsChoice,
): PiChildInspectionEffectiveSettings {
  if (resolution.status === "valid") {
    return Object.freeze({
      settings: freezeSettings(resolution.settings),
      mode: "configured",
      issues: Object.freeze([]),
    });
  }

  const issues = Object.freeze([...resolution.issues]);
  if (choice === "defaults") {
    return Object.freeze({
      settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
      mode: "defaults",
      issues,
    });
  }

  return Object.freeze({
    settings: DEFAULT_PI_CHILD_INSPECTION_SETTINGS,
    mode: "health-only",
    issues,
  });
}

const PI_ADAPTER_PATH = "settings.adapters.pi";
const PI_CHILD_INSPECTION_PATH = `${PI_ADAPTER_PATH}.child_inspection`;

export function formatPiChildInspectionSettingsIssues(
  issues: readonly PiChildInspectionSettingsIssue[],
): string {
  return issues
    .map((issue) => {
      const localPath = issue.path.join(".");
      let path = PI_CHILD_INSPECTION_PATH;
      if (localPath === PI_ADAPTER_PATH) {
        path = localPath;
      } else if (localPath === PI_CHILD_INSPECTION_PATH) {
        path = localPath;
      } else if (localPath.startsWith(`${PI_CHILD_INSPECTION_PATH}.`)) {
        path = localPath;
      } else if (localPath !== "") {
        path = `${PI_CHILD_INSPECTION_PATH}.${localPath}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
