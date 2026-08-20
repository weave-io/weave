import type { WeaveConfig } from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  isPiChildOverlayKeySyntax,
  PI_CHILD_OVERLAY_ACTION_IDS,
  PI_CHILD_OVERLAY_KEY_BOUNDS,
  type PiChildOverlayActionId,
  type PiChildOverlayKey,
} from "./child-overlay-keys.js";

/**
 * Pi adapter contract child-inspection defaults.
 *
 * `keys` is deliberately absent from the defaults object: an empty override
 * map and "no `keys` block at all" mean exactly the same thing (every Task 13
 * action keeps its declared default key), and materializing an empty object
 * here would make every existing config compare unequal to its own defaults.
 */
export const DEFAULT_PI_CHILD_INSPECTION_SETTINGS = Object.freeze({
  recovery_enabled: true,
  recovery_countdown_seconds: 10,
} as const);

/**
 * One configured key list for one stable Task 13 action id.
 *
 * A bare string is accepted as the one-key shorthand; both forms normalize to
 * a frozen array so downstream planning has a single shape to reason about.
 */
const OverlayKeySchema = z
  .string()
  .min(1)
  .max(PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeyLength)
  .refine(isPiChildOverlayKeySyntax, "unsupported key syntax");

const OverlayKeyListSchema = z
  .union([
    OverlayKeySchema.transform((key) => [key]),
    z
      .array(OverlayKeySchema)
      .min(1)
      .max(PI_CHILD_OVERLAY_KEY_BOUNDS.maxKeysPerAction),
  ])
  .transform((keys) => Object.freeze([...new Set(keys)]) as readonly string[]);

type PiChildOverlayKeysShape = {
  [K in PiChildOverlayActionId]: z.ZodOptional<typeof OverlayKeyListSchema>;
};

/**
 * Builds the closed action-id shape without a fromEntries cast. Each key is
 * optional so an absent override keeps the declared default; `.strict()` on
 * the object still rejects misspelled action ids.
 */
function buildPiChildOverlayKeysShape(): PiChildOverlayKeysShape {
  const shape = {} as PiChildOverlayKeysShape;
  for (const id of PI_CHILD_OVERLAY_ACTION_IDS) {
    shape[id] = OverlayKeyListSchema.optional();
  }
  return shape;
}

/**
 * The override map is keyed by the closed set of Task 13 action ids and is
 * `.strict()` for the same reason the surrounding block is: silently ignoring
 * a misspelled action id would leave the user believing a rebind took effect.
 *
 * Strictness is also how a REMOVED action stays removed. The compact-view
 * toggle no longer exists, so a config that still rebinds it is rejected with
 * its id named, rather than parsed into a binding nothing will ever read.
 */
const PiChildOverlayKeysSchema = z
  .object(buildPiChildOverlayKeysShape())
  .strict();

/**
 * Explicit override-map shape. Declared by hand so the exported schema below
 * can carry a nameable annotation: the inferred Zod type of a closed action-id
 * object with transforms exceeds what TypeScript will serialize into a
 * declaration file (TS7056).
 */
export type PiChildOverlayKeyOverrideMap = {
  readonly [K in PiChildOverlayActionId]?: readonly string[];
};

/** Explicit parsed shape of one `child_inspection` block. */
export interface PiChildInspectionSettingsShape {
  readonly recovery_enabled: boolean;
  readonly recovery_countdown_seconds: number;
  readonly keys?: PiChildOverlayKeyOverrideMap;
}

const RECOVERY_COUNTDOWN_SECONDS = {
  min: 0,
  max: 60,
} as const;

/**
 * The only Pi-owned settings block. `.strict()` is deliberate: accepting a
 * misspelled key would make the operator believe a safety limit was active
 * when Pi was using its default instead.
 */
export const PiChildInspectionSettingsSchema: z.ZodType<
  PiChildInspectionSettingsShape,
  unknown
> = z
  .object({
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
    // Optional so every pre-Task-13 config keeps parsing untouched.
    keys: PiChildOverlayKeysSchema.optional(),
  })
  .strict();

export type PiChildInspectionSettings =
  Readonly<PiChildInspectionSettingsShape>;

/**
 * Resolved override map for the Task 13 actions. Absent `keys` yields an empty
 * map, which planning reads as "use every declared default".
 */
export function childInspectionOverlayKeyOverrides(
  settings: Pick<PiChildInspectionSettings, "keys">,
): ReadonlyMap<PiChildOverlayActionId, readonly PiChildOverlayKey[]> {
  const overrides = new Map<
    PiChildOverlayActionId,
    readonly PiChildOverlayKey[]
  >();
  const configured = settings.keys;
  if (configured === undefined) return overrides;
  for (const actionId of PI_CHILD_OVERLAY_ACTION_IDS) {
    const keys = configured[actionId];
    if (keys === undefined || keys.length === 0) continue;
    overrides.set(actionId, keys as readonly PiChildOverlayKey[]);
  }
  return overrides;
}

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
  settings: PiChildInspectionSettingsShape,
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
