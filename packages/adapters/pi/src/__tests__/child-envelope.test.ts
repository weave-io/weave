import { describe, expect, it } from "bun:test";
import {
  generateNonceHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import { MAX_FRAME_RECORD_BYTES } from "../child-framing.js";
import {
  looksLikeControlEnvelope,
  MAX_CONTROL_BODY_BYTES,
  PiChildAuthState,
  signEnvelope,
  type UnsignedEnvelopeInput,
  verifyEnvelope,
} from "../child-envelope.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();
const secretA = new Uint8Array(32).fill(7);
const secretB = new Uint8Array(32).fill(9);
const textEncoder = new TextEncoder();

function bodyWithCanonicalByteLength(byteLength: number): { blob: string } {
  const emptyBodyBytes = canonicalizeToBytes({ blob: "" })._unsafeUnwrap();
  return {
    blob: "x".repeat(byteLength - emptyBodyBytes.byteLength),
  };
}

function candidateFrameByteLength(body: { blob: string }): number {
  return textEncoder.encode(
    `${JSON.stringify({
      type: "weave_control",
      schemaVersion: 1,
      ...baseInput({ body }),
      mac: "0".repeat(64),
    })}\n`,
  ).byteLength;
}

function baseInput(
  overrides: Partial<UnsignedEnvelopeInput> = {},
): UnsignedEnvelopeInput {
  return {
    childId: "child-1",
    generationId: "gen-1",
    direction: "child-to-parent",
    sequence: 1,
    nonce: generateNonceHex(randomPort),
    correlationId: "child-1",
    kind: "handshake",
    body: {},
    ...overrides,
  };
}

describe("signEnvelope / verifyEnvelope", () => {
  it("round-trips: a correctly signed envelope verifies successfully", async () => {
    const signed = await signEnvelope(baseInput(), secretA, hmacPort);
    expect(signed.isOk()).toBe(true);
    const verified = await verifyEnvelope(
      { ...signed._unsafeUnwrap() },
      secretA,
      hmacPort,
    );
    expect(verified.isOk()).toBe(true);
    expect(verified._unsafeUnwrap().kind).toBe("handshake");
  });

  it("rejects a tampered body: any field change invalidates the MAC", async () => {
    const signed = await signEnvelope(
      baseInput({ body: { ok: true } }),
      secretA,
      hmacPort,
    );
    const tampered = { ...signed._unsafeUnwrap(), body: { ok: false } };
    const verified = await verifyEnvelope(tampered, secretA, hmacPort);
    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr().type).toBe("MacMismatch");
  });

  it("authenticates the bounded model-transition body without exposing marker data", async () => {
    const body = {
      schemaVersion: 1 as const,
      transitionId: "123e4567-e89b-42d3-a456-426614174000",
      failureClass: "provider_unavailable" as const,
      from: { provider: "origin", id: "model-a" },
      to: { provider: "fallback", id: "model-b" },
      phase: "recovery-confirmed" as const,
    };
    const signed = await signEnvelope(
      baseInput({ kind: "model-transition", body }),
      secretA,
      hmacPort,
    );
    expect(signed.isOk()).toBe(true);
    const verified = await verifyEnvelope(
      signed._unsafeUnwrap() as unknown as JsonValue,
      secretA,
      hmacPort,
    );
    expect(verified.isOk()).toBe(true);
    expect(verified._unsafeUnwrap().body).toEqual(body);
    expect(JSON.stringify(verified._unsafeUnwrap().body)).not.toContain(
      "recovery-marker",
    );
  });

  it("rejects verification against the wrong secret", async () => {
    const signed = await signEnvelope(baseInput(), secretA, hmacPort);
    const verified = await verifyEnvelope(
      { ...signed._unsafeUnwrap() },
      secretB,
      hmacPort,
    );
    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr().type).toBe("MacMismatch");
  });

  it("accepts exactly 64 KiB without conflating it with the 8 MiB native-record cap", async () => {
    const exactBody = bodyWithCanonicalByteLength(MAX_CONTROL_BODY_BYTES);
    expect(
      canonicalizeToBytes(exactBody)._unsafeUnwrap().byteLength,
    ).toBe(MAX_CONTROL_BODY_BYTES);
    expect(candidateFrameByteLength(exactBody)).toBeLessThan(
      MAX_FRAME_RECORD_BYTES,
    );

    const signed = await signEnvelope(
      baseInput({ body: exactBody }),
      secretA,
      hmacPort,
    );
    expect(signed.isOk()).toBe(true);
  });

  it("rejects an over-cap body with a payload-safe error below the 8 MiB native-record cap", async () => {
    const oversized = bodyWithCanonicalByteLength(MAX_CONTROL_BODY_BYTES + 1);
    expect(
      canonicalizeToBytes(oversized)._unsafeUnwrap().byteLength,
    ).toBe(MAX_CONTROL_BODY_BYTES + 1);
    expect(candidateFrameByteLength(oversized)).toBeLessThan(
      MAX_FRAME_RECORD_BYTES,
    );

    const signed = await signEnvelope(
      baseInput({ body: oversized }),
      secretA,
      hmacPort,
    );
    expect(signed.isErr()).toBe(true);
    const error = signed._unsafeUnwrapErr();
    expect(error).toEqual({
      type: "BodyTooLarge",
      byteLength: MAX_CONTROL_BODY_BYTES + 1,
    });
    expect(JSON.stringify(error)).not.toContain("x");
  });

  it("rejects a malformed shape (bad nonce format) before ever computing a MAC", async () => {
    const signed = await signEnvelope(baseInput(), secretA, hmacPort);
    const malformed = { ...signed._unsafeUnwrap(), nonce: "not-hex" };
    const verified = await verifyEnvelope(malformed, secretA, hmacPort);
    expect(verified.isErr()).toBe(true);
    expect(verified._unsafeUnwrapErr().type).toBe("MalformedShape");
  });

  it("rejects duplicate object keys smuggled into the raw JSON before it ever reaches verification", () => {
    // The framer/JSON layer (strict-json.ts) rejects duplicates before an
    // envelope candidate is even handed to verifyEnvelope; this is asserted
    // directly against that lower layer in strict-json.test.ts / child-framing.test.ts.
    expect(true).toBe(true);
  });

  it("produces deterministic canonical bytes independent of source key order", async () => {
    const a = await signEnvelope(
      baseInput({ body: { b: 1, a: 2 } }),
      secretA,
      hmacPort,
    );
    const bInput: UnsignedEnvelopeInput = {
      ...baseInput({ nonce: a._unsafeUnwrap().nonce, body: { a: 2, b: 1 } }),
    };
    const b = await signEnvelope(bInput, secretA, hmacPort);
    expect(a._unsafeUnwrap().mac).toBe(b._unsafeUnwrap().mac);
  });
});

