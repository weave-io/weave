/**
 * The published model recommendations format (Spec 39).
 *
 * Maintainers publish a list of builtin-agent `models` on tryweave.io as a
 * signed envelope, `{ "payload": "<list JSON text>", "sig": "<base64>" }`.
 * This module owns the shape of both, the limits that keep a list from growing
 * new powers, and the rule that picks one section for a harness. Signature and
 * freshness checks live in `model-recommendations-verifier.ts`.
 *
 * The normative description is Spec 39, "The published file":
 * docs/specs/39-spec-model-recommendations/39-spec-model-recommendations.md
 */

import { ModelUpdatesChannelSchema } from "@weaveio/weave-core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The only list `schema` this release understands; `v1` in the served URL. */
export const MODEL_RECOMMENDATIONS_SCHEMA_VERSION = 1;

/** Largest accepted file, list or envelope, in UTF-8 bytes (64 KiB). */
export const MAX_MODEL_RECOMMENDATIONS_BYTES = 64 * 1024;

/** A list may be valid for at most 90 days after it was issued. */
export const MAX_MODEL_RECOMMENDATIONS_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

/** How far ahead of the client's clock `issued` may be (24 hours). */
export const MAX_MODEL_RECOMMENDATIONS_ISSUED_SKEW_MS = 24 * 60 * 60 * 1000;

/** Longest accepted `evidence` URL. */
export const MAX_MODEL_RECOMMENDATIONS_EVIDENCE_LENGTH = 256;

/** Agents per section. */
export const MIN_RECOMMENDED_AGENTS = 1;
export const MAX_RECOMMENDED_AGENTS = 32;

/** Model entries per agent. */
export const MIN_RECOMMENDED_MODELS = 1;
export const MAX_RECOMMENDED_MODELS = 8;

/** Longest accepted model entry. Bounds the file; real IDs are far shorter. */
export const MAX_RECOMMENDED_MODEL_LENGTH = 128;

/** Harnesses that may carry a section of their own. */
export const RECOMMENDATIONS_HARNESSES = [
  "opencode2",
  "claude-code",
  "pi",
] as const;

/** A harness ID an adapter passes to select its section. */
export type RecommendationsHarness = (typeof RECOMMENDATIONS_HARNESSES)[number];

/** The only entries a `claude-code` section may use: Claude Code's tiers. */
export const CLAUDE_CODE_MODEL_TIERS = ["opus", "sonnet", "haiku"] as const;

/** A Claude Code tier name. */
export type ClaudeCodeModelTier = (typeof CLAUDE_CODE_MODEL_TIERS)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * One `models` entry. A DSL `models` entry is any string; a published entry is
 * also non-empty, bounded and free of whitespace, since every harness matches
 * it exactly against a catalog ID or tier name.
 */
const ModelEntrySchema = z
  .string()
  .min(1, "a model entry must not be empty")
  .max(MAX_RECOMMENDED_MODEL_LENGTH)
  .refine((value) => !/\s/.test(value), {
    message: "a model entry must not contain whitespace",
  });

/** `default` and `pi` entries are bare IDs, as in the builtin lists. */
const BareModelEntrySchema = ModelEntrySchema.refine(
  (value) => !value.includes("/"),
  {
    message:
      "this section takes bare model IDs; only the opencode2 section may name a provider",
  },
);

const ClaudeCodeTierSchema = z.enum(CLAUDE_CODE_MODEL_TIERS, {
  message: "claude-code entries must be opus, sonnet or haiku",
});

function sectionSchema<Entry extends z.ZodType<string>>(entry: Entry) {
  return z
    .object({
      agents: z
        .record(
          z.string().regex(AGENT_NAME_PATTERN, {
            message:
              "an agent name is lowercase letters, digits and hyphens, starting with a letter",
          }),
          z
            .object({
              models: z
                .array(entry)
                .min(MIN_RECOMMENDED_MODELS)
                .max(MAX_RECOMMENDED_MODELS),
            })
            .strict(),
        )
        .refine(
          (agents) => {
            const count = Object.keys(agents).length;
            return (
              count >= MIN_RECOMMENDED_AGENTS && count <= MAX_RECOMMENDED_AGENTS
            );
          },
          {
            message: `a section names ${MIN_RECOMMENDED_AGENTS}–${MAX_RECOMMENDED_AGENTS} agents`,
          },
        ),
    })
    .strict();
}

const DefaultSectionSchema = sectionSchema(BareModelEntrySchema);

/** One section: `{ agents: { <name>: { models: [...] } } }`. */
export const ModelRecommendationsSectionSchema =
  sectionSchema(ModelEntrySchema);

const HarnessSectionsSchema = z
  .object({
    opencode2: sectionSchema(ModelEntrySchema).optional(),
    "claude-code": sectionSchema(ClaudeCodeTierSchema).optional(),
    pi: sectionSchema(BareModelEntrySchema).optional(),
  })
  .strict();

/**
 * The list inside the envelope. Strict at every level: an unknown field is
 * rejected rather than ignored, so the format cannot gain powers by accident.
 */
