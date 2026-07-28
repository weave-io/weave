/**
 * Authenticated private control envelopes exchanged between the controller
 * (parent) and a delegated RPC child (Pi adapter contract).
 *
 * These envelopes are a distinct, HMAC-authenticated private channel layered
 * on top of Pi's documented RPC protocol, not a replacement for it.
 * Parent-to-child envelopes are carried as the message text of an ordinary,
 * documented `prompt` RPC command invoking a private slash command;
 * child-to-parent envelopes are written by the child's loaded extension code
 * directly to its stdout, alongside Pi's event/response JSON lines. See
 * `rpc-child.ts` and `docs/adapters/pi.md` for the transport contract.
 *
 * Authenticated bootstrap, cancellation, settlement, and delegation remain
 * private envelopes. Native Pi `steer`, `follow_up`, and `get_entries`
 * commands, plus extension UI responses, are deliberately not envelope kinds:
 * they use Pi's native correlated RPC channel with lifecycle and identity
 * guards. Authentication keeps ordinary conversational content - including
 * content written by an injected prompt or compromised tool - from being
 * mistaken for a private control instruction.
 */
import { err, errAsync, ok, type Result, type ResultAsync } from "neverthrow";
import { z } from "zod";
import type { HmacPort } from "./child-crypto.js";
import {
  type CanonicalizeError,
  canonicalizeToBytes,
  type JsonValue,
} from "./strict-json.js";

export const CONTROL_ENVELOPE_TYPE_MARKER = "weave_control" as const;
export const CONTROL_ENVELOPE_SCHEMA_VERSION = 1 as const;

/**
 * Private signed control-body cap (Pi adapter contract).
 *
 * This limits the canonical JSON body before signing or verification. It is
 * separate from the 8 MiB native-record cap enforced by `child-framing.ts`.
 */
export const MAX_CONTROL_BODY_BYTES = 64 * 1024;

export type PiControlDirection = "parent-to-child" | "child-to-parent";

export const PI_CONTROL_KINDS = [
  "handshake",
  "bootstrap",
  "bootstrap-ack",
  "cancel",
  "cancelled",
  "settled",
  "error",
  // A child relays its own delegation request through its authenticated
  // parent/root coordinator (Pi adapter contract): nested delegation is never a
  // second, untracked budget - every descendant request travels this exact
  // control channel back to the one root-owned `PiDelegationController`.
  "delegate-request",
  "delegate-request-chunk",
  "delegate-response",
  "transfer-chunk",
  "transfer-result",
] as const;
export type PiControlKind = (typeof PI_CONTROL_KINDS)[number];

export interface PiControlEnvelope {
  readonly type: typeof CONTROL_ENVELOPE_TYPE_MARKER;
  readonly schemaVersion: typeof CONTROL_ENVELOPE_SCHEMA_VERSION;
  readonly childId: string;
  readonly generationId: string;
  readonly direction: PiControlDirection;
  readonly sequence: number;
  readonly nonce: string;
  readonly correlationId: string;
  readonly kind: PiControlKind;
  readonly body: JsonValue;
  readonly mac: string;
}

const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const MAC_PATTERN = /^[0-9a-f]{64}$/;

// `.strict()`: an envelope carrying any field beyond this exact closed set
// must be rejected outright, never silently stripped down to a
// coincidentally-valid subset by Zod's default "unknown keys are dropped"
// object behavior. A stripped-then-accepted envelope would let an attacker
// smuggle extra data past validation while still passing shape checks.
// Bounds are enforced on every field: `childId`/`generationId`/
// `correlationId` are non-empty and length-capped (never unbounded
// attacker-controlled strings); `sequence` is a bounded positive integer;
// `nonce`/`mac` are fixed-length lowercase hex.
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const IdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

