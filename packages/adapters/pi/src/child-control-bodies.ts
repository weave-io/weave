/**
 * Strict, bounded Zod schemas for every private control envelope body kind
 * (Pi adapter contract). Replaces ad hoc `unknown`/manual-field-read parsing of
 * envelope bodies with real schema validation: every field is bounded in
 * length/count, every shape is closed (`.strict()`), and every discriminated
 * body (e.g. `settled`, `delegate-response`) is validated as a genuine
 * discriminated union rather than read field-by-field with silent
 * fallbacks. A body that fails its schema is always a typed, fail-closed
 * `ControlBodyValidationError` - never a best-effort partial read.
 */
import {
  copySafeGraph,
  type SafeGraphCopyBudget,
  ThinkingLevelSchema,
} from "@weaveio/weave-core";
import { z } from "zod";
import {
  fitsDiagnosticBudget,
  MAX_DIAGNOSTIC_REASON_BYTES,
  MAX_DIAGNOSTIC_SERIALIZED_BYTES,
  projectDiagnosticText,
} from "./child-diagnostic-projection.js";
import {
  MAX_CONTROL_BODY_BYTES,
  type PiControlKind,
} from "./child-envelope.js";
import { PI_TRANSPORT_LIMITS } from "./errors.js";
import { canonicalizeToBytes } from "./strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "./structured-completion.js";

export const MAX_NAME_LENGTH = 256;
/**
 * The inline diagnostic prose budget, re-exported under its historical name.
 * The policy itself lives in `child-diagnostic-projection.ts`, which every
 * diagnostic producer shares.
 */
export const MAX_FAILURE_REASON_BYTES = MAX_DIAGNOSTIC_REASON_BYTES;
/**
 * The serialized half of the same policy, re-exported for callers that need
 * to reason about how much of the 64 KiB control body a reason can consume.
 */
export const MAX_FAILURE_REASON_SERIALIZED_BYTES =
  MAX_DIAGNOSTIC_SERIALIZED_BYTES;
export const MAX_SETTLEMENT_OUTPUT_BYTES = 4_096;

/**
 * Diagnostic prose on the wire. Producers project first, so this admits the
 * projected value instead of rejecting a body over its display text - which
 * would discard the typed code the body carries.
 *
 * Applies to the settlement failure reason and to the protocol `cancel` and
 * `error` reasons alike. Those two were capped at 2,000 UTF-16 characters,
 * which rejected ordinary prose outright instead of shortening it, and which
 * counted characters where the framing ceilings count bytes.
 *
 * Both halves of the shared policy are enforced here. The source cap alone
 * is not enough: a 32 KiB reason of C0 control bytes canonicalizes to 192 KiB
 * of `\u00XX` escapes, so a body that passed a source-only check would still
 * fail closed at signing time with `BodyTooLarge` and destroy the typed code
 * it was carrying.
 */
const boundedDiagnosticReason = z
  .string()
  .refine(
    (value) => fitsDiagnosticBudget(value),
    `must be at most ${MAX_DIAGNOSTIC_REASON_BYTES} source UTF-8 bytes and ${MAX_DIAGNOSTIC_SERIALIZED_BYTES} JSON-serialized UTF-8 bytes`,
  );
const boundedFailureReason = boundedDiagnosticReason;
const boundedProtocolReason = boundedDiagnosticReason;
const boundedSettlementOutput = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_SETTLEMENT_OUTPUT_BYTES,
    `must be at most ${MAX_SETTLEMENT_OUTPUT_BYTES} UTF-8 bytes`,
  );
