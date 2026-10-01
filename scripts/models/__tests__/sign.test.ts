import { describe, expect, it } from "bun:test";
import { ModelRecommendationsVerifier } from "@weaveio/weave-config";
import { generateKeyPair } from "../keygen.js";
import { signList } from "../sign.js";

const NOW = new Date("2026-10-02T12:00:00Z");

const list = `${JSON.stringify(
  {
    schema: 1,
    channel: "next",
    issued: "2026-10-01T09:00:00Z",
    expires: "2026-12-30T09:00:00Z",
    evidence: "https://tryweave.io/evals/runs/run-1",
    default: { agents: { loom: { models: ["claude-opus-5.5"] } } },
  },
  null,
  2,
)}\n`;

describe("scripts/models/sign.ts", () => {
  it("signs a list's exact bytes into an envelope a client verifies with the public key", async () => {
    const keys = await generateKeyPair();
    const envelope = (
      await signList(
        list,
        keys.privateKey,
        new ModelRecommendationsVerifier({ now: () => NOW }),
      )
    )._unsafeUnwrap();

    expect(JSON.parse(envelope).payload).toBe(list);
    const client = new ModelRecommendationsVerifier({
      publicKeys: [keys.publicKey],
      now: () => NOW,
    });
    const verified = await client.verifyEnvelope(envelope, { channel: "next" });
    expect(verified._unsafeUnwrap().channel).toBe("next");
  });

  it("refuses to sign a list a client would reject", async () => {
    const keys = await generateKeyPair();
    const expired = new ModelRecommendationsVerifier({
      now: () => new Date("2027-01-01T00:00:00Z"),
    });
    const result = await signList(list, keys.privateKey, expired);
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "ListInvalid" });
    expect(result._unsafeUnwrapErr().reason).toContain("expired");
  });

  it("refuses a private key that is not PKCS #8 Ed25519", async () => {
    const keys = await generateKeyPair();
    const result = await signList(
      list,
      keys.publicKey,
      new ModelRecommendationsVerifier({ now: () => NOW }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("SignFailed");
  });
});
