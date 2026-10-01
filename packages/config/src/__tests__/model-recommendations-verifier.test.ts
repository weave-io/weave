import { beforeAll, describe, expect, it } from "bun:test";
import { BUILTIN_MODELS_ISSUED } from "../builtins.js";
import {
  describeModelRecommendationsError,
  type ModelRecommendationsError,
} from "../model-recommendations.js";
import { MODEL_RECOMMENDATIONS_PUBLIC_KEYS } from "../model-recommendations-keys.js";
import {
  encodeBase64,
  ModelRecommendationsVerifier,
  signModelRecommendations,
} from "../model-recommendations-verifier.js";

/** A throwaway key pair, made for this test run only. */
interface TestKeys {
  publicKey: string;
  privateKey: string;
}

async function generateKeys(): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    publicKey: encodeBase64(new Uint8Array(raw)),
    privateKey: encodeBase64(new Uint8Array(pkcs8)),
  };
}

const NOW = new Date("2026-10-02T12:00:00Z");

function list(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: 1,
      channel: "stable",
      issued: "2026-10-01T09:00:00Z",
      expires: "2026-12-30T09:00:00Z",
      min_config_version: "0.2.0",
      evidence: "https://tryweave.io/evals/runs/run-1",
      default: { agents: { loom: { models: ["claude-opus-5.5"] } } },
      ...overrides,
    },
    null,
    2,
  );
}

let keys: TestKeys;
let otherKeys: TestKeys;

beforeAll(async () => {
  keys = await generateKeys();
  otherKeys = await generateKeys();
});

function verifier(publicKeys = [keys.publicKey]): ModelRecommendationsVerifier {
  return new ModelRecommendationsVerifier({ publicKeys, now: () => NOW });
}

async function signed(payload: string, privateKey = keys.privateKey) {
  return (await signModelRecommendations(payload, privateKey))._unsafeUnwrap();
}

async function rejection(
  envelope: string,
  v = verifier(),
): Promise<ModelRecommendationsError> {
  return (await v.verifyEnvelope(envelope))._unsafeUnwrapErr();
}

describe("signature verification", () => {
  it("accepts a list signed by a known key", async () => {
    const result = await verifier().verifyEnvelope(await signed(list()));
    expect(result._unsafeUnwrap().default.agents.loom?.models).toEqual([
      "claude-opus-5.5",
    ]);
  });

  it("accepts a list signed by any key in the list, so a key can rotate", async () => {
    const both = verifier([otherKeys.publicKey, keys.publicKey]);
    expect((await both.verifyEnvelope(await signed(list()))).isOk()).toBe(true);
  });

  it("verifies the payload's exact bytes, including non-ASCII text", async () => {
    const payload = list({ evidence: "https://tryweave.io/evals/runs/é" });
    expect(
      (await verifier().verifyEnvelope(await signed(payload))).isOk(),
    ).toBe(true);
  });

  it("rejects a list signed by an unknown key", async () => {
    const envelope = await signed(list(), otherKeys.privateKey);
    expect((await rejection(envelope)).type).toBe("SignatureInvalid");
  });

  it("rejects a payload changed after signing, even by whitespace", async () => {
    const envelope = JSON.parse(await signed(list()));
    envelope.payload = `${envelope.payload}\n`;
    expect((await rejection(JSON.stringify(envelope))).type).toBe(
      "SignatureInvalid",
    );
  });

  it("rejects a tampered model before reading it", async () => {
    const envelope = JSON.parse(await signed(list()));
    envelope.payload = envelope.payload.replace("claude-opus-5.5", "gpt-4o");
    expect((await rejection(JSON.stringify(envelope))).type).toBe(
      "SignatureInvalid",
    );
  });

  it("rejects a signature that is not base64 or not 64 bytes", async () => {
    const payload = list();
    for (const sig of ["not base64!", encodeBase64(new Uint8Array(32)), ""]) {
      const error = await rejection(JSON.stringify({ payload, sig }));
      expect(error.type).toBe("SignatureInvalid");
    }
  });

  it("rejects everything when no key is configured", async () => {
    expect((await rejection(await signed(list()), verifier([]))).type).toBe(
      "KeyInvalid",
    );
  });

  it("reports a malformed embedded key rather than accepting the list", async () => {
    const error = await rejection(await signed(list()), verifier(["abc"]));
    expect(error.type).toBe("KeyInvalid");
  });

  it("checks the signature before the schema, so an unsigned list is never parsed", async () => {
    const error = await rejection(
      JSON.stringify({
        payload: "not json",
        sig: encodeBase64(new Uint8Array(64)),
      }),
    );
    expect(error.type).toBe("SignatureInvalid");
  });

  it("rejects a signed payload that fails the schema", async () => {
    const error = await rejection(await signed(list({ schema: 2 })));
    expect(error.type).toBe("SchemaInvalid");
  });

  it("rejects an envelope that is not JSON or has the wrong fields", async () => {
    expect((await rejection("{")).type).toBe("EnvelopeInvalid");
    expect((await rejection(JSON.stringify({ payload: list() }))).type).toBe(
      "EnvelopeInvalid",
    );
  });

  it("ships the production key as a raw 32-byte Ed25519 key", async () => {
    expect(MODEL_RECOMMENDATIONS_PUBLIC_KEYS).toContain(
      "b5UhKwU8ugzt7BBcPCHCIXPMaGip85yid0l187r7c8Y=",
    );
    for (const key of MODEL_RECOMMENDATIONS_PUBLIC_KEYS) {
      const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      await expect(
        crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, [
          "verify",
        ]),
      ).resolves.toBeDefined();
    }
  });

  it("uses the production keys by default, which this test's list does not verify against", async () => {
    const production = new ModelRecommendationsVerifier({ now: () => NOW });
    expect((await rejection(await signed(list()), production)).type).toBe(
      "SignatureInvalid",
    );
  });
});