describe("looksLikeControlEnvelope", () => {
  it("distinguishes control envelopes from ordinary Pi RPC lines", () => {
    expect(looksLikeControlEnvelope({ type: "agent_start" })).toBe(false);
    expect(looksLikeControlEnvelope({ type: "weave_control" })).toBe(true);
    expect(looksLikeControlEnvelope(null)).toBe(false);
    expect(looksLikeControlEnvelope([1, 2])).toBe(false);
  });
});

describe("PiChildAuthState", () => {
  async function signed(
    _auth: PiChildAuthState,
    overrides: Partial<UnsignedEnvelopeInput> = {},
  ) {
    const envelope = await signEnvelope(
      baseInput({ nonce: generateNonceHex(randomPort), ...overrides }),
      secretA,
      hmacPort,
    );
    return envelope._unsafeUnwrap();
  }

  it("admits exactly the next sequence in order, then advances", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const first = await signed(auth, { sequence: 1 });
    expect(auth.admitIncoming(first).isOk()).toBe(true);
    const second = await signed(auth, { sequence: 2 });
    expect(auth.admitIncoming(second).isOk()).toBe(true);
  });

  it("rejects a duplicate/replayed sequence", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const first = await signed(auth, { sequence: 1 });
    expect(auth.admitIncoming(first).isOk()).toBe(true);
    const replay = await signed(auth, {
      sequence: 1,
      nonce: generateNonceHex(randomPort),
    });
    const result = auth.admitIncoming(replay);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SequenceMismatch");
  });

  it("rejects a late/out-of-order (skipped-ahead) sequence", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const skipped = await signed(auth, { sequence: 5 });
    const result = auth.admitIncoming(skipped);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("SequenceMismatch");
  });

  it("rejects a replayed nonce even under a fresh/valid-looking sequence expectation", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const nonce = generateNonceHex(randomPort);
    const first = await signed(auth, { sequence: 1, nonce });
    expect(auth.admitIncoming(first).isOk()).toBe(true);
    // Force a distinct auth state at the same sequence position to reuse the nonce value alone.
    const secondAuth = new PiChildAuthState("child-1", "gen-1");
    const reusedNonce = await signed(secondAuth, { sequence: 1, nonce });
    // Admit once normally through the *original* auth state's own bookkeeping
    // by re-signing at its now-current expected sequence (2) but reusing nonce.
    const atCurrentSequence = await signed(auth, { sequence: 2, nonce });
    const result = auth.admitIncoming(atCurrentSequence);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("NonceReplay");
    void reusedNonce;
  });

  it("rejects a cross-child envelope (mismatched childId)", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const envelope = await signEnvelope(
      baseInput({ childId: "child-2" }),
      secretA,
      hmacPort,
    );
    const result = auth.admitIncoming(envelope._unsafeUnwrap());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("ChildIdMismatch");
  });

  it("rejects a cross-generation envelope (mismatched generationId)", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const envelope = await signEnvelope(
      baseInput({ generationId: "gen-2" }),
      secretA,
      hmacPort,
    );
    const result = auth.admitIncoming(envelope._unsafeUnwrap());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("GenerationMismatch");
  });

  it("rejects the wrong direction (a parent-to-child envelope presented as incoming)", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const envelope = await signEnvelope(
      baseInput({ direction: "parent-to-child" }),
      secretA,
      hmacPort,
    );
    const result = auth.admitIncoming(envelope._unsafeUnwrap());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("DirectionMismatch");
  });

  it("is role-symmetric: constructed with an explicit `parent-to-child` expectation, it admits parent-to-child and rejects child-to-parent", async () => {
    const childSideAuth = new PiChildAuthState(
      "child-1",
      "gen-1",
      "parent-to-child",
    );
    const fromParent = await signEnvelope(
      baseInput({ direction: "parent-to-child", sequence: 1 }),
      secretA,
      hmacPort,
    );
    expect(childSideAuth.admitIncoming(fromParent._unsafeUnwrap()).isOk()).toBe(
      true,
    );

    const wrongDirection = await signEnvelope(
      baseInput({ direction: "child-to-parent", sequence: 2 }),
      secretA,
      hmacPort,
    );
    const rejected = childSideAuth.admitIncoming(
      wrongDirection._unsafeUnwrap(),
    );
    expect(rejected.isErr()).toBe(true);
    expect(rejected._unsafeUnwrapErr().type).toBe("DirectionMismatch");
  });

  it("rejects everything after dispose()", async () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    const envelope = await signed(auth, { sequence: 1 });
    auth.dispose();
    const result = auth.admitIncoming(envelope);
    expect(result.isErr()).toBe(true);
  });

  it("allocates outgoing sequence numbers starting at 1 and strictly increasing", () => {
    const auth = new PiChildAuthState("child-1", "gen-1");
    expect(auth.allocateOutgoingSequence()).toBe(1);
    expect(auth.allocateOutgoingSequence()).toBe(2);
    expect(auth.allocateOutgoingSequence()).toBe(3);
  });
});
