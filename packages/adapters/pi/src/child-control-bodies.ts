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
import { ThinkingLevelSchema } from "@weaveio/weave-core";
import { z } from "zod";
import {
  MAX_CONTROL_BODY_BYTES,
  type PiControlKind,
} from "./child-envelope.js";
import { canonicalizeToBytes, type JsonValue } from "./strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "./structured-completion.js";

export const MAX_NAME_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 8_192;
export const MAX_SETTLEMENT_OUTPUT_BYTES = 4_096;
const MAX_REASON_LENGTH = 2_000;
const boundedSettlementOutput = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_SETTLEMENT_OUTPUT_BYTES,
    `must be at most ${MAX_SETTLEMENT_OUTPUT_BYTES} UTF-8 bytes`,
  );
const MAX_MODELS = 32;
const MAX_DELEGATION_TARGETS = 9;
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

const DelegationTriggerSchema = z
  .string()
  .max(MAX_NAME_LENGTH)
  .refine((value) => value.trim().length > 0, "must not be blank");

const DelegationTargetBodySchema = z
  .object({
    name: NameSchema,
    description: z.string().max(1_024).optional(),
    triggers: z.array(DelegationTriggerSchema).max(MAX_DELEGATION_TRIGGERS),
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
const BootstrapCommonShape = {
  agentName: NameSchema,
  composedPrompt: z.string().max(MAX_COMPOSED_PROMPT_LENGTH),
  models: z.array(z.string().max(MAX_NAME_LENGTH)).max(MAX_MODELS),
  delegationTargets: z
    .array(DelegationTargetBodySchema)
    .max(MAX_DELEGATION_TARGETS)
    .optional(),
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
    ...BootstrapCommonShape,
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
    ...BootstrapCommonShape,
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

const CancelBodySchema = z
  .object({ reason: z.string().max(MAX_REASON_LENGTH) })
  .strict();

const SettledBodySchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      assistantOutput: boundedSettlementOutput.optional(),
      completionCandidate: boundedSettlementOutput.optional(),
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
      reason: z.string().max(MAX_SUMMARY_LENGTH).optional(),
    })
    .strict(),
]);

const ErrorBodySchema = z
  .object({ reason: z.string().max(MAX_REASON_LENGTH) })
  .strict();

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
      reason: z.string().max(MAX_SUMMARY_LENGTH),
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

/**
 * Validates `body` against the strict, bounded schema for `kind`. Never
 * throws; a body carrying extra fields, wrong types, out-of-range lengths,
 * or an unrecognized discriminant is rejected outright (Pi adapter contract) -
 * this is the sole parsing path every control-body consumer (parent- and
 * child-side) MUST use instead of ad hoc unsafe field reads/casts.
 */
type SafeJsonCopy =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };

const MAX_SAFE_GRAPH_DEPTH = 64;
const MAX_SAFE_GRAPH_NODES = 4_096;
const MAX_SAFE_GRAPH_PROPERTIES = 4_096;
const MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT = 512;
// Delegate requests may carry larger tasks that are chunked by the transport;
// keep this graph-copy bound independent of the bootstrap wire-byte limit. The
// bootstrap canonicalization check below still enforces MAX_CONTROL_BODY_BYTES.
const MAX_SAFE_GRAPH_STRING_LENGTH = 256 * 1024;
const MAX_SAFE_GRAPH_ARRAY_LENGTH = 512;

interface SafeJsonGraphBudget {
  nodesRemaining: number;
  propertiesRemaining: number;
  stringUnitsRemaining: number;
}

function consumeSafeGraphNode(budget: SafeJsonGraphBudget): boolean {
  if (budget.nodesRemaining === 0) return false;
  budget.nodesRemaining -= 1;
  return true;
}

function consumeSafeGraphString(
  value: string,
  budget: SafeJsonGraphBudget,
): boolean {
  if (
    value.length > MAX_SAFE_GRAPH_STRING_LENGTH ||
    value.length > budget.stringUnitsRemaining
  ) {
    return false;
  }
  budget.stringUnitsRemaining -= value.length;
  return true;
}