const EnvelopeShapeSchema = z
  .object({
    type: z.literal(CONTROL_ENVELOPE_TYPE_MARKER),
    schemaVersion: z.literal(CONTROL_ENVELOPE_SCHEMA_VERSION),
    childId: IdentifierSchema,
    generationId: IdentifierSchema,
    direction: z.enum(["parent-to-child", "child-to-parent"]),
    sequence: z.number().int().positive().max(MAX_SEQUENCE),
    nonce: z.string().regex(NONCE_PATTERN),
    correlationId: IdentifierSchema,
    kind: z.enum(PI_CONTROL_KINDS),
    body: z.unknown(),
    mac: z.string().regex(MAC_PATTERN),
  })
  .strict();

export type EnvelopeError =
  | { readonly type: "BodyTooLarge"; readonly byteLength: number }
  | {
      readonly type: "CanonicalizeFailed";
      readonly reason: CanonicalizeError["type"];
    }
  | { readonly type: "SignFailed"; readonly reason: string }
  | { readonly type: "MalformedShape"; readonly issues: readonly string[] }
  | { readonly type: "MacMismatch" };

export interface UnsignedEnvelopeInput {
  readonly childId: string;
  readonly generationId: string;
  readonly direction: PiControlDirection;
  readonly sequence: number;
  readonly nonce: string;
  readonly correlationId: string;
  readonly kind: PiControlKind;
  readonly body: JsonValue;
}

function canonicalBytesForSigning(
  envelopeWithoutMac: UnsignedEnvelopeInput & {
    readonly type: typeof CONTROL_ENVELOPE_TYPE_MARKER;
    readonly schemaVersion: typeof CONTROL_ENVELOPE_SCHEMA_VERSION;
  },
): Result<Uint8Array, EnvelopeError> {
  const bodyBytes = canonicalizeToBytes(envelopeWithoutMac.body);
  if (bodyBytes.isErr()) {
    return err({ type: "CanonicalizeFailed", reason: bodyBytes.error.type });
  }
  if (bodyBytes.value.byteLength > MAX_CONTROL_BODY_BYTES) {
    return err({
      type: "BodyTooLarge",
      byteLength: bodyBytes.value.byteLength,
    });
  }
  const wholeBytes = canonicalizeToBytes(
    envelopeWithoutMac as unknown as JsonValue,
  );
  if (wholeBytes.isErr()) {
    return err({ type: "CanonicalizeFailed", reason: wholeBytes.error.type });
  }
  return ok(wholeBytes.value);
}

/** Builds and HMAC-signs a new envelope. `input.sequence`/`input.nonce` must already be freshly allocated by the caller. */
export function signEnvelope(
  input: UnsignedEnvelopeInput,
  secret: Uint8Array,
  hmac: HmacPort,
): ResultAsync<PiControlEnvelope, EnvelopeError> {
  const withoutMac = {
    type: CONTROL_ENVELOPE_TYPE_MARKER,
    schemaVersion: CONTROL_ENVELOPE_SCHEMA_VERSION,
    ...input,
  };
  const bytesResult = canonicalBytesForSigning(withoutMac);
  if (bytesResult.isErr()) return errAsync(bytesResult.error);
  return hmac
    .signHex(secret, bytesResult.value)
    .map((mac) => ({ ...withoutMac, mac }))
    .mapErr(
      (hmacError): EnvelopeError => ({
        type: "SignFailed",
        reason: hmacError.reason,
      }),
    );
}