const MAX_MODELS = 32;
export const MAX_DELEGATION_TARGETS = 64;
export const MAX_DELEGATION_TRIGGERS = 64;
/** Bounds the bootstrap `context.cwd` field - a real filesystem path, not name-length text. */
export const MAX_CWD_LENGTH = 4_096;
/** Bounds `context.parentDepth` - mirrors Pi adapter contract's own depth-limit universe generously; a value outside this is always malformed, never a legitimate deep tree. */
const MAX_PARENT_DEPTH = 64;
// `composedPrompt` is by far the largest field in any control body, and is
// the one field in this file that previously had no explicit bound of its
// own (unlike every other string field here). Every control body - the
// entire bootstrap body, not just this one field - must already fit under
// the envelope's own `MAX_CONTROL_BODY_BYTES` (64KiB) cap enforced at
// canonicalization time (Pi adapter contract), so an unbounded string field
// was never actually able to smuggle unbounded data through - but it did
// mean a bootstrap body could consume nearly the *entire* 64KiB budget on
// `composedPrompt` alone, starving the other bootstrap fields of room and
// turning what should be an explicit, schema-level bound into an accidental
// one discovered only at the transport layer. Half of the byte budget,
// expressed conservatively in UTF-16 code units (so it's also a safe bound
// on UTF-8 byte length even for encodings that expand, e.g. up to 4 bytes
// per surrogate pair), leaves the rest of the envelope's byte budget for
// every other bootstrap field plus JSON structural overhead.
const MAX_COMPOSED_PROMPT_LENGTH = MAX_CONTROL_BODY_BYTES / 2;

const NameSchema = z.string().min(1).max(MAX_NAME_LENGTH);
const EmptyBodySchema = z.object({}).strict();

/** One trigger is an exact, nonblank guidance string. There is no structure. */
const TriggerTextSchema = z
  .string()
  .max(MAX_NAME_LENGTH)
  .refine((value) => value.trim().length > 0, "must not be blank");

const DelegationTargetBodySchema = z
  .object({
    name: NameSchema,
    description: z.string().max(1_024).optional(),
    triggers: z.array(TriggerTextSchema).max(MAX_DELEGATION_TRIGGERS),
    isCategory: z.boolean(),
  })
  .strict();

/**
 * A resolved, concrete Pi model identity (Pi adapter contract) -
 * never an intent string to be re-resolved. Carried in `bootstrap` only
 * when the parent itself resolved the descriptor's model intent against
 * its own authenticated catalog (root-level delegation, where a live
 * `ctx.modelRegistry` is available at tool-execute time); omitted for
 * nested/relayed delegation, where the child must resolve against its own
 * authenticated catalog instead and echo back what it actually applied.
 */
const ModelIdentityBodySchema = z
  .object({
    provider: NameSchema,
    id: NameSchema,
    name: NameSchema.optional(),
  })
  .strict();

/**
 * A minimal host-supplied model identity: exactly the fields
 * {@link ModelIdentityBodySchema} accepts. Any real harness model object
 * (`ctx.model`, an entry from `ctx.modelRegistry.getAvailable()`, or a
 * `PiModelResolver` match drawn from either) may legitimately carry
 * additional runtime fields beyond `provider`/`id`/`name` - context window
 * sizes, pricing, capability flags, etc. - since `PiModelInfo` is a
 * structural TypeScript interface, not a runtime guarantee that no other
 * field exists on the object.
 */
export interface HostModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/**
 * Projects a host-supplied model object down to exactly the fields
 * {@link ModelIdentityBodySchema}'s `.strict()` shape allows (Pi adapter contract
 *). Every call site that places a resolved/applied model
 * identity into a `bootstrap` or `bootstrap-ack` control body MUST route
 * it through this function first - passing the raw host object directly
 * fails closed at `parseControlBody`/`runTask`'s own re-validation
 * (`bootstrap-body-invalid`) the instant the host object carries any
 * field beyond `provider`/`id`/`name`.
 */
export function toModelIdentityBody(
  model: HostModelIdentity,
): PiModelIdentityBody {
  return model.name === undefined
    ? { provider: model.provider, id: model.id }
    : { provider: model.provider, id: model.id, name: model.name };
}

/**
 * The bounded, non-secret delegation context carried in `bootstrap` (Spec
 * 33): who is delegating, at what depth, and in what project
 * directory. Every field here is operational metadata already visible
 * elsewhere in this transport (env vars, spawn input) - never a secret, raw
 * RPC payload, or private value.
 */
const TaskContextBodySchema = z
  .object({
    parentAgentName: NameSchema,
    parentDepth: z.number().int().min(0).max(MAX_PARENT_DEPTH),
    cwd: z.string().min(1).max(MAX_CWD_LENGTH),
  })
  .strict();