function consumeSafeGraphProperties(
  count: number,
  budget: SafeJsonGraphBudget,
): boolean {
  if (count > budget.propertiesRemaining) return false;
  budget.propertiesRemaining -= count;
  return true;
}

function copySafeJsonGraph(
  value: unknown,
  active: WeakSet<object> = new WeakSet<object>(),
  budget: SafeJsonGraphBudget = {
    nodesRemaining: MAX_SAFE_GRAPH_NODES,
    propertiesRemaining: MAX_SAFE_GRAPH_PROPERTIES,
    stringUnitsRemaining: MAX_SAFE_GRAPH_STRING_LENGTH,
  },
  depth = 0,
): SafeJsonCopy {
  try {
    if (depth > MAX_SAFE_GRAPH_DEPTH || !consumeSafeGraphNode(budget)) {
      return { ok: false };
    }
    if (value === null) return { ok: true, value: null };
    if (typeof value === "string") {
      return consumeSafeGraphString(value, budget)
        ? { ok: true, value }
        : { ok: false };
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return { ok: true, value };
    }
    if (typeof value !== "object" || active.has(value)) {
      return { ok: false };
    }

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      return { ok: false };
    }

    active.add(value);
    try {
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          value,
          "length",
        );
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > MAX_SAFE_GRAPH_ARRAY_LENGTH ||
          lengthDescriptor.enumerable !== false ||
          lengthDescriptor.configurable !== false ||
          lengthDescriptor.writable !== true
        ) {
          return { ok: false };
        }
        const length = lengthDescriptor.value;
        const ownKeys = Reflect.ownKeys(value);
        if (
          ownKeys.length !== length + 1 ||
          !consumeSafeGraphProperties(ownKeys.length, budget)
        ) {
          return { ok: false };
        }
        const copy: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          if (ownKeys[index] !== key) return { ok: false };
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.configurable !== true ||
            descriptor.writable !== true
          ) {
            return { ok: false };
          }
          const copied = copySafeJsonGraph(
            descriptor.value,
            active,
            budget,
            depth + 1,
          );
          if (!copied.ok) return copied;
          copy.push(copied.value);
        }
        if (ownKeys[length] !== "length") return { ok: false };
        return { ok: true, value: copy };
      }

      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length > MAX_SAFE_GRAPH_PROPERTIES_PER_OBJECT ||
        !consumeSafeGraphProperties(ownKeys.length, budget)
      ) {
        return { ok: false };
      }
      const copy: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      for (const key of ownKeys) {
        if (typeof key !== "string" || !consumeSafeGraphString(key, budget)) {
          return { ok: false };
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true ||
          descriptor.configurable !== true ||
          descriptor.writable !== true
        ) {
          return { ok: false };
        }
        const copied = copySafeJsonGraph(
          descriptor.value,
          active,
          budget,
          depth + 1,
        );
        if (!copied.ok) return copied;
        Object.defineProperty(copy, key, {
          value: copied.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return { ok: true, value: copy };
    } finally {
      active.delete(value);
    }
  } catch {
    return { ok: false };
  }
}

export function parseControlBody<K extends PiControlKind>(
  kind: K,
  body: unknown,
): { ok: true; value: ControlBodyFor<K> } | { ok: false; issueCount: number } {
  const copied = copySafeJsonGraph(body);
  if (!copied.ok) return { ok: false, issueCount: 1 };

  // Incoming envelopes already enforce this bound during authentication. Keep
  // the same bound at the direct parser boundary so tests and internal callers
  // cannot validate a bootstrap body that the authenticated transport would
  // reject later.
  if (kind === "bootstrap") {
    const canonical = canonicalizeToBytes(copied.value);
    if (
      canonical.isErr() ||
      canonical.value.byteLength > MAX_CONTROL_BODY_BYTES
    ) {
      return { ok: false, issueCount: 1 };
    }
  }

  const schema = CONTROL_BODY_SCHEMAS[kind];
  const parsed = schema.safeParse(copied.value);
  if (!parsed.success) {
    return { ok: false, issueCount: parsed.error.issues.length };
  }
  return { ok: true, value: parsed.data as ControlBodyFor<K> };
}