/** Validates envelope shape, then verifies its HMAC using a timing-safe comparison. Never trusts an unsigned or mis-signed candidate. */
export function verifyEnvelope(
  candidate: JsonValue,
  secret: Uint8Array,
  hmac: HmacPort,
): ResultAsync<PiControlEnvelope, EnvelopeError> {
  const parsed = EnvelopeShapeSchema.safeParse(candidate);
  if (!parsed.success) {
    return errAsync({
      type: "MalformedShape",
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  const envelope = parsed.data as PiControlEnvelope;
  const { mac, ...withoutMac } = envelope;
  const bytesResult = canonicalBytesForSigning(withoutMac);
  if (bytesResult.isErr()) return errAsync(bytesResult.error);
  // Verification uses the HMAC port's own constant-time `verifyHex`
  // primitive (backed by `crypto.subtle.verify` in production) rather than
  // recomputing a MAC in adapter code and comparing hex strings here.
  return hmac
    .verifyHex(secret, bytesResult.value, mac)
    .mapErr(
      (hmacError): EnvelopeError => ({
        type: "SignFailed",
        reason: hmacError.reason,
      }),
    )
    .andThen((matches): Result<PiControlEnvelope, EnvelopeError> => {
      if (!matches) return err({ type: "MacMismatch" });
      return ok(envelope);
    });
}

/** Structural pre-check: does `candidate` look like one of our control envelopes (vs. an ordinary Pi RPC event/response line)? */
export function looksLikeControlEnvelope(candidate: JsonValue): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    (candidate as { type?: unknown }).type === CONTROL_ENVELOPE_TYPE_MARKER
  );
}

export type AuthStateError =
  | { readonly type: "ChildIdMismatch" }
  | { readonly type: "GenerationMismatch" }
  | { readonly type: "DirectionMismatch" }
  | {
      readonly type: "SequenceMismatch";
      readonly expectedSequence: number;
      readonly actualSequence: number;
    }
  | { readonly type: "NonceReplay" };

/**
 * Per-child sequence/nonce bookkeeping. Enforces that only the exact next
 * sequence number in the `child-to-parent` direction is admitted (both
 * late/replayed and out-of-order/future messages are rejected) and that no
 * nonce is ever accepted twice (Pi adapter contract).
 */
export class PiChildAuthState {
  private nextIncomingSequence = 1;
  private nextOutgoingSequence = 1;
  private readonly seenIncomingNonces = new Set<string>();
  private disposed = false;
  private readonly expectedIncomingDirection: PiControlDirection;

  /**
   * This class is symmetric: the parent's own `PiRpcChild` constructs one
   * expecting incoming `child-to-parent` envelopes (the default, preserving
   * every existing call site), while a child's own `PiChildRuntime`
   * constructs one expecting incoming `parent-to-child` envelopes. Passing
   * the wrong expectation for a given role would silently reject every
   * legitimate message as a `DirectionMismatch`.
   */
  constructor(
    private readonly childId: string,
    private readonly generationId: string,
    expectedIncomingDirection: PiControlDirection = "child-to-parent",
  ) {
    this.expectedIncomingDirection = expectedIncomingDirection;
  }

  /** Allocates the next outgoing sequence number (the direction opposite `expectedIncomingDirection`). */
  allocateOutgoingSequence(): number {
    const sequence = this.nextOutgoingSequence;
    this.nextOutgoingSequence += 1;
    return sequence;
  }

  /**
   * Returns a failed outbound allocation to the sequence stream. Callers must
   * serialize allocation and output so a later sequence cannot be in flight.
   */
  releaseOutgoingSequence(sequence: number): void {
    if (this.nextOutgoingSequence === sequence + 1) {
      this.nextOutgoingSequence = sequence;
    }
  }

  /** Validates and (on success) consumes an authenticated envelope received from the counterparty. */
  admitIncoming(envelope: PiControlEnvelope): Result<void, AuthStateError> {
    if (this.disposed) return err({ type: "ChildIdMismatch" });
    if (envelope.childId !== this.childId)
      return err({ type: "ChildIdMismatch" });
    if (envelope.generationId !== this.generationId)
      return err({ type: "GenerationMismatch" });
    if (envelope.direction !== this.expectedIncomingDirection)
      return err({ type: "DirectionMismatch" });
    if (envelope.sequence !== this.nextIncomingSequence) {
      return err({
        type: "SequenceMismatch",
        expectedSequence: this.nextIncomingSequence,
        actualSequence: envelope.sequence,
      });
    }
    if (this.seenIncomingNonces.has(envelope.nonce))
      return err({ type: "NonceReplay" });
    this.seenIncomingNonces.add(envelope.nonce);
    this.nextIncomingSequence += 1;
    return ok(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.seenIncomingNonces.clear();
  }
}