export const ModelRecommendationsFileSchema = z
  .object({
    schema: z.literal(MODEL_RECOMMENDATIONS_SCHEMA_VERSION),
    channel: ModelUpdatesChannelSchema,
    issued: z.iso.datetime({
      message: "issued must be an ISO 8601 UTC timestamp ending in Z",
    }),
    expires: z.iso.datetime({
      message: "expires must be an ISO 8601 UTC timestamp ending in Z",
    }),
    min_config_version: z
      .string()
      .regex(SEMVER_PATTERN, {
        message: "min_config_version must be a semver version",
      })
      .optional(),
    evidence: z
      .url({
        protocol: /^https$/,
        message: "evidence must be an https URL",
      })
      .max(MAX_MODEL_RECOMMENDATIONS_EVIDENCE_LENGTH),
    default: DefaultSectionSchema,
    harnesses: HarnessSectionsSchema.optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const issued = Date.parse(file.issued);
    const expires = Date.parse(file.expires);
    if (expires <= issued) {
      ctx.addIssue({
        code: "custom",
        path: ["expires"],
        message: "expires must be later than issued",
      });
      return;
    }
    if (expires - issued > MAX_MODEL_RECOMMENDATIONS_VALIDITY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["expires"],
        message: "expires must be at most 90 days after issued",
      });
    }
  });

/** A validated recommendations list. */
export type ModelRecommendationsFile = z.infer<
  typeof ModelRecommendationsFileSchema
>;

/** One validated section. */
export type ModelRecommendationsSection = z.infer<
  typeof ModelRecommendationsSectionSchema
>;

/** The served envelope: the list's exact text and its Ed25519 signature. */
export const ModelRecommendationsEnvelopeSchema = z
  .object({
    payload: z.string(),
    sig: z.string(),
  })
  .strict();

/** A parsed (not yet verified) envelope. */
export type ModelRecommendationsEnvelope = z.infer<
  typeof ModelRecommendationsEnvelopeSchema
>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a list or envelope was rejected. */
export type ModelRecommendationsError =
  | {
      readonly type: "TooLarge";
      readonly bytes: number;
      readonly limit: number;
    }
  | { readonly type: "EnvelopeInvalid"; readonly message: string }
  | { readonly type: "KeyInvalid"; readonly message: string }
  | { readonly type: "SignatureInvalid"; readonly message: string }
  | { readonly type: "SchemaInvalid"; readonly issues: readonly string[] }
  | {
      readonly type: "ChannelMismatch";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly type: "ClientTooOld";
      readonly required: string;
      readonly actual: string;
    }
  | { readonly type: "Expired"; readonly expires: string; readonly now: string }
  | {
      readonly type: "IssuedInFuture";
      readonly issued: string;
      readonly now: string;
    }
  | {
      readonly type: "OlderThanBuiltins";
      readonly issued: string;
      readonly builtinsIssued: string;
    }
  | {
      readonly type: "NotNewer";
      readonly issued: string;
      readonly appliedIssued: string;
    };

/** A one-line, user-facing reason for a rejection. */
export function describeModelRecommendationsError(
  error: ModelRecommendationsError,
): string {
  switch (error.type) {
    case "TooLarge":
      return `the file is ${error.bytes} bytes; the limit is ${error.limit}`;
    case "EnvelopeInvalid":
      return `the envelope is not { "payload", "sig" }: ${error.message}`;
    case "KeyInvalid":
      return `a public key could not be used: ${error.message}`;
    case "SignatureInvalid":
      return `the signature does not verify: ${error.message}`;
    case "SchemaInvalid":
      return `the list is invalid: ${error.issues.join("; ")}`;
    case "ChannelMismatch":
      return `the list is for channel ${error.actual}, not ${error.expected}`;
    case "ClientTooOld":
      return `the list needs version ${error.required} or later; this is ${error.actual}`;
    case "Expired":
      return `the list expired at ${error.expires} (now ${error.now})`;
    case "IssuedInFuture":
      return `the list is issued ${error.issued}, more than 24 hours after now (${error.now})`;
    case "OlderThanBuiltins":
      return `the list was issued ${error.issued}, before this release's builtin models (${error.builtinsIssued})`;
    case "NotNewer":
      return `the list was issued ${error.issued}, not later than the applied list (${error.appliedIssued})`;
  }
}

/** Format zod issues as `path: message` lines. */
export function formatModelRecommendationsIssues(
  error: z.ZodError,
): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Section selection
// ---------------------------------------------------------------------------

/** The section a harness uses, and where it came from. */
export interface SelectedRecommendationsSection {
  /** The harness's own section, or `default` when it has none. */
  readonly source: RecommendationsHarness | "default";
  readonly agents: ModelRecommendationsSection["agents"];
}

/**
 * Pick the section a harness uses: its own when the file has one, otherwise
 * `default`. A caller that passes no harness ID (OpenCode V1, Copilot CLI)
 * gets no recommendations at all.
 */
export function selectRecommendationsSection(
  file: ModelRecommendationsFile,
  harness: RecommendationsHarness | undefined,
): SelectedRecommendationsSection | undefined {
  if (harness === undefined) return undefined;
  const own = file.harnesses?.[harness];
  if (own !== undefined) return { source: harness, agents: own.agents };
  return { source: "default", agents: file.default.agents };
}

/** True when `value` names a harness that may carry its own section. */
export function isRecommendationsHarness(
  value: string,
): value is RecommendationsHarness {
  return (RECOMMENDATIONS_HARNESSES as readonly string[]).includes(value);
}