/**
 * Fields shared by every bootstrap variant (Pi adapter contract and
 * direct-step dispatch). `mode` is the required discriminant: `"ordinary"`
 * for delegation-spawned children (weave_delegate / relayed nested
 * delegation), `"direct-step"` for a workflow-step child spawned directly
 * by `PiWorkflowController` (never through the ordinary delegation budget
 * or queue). The two variants are validated as a strict discriminated
 * union so a direct-step bootstrap sent to a schema expecting the ordinary
 * shape (or vice versa) fails closed at parse time rather than silently
 * dropping unrecognised fields.
 */
const BootstrapCommonFields = {
  agentName: NameSchema,
  composedPrompt: z.string().max(MAX_COMPOSED_PROMPT_LENGTH),
  models: z.array(z.string().max(MAX_NAME_LENGTH)).max(MAX_MODELS),
  /** Legacy bounded hint. The authenticated parent remains target authority. */
  delegationTargets: z.array(DelegationTargetBodySchema).max(64).optional(),
  /** The task/child correlation id (Pi adapter contract) - the child must reject bootstrap whose `correlationId` does not match its own env-derived child id. */
  correlationId: NameSchema,
  context: TaskContextBodySchema,
  /** Present only when the parent itself resolved a concrete model identity (Pi adapter contract); absent means the child must resolve against its own authenticated catalog. */
  resolvedModel: ModelIdentityBodySchema.optional(),
  /** Literal provider-acceleration intent. Omission preserves the provider default. */
  fast: z.literal(true).optional(),
  /** The core-owned model thinking intent selected alongside `resolvedModel`, when one was requested. */
  thinkingLevel: ThinkingLevelSchema.optional(),
} as const;

const OrdinaryBootstrapBodySchema = z
  .object({
    mode: z.literal("ordinary"),
    ...BootstrapCommonFields,
  })
  .strict();

/**
 * Direct-step bootstrap (Pi adapter contract): additionally carries the
 * workflow instance/lease/step correlation the child needs to call the
 * `weave_complete_step` tool the parent registers ONLY for this mode, and
 * `completionTool` as a literal so the child can verify the parent's own
 * declared completion-tool name matches the tool it actually receives.
 * Nested helpers spawned BY a direct-step child never receive this shape -
 * they always go through `buildChildBootstrapBody`'s ordinary path, so
 * completion authority never propagates below the root direct-step child
 * (Pi adapter contract "Nested helper children do NOT receive workflow completion
 * authority").
 */
const DirectStepBootstrapBodySchema = z
  .object({
    mode: z.literal("direct-step"),
    ...BootstrapCommonFields,
    workflowInstanceId: NameSchema,
    leaseId: NameSchema,
    stepName: NameSchema,
    completionTool: z.literal(WEAVE_COMPLETE_STEP_TOOL_NAME),
  })
  .strict();

const BootstrapBodySchema = z.discriminatedUnion("mode", [
  OrdinaryBootstrapBodySchema,
  DirectStepBootstrapBodySchema,
]);

/** The child's authenticated proof that bootstrap applied successfully. */
const BootstrapAckBodySchema = z
  .object({
    // Optional: present whenever a concrete model actually applies. Absent
    // only when the descriptor declared no resolvable model preference and
    // Pi's already-active model was correctly left untouched (Pi adapter contract
    //'s graceful degradation) - never absent because of a silently
    // swallowed *activation* failure, which fails the whole bootstrap
    // closed before an ack is ever sent (Pi adapter contract).
    resolvedModel: ModelIdentityBodySchema.optional(),
  })
  .strict();

const CancelBodySchema = z.object({ reason: boundedProtocolReason }).strict();

const SettledBodySchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      assistantOutput: boundedSettlementOutput.optional(),
      completionCandidate: boundedSettlementOutput.optional(),
      completionCandidateTransferred: z.boolean().optional(),
      outputTransferId: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
      outputByteLength: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024)
        .optional(),
      /** Count of accepted parent interventions; never text or history. */
      interventionCount: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      reason: boundedFailureReason.optional(),
    })
    .strict(),
]);