describe("freshness", () => {
  async function verify(
    overrides: Record<string, unknown>,
    context = {},
    now = NOW,
  ) {
    const v = new ModelRecommendationsVerifier({
      publicKeys: [keys.publicKey],
      now: () => now,
    });
    return v.verifyEnvelope(await signed(list(overrides)), context);
  }

  it("rejects an expired list", async () => {
    const error = (
      await verify({}, {}, new Date("2026-12-30T09:00:00Z"))
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: "Expired",
      expires: "2026-12-30T09:00:00Z",
    });
  });

  it("accepts a list issued up to 24 hours ahead of the clock", async () => {
    const now = new Date("2026-09-30T09:00:00Z");
    expect((await verify({}, {}, now)).isOk()).toBe(true);
  });

  it("rejects a list issued more than 24 hours ahead of the clock", async () => {
    const now = new Date("2026-09-30T08:59:59Z");
    expect((await verify({}, {}, now))._unsafeUnwrapErr().type).toBe(
      "IssuedInFuture",
    );
  });

  it("rejects a list issued before this release's builtin models", async () => {
    const error = (
      await verify({
        issued: "2026-09-29T09:11:43Z",
        expires: "2026-12-01T00:00:00Z",
      })
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: "OlderThanBuiltins",
      builtinsIssued: BUILTIN_MODELS_ISSUED,
    });
  });

  it("accepts a list issued exactly when the builtins were set", async () => {
    const result = await verify({
      issued: BUILTIN_MODELS_ISSUED,
      expires: "2026-12-01T00:00:00Z",
    });
    expect(result.isOk()).toBe(true);
  });

  it("rejects a list that is not newer than the applied one (rollback and replay)", async () => {
    const older = await verify({}, { appliedIssued: "2026-10-01T10:00:00Z" });
    expect(older._unsafeUnwrapErr().type).toBe("NotNewer");
    const same = await verify({}, { appliedIssued: "2026-10-01T09:00:00Z" });
    expect(same._unsafeUnwrapErr().type).toBe("NotNewer");
    const newer = await verify({}, { appliedIssued: "2026-10-01T08:59:59Z" });
    expect(newer.isOk()).toBe(true);
  });

  it("rejects a list for another channel", async () => {
    const error = (
      await verify({ channel: "next" }, { channel: "stable" })
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: "ChannelMismatch",
      expected: "stable",
      actual: "next",
    });
  });

  it("rejects a list that needs a newer client", async () => {
    const error = (
      await verify({ min_config_version: "0.3.0" }, { clientVersion: "0.2.9" })
    )._unsafeUnwrapErr();
    expect(error).toMatchObject({
      type: "ClientTooOld",
      required: "0.3.0",
      actual: "0.2.9",
    });
    expect(
      (
        await verify(
          { min_config_version: "0.3.0" },
          { clientVersion: "0.3.0" },
        )
      ).isOk(),
    ).toBe(true);
  });

  it("validates an unsigned list with the same rules", () => {
    const v = verifier();
    expect(v.validateList(list()).isOk()).toBe(true);
    expect(
      v
        .validateList(list(), { appliedIssued: "2026-10-01T09:00:00Z" })
        ._unsafeUnwrapErr().type,
    ).toBe("NotNewer");
  });
});

describe("describeModelRecommendationsError", () => {
  it("gives every rejection a one-line reason", () => {
    const errors: ModelRecommendationsError[] = [
      { type: "TooLarge", bytes: 70000, limit: 65536 },
      { type: "EnvelopeInvalid", message: "sig: missing" },
      { type: "KeyInvalid", message: "no public keys" },
      { type: "SignatureInvalid", message: "no known key signed this payload" },
      { type: "SchemaInvalid", issues: ["schema: expected 1"] },
      { type: "ChannelMismatch", expected: "stable", actual: "next" },
      { type: "ClientTooOld", required: "0.3.0", actual: "0.2.0" },
      { type: "Expired", expires: "a", now: "b" },
      { type: "IssuedInFuture", issued: "a", now: "b" },
      { type: "OlderThanBuiltins", issued: "a", builtinsIssued: "b" },
      { type: "NotNewer", issued: "a", appliedIssued: "b" },
    ];
    for (const error of errors) {
      const text = describeModelRecommendationsError(error);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("\n");
    }
  });
});

describe("signModelRecommendations", () => {
  it("rejects a private key that is not base64 PKCS #8 Ed25519", async () => {
    expect(
      (await signModelRecommendations("{}", "!!"))._unsafeUnwrapErr().type,
    ).toBe("PrivateKeyInvalid");
    expect(
      (await signModelRecommendations("{}", keys.publicKey))._unsafeUnwrapErr()
        .type,
    ).toBe("PrivateKeyInvalid");
  });

  it("keeps the payload text byte for byte", async () => {
    const payload = list();
    expect(JSON.parse(await signed(payload)).payload).toBe(payload);
  });
});