const ErrorBodySchema = z.object({ reason: boundedProtocolReason }).strict();

/** Builds a `cancel` body whose reason already fits the shared policy. */
export function makeCancelBody(reason: string) {
  const body = { reason: projectDiagnosticText(reason) } satisfies PiCancelBody;
  return body;
}

/** Builds an `error` body whose reason already fits the shared policy. */
export function makeErrorBody(reason: string) {
  const body = { reason: projectDiagnosticText(reason) } satisfies PiErrorBody;
  return body;
}

const DelegateRequestBodySchema = z
  .object({
    agentName: NameSchema,
    // Same bound as tool parsing, the controller, and RPC prompt send
    // Empty tasks are invalid, but task size is bounded only by the
    // transport framing/chunking layer.
    task: z.string().min(1),
  })
  .strict();

const DelegateRequestChunkBodySchema = z
  .object({
    agentName: NameSchema,
    transferId: z.string().min(1).max(256),
    index: z.number().int().nonnegative().max(65_535),
    total: z.number().int().positive().max(65_536),
    data: z.string().min(1).max(32_768),
  })
  .strict();

const DelegateResponseSettlementSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      assistantOutput: boundedSettlementOutput.optional(),
      completionCandidate: boundedSettlementOutput.optional(),
      completionCandidateTransferred: z.boolean().optional(),
      outputTransferId: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
      outputByteLength: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024)
        .optional(),
      interventionCount: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      reason: boundedFailureReason,
    })
    .strict(),
]);

const DelegateResponseBodySchema = z
  .object({
    ok: z.boolean(),
    settlement: DelegateResponseSettlementSchema.optional(),
    error: z.string().max(MAX_NAME_LENGTH).optional(),
  })
  .strict();

const TransferChunkBodySchema = z
  .object({
    channel: z.literal("output"),
    transferId: z.string().min(1).max(MAX_NAME_LENGTH),
    index: z.number().int().nonnegative().max(65_535),
    total: z.number().int().positive().max(65_536),
    data: z.string().min(1).max(32_768),
  })
  .strict();

const TransferChannelSchema = z.enum(["prompt", "output"]);
const TransferRejectionReasonSchema = z.enum([
  "invalid-transfer-id",
  "invalid-total",
  "invalid-index",
  "invalid-base64",
  "duplicate-index",
  "total-mismatch",
  "chunk-too-large",
  "aggregate-too-large",
  "too-many-transfers",
  "missing-index",
  "malformed-chunk",
]);

const TransferResultBodySchema = z.discriminatedUnion("status", [
  z
    .object({
      channel: TransferChannelSchema,
      transferId: z.string().min(1).max(MAX_NAME_LENGTH),
      status: z.literal("ack"),
    })
    .strict(),
  z
    .object({
      channel: TransferChannelSchema,
      transferId: z.string().min(1).max(MAX_NAME_LENGTH),
      status: z.literal("nack"),
      reason: TransferRejectionReasonSchema,
    })
    .strict(),
]);

const CONTROL_BODY_SCHEMAS = {
  handshake: EmptyBodySchema,
  bootstrap: BootstrapBodySchema,
  "bootstrap-ack": BootstrapAckBodySchema,
  cancel: CancelBodySchema,
  cancelled: EmptyBodySchema,
  settled: SettledBodySchema,
  error: ErrorBodySchema,
  "delegate-request": DelegateRequestBodySchema,
  "delegate-request-chunk": DelegateRequestChunkBodySchema,
  "delegate-response": DelegateResponseBodySchema,
  "transfer-chunk": TransferChunkBodySchema,
  "transfer-result": TransferResultBodySchema,
} as const satisfies Record<PiControlKind, z.ZodType>;

export type PiBootstrapBody = z.infer<typeof BootstrapBodySchema>;
export type PiOrdinaryBootstrapBody = z.infer<
  typeof OrdinaryBootstrapBodySchema
>;
export type PiDirectStepBootstrapBody = z.infer<
  typeof DirectStepBootstrapBodySchema
>;
export type PiBootstrapAckBody = z.infer<typeof BootstrapAckBodySchema>;
export type PiModelIdentityBody = z.infer<typeof ModelIdentityBodySchema>;
export type PiTaskContextBody = z.infer<typeof TaskContextBodySchema>;
export type PiCancelBody = z.infer<typeof CancelBodySchema>;
export type PiSettledBody = z.infer<typeof SettledBodySchema>;
export type PiErrorBody = z.infer<typeof ErrorBodySchema>;
export type PiDelegateRequestBody = z.infer<typeof DelegateRequestBodySchema>;
export type PiDelegateRequestChunkBody = z.infer<
  typeof DelegateRequestChunkBodySchema
>;
export type PiDelegateResponseBody = z.infer<typeof DelegateResponseBodySchema>;
export type PiTransferChunkBody = z.infer<typeof TransferChunkBodySchema>;
export type PiTransferResultBody = z.infer<typeof TransferResultBodySchema>;

/** A mapped type resolving the validated body shape for a given control kind. */
export type ControlBodyFor<K extends PiControlKind> = z.infer<
  (typeof CONTROL_BODY_SCHEMAS)[K]
>;

export type ControlBodyValidationError = {
  readonly type: "ControlBodyInvalid";
  readonly kind: PiControlKind;
  readonly issueCount: number;
};

type AnyControlBody = ControlBodyFor<PiControlKind>;
type ControlBodyParseResult =
  | { ok: true; value: AnyControlBody }
  | { ok: false; issueCount: number };

/**
 * Validates `body` against the strict, bounded schema for `kind`. Never
 * throws; a body carrying extra fields, wrong types, out-of-range lengths,
 * or an unrecognized discriminant is rejected outright (Pi adapter contract) -
 * this is the sole parsing path every control-body consumer (parent- and
 * child-side) MUST use instead of ad hoc unsafe field reads/casts.
 */
const JsonBodySchema = z.json();
const ControlBodyInputBoundary = z.preprocess((value) => value, JsonBodySchema);

const CONTROL_GRAPH_BUDGET = {
  maxDepth: 64,
  maxNodes: 4_096,
  maxProperties: 4_096,
  maxPropertiesPerObject: 512,
  maxArrayLength: 512,
  maxStringLength: 256 * 1024,
} satisfies SafeGraphCopyBudget;

const TRANSFER_GRAPH_BUDGET = {
  ...CONTROL_GRAPH_BUDGET,
  maxStringLength: PI_TRANSPORT_LIMITS.transferAggregateBytes,
} satisfies SafeGraphCopyBudget;

export function parseControlBody<K extends PiControlKind>(
  kind: K,
  body: z.input<typeof ControlBodyInputBoundary>,
): { ok: true; value: ControlBodyFor<K> } | { ok: false; issueCount: number };
export function parseControlBody(
  kind: PiControlKind,
  body: z.input<typeof ControlBodyInputBoundary>,
): ControlBodyParseResult {
  const copied = copySafeGraph(
    body,
    kind === "delegate-request" ? TRANSFER_GRAPH_BUDGET : CONTROL_GRAPH_BUDGET,
  );
  if (copied.isErr()) return { ok: false, issueCount: 1 };

  const json = JsonBodySchema.safeParse(copied.value);
  if (!json.success) return { ok: false, issueCount: 1 };

  // Incoming envelopes already enforce this bound during authentication. Keep
  // the same bound at the direct parser boundary so tests and internal callers
  // cannot validate a bootstrap body that the authenticated transport would
  // reject later.
  if (kind === "bootstrap") {
    const canonical = canonicalizeToBytes(json.data);
    if (
      canonical.isErr() ||
      canonical.value.byteLength > MAX_CONTROL_BODY_BYTES
    ) {
      return { ok: false, issueCount: 1 };
    }
  }

  const parsed = CONTROL_BODY_SCHEMAS[kind].safeParse(json.data);
  if (!parsed.success) {
    return { ok: false, issueCount: parsed.error.issues.length };
  }
  return { ok: true, value: parsed.data };
}
