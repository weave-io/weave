import { describe, expect, it } from "bun:test";
import {
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  ModelRecommendationsVerifier,
} from "@weaveio/weave-config";
import { generateKeyPair } from "../keygen.js";
import { signFiles, signList } from "../sign.js";

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
    const keys = (await generateKeyPair())._unsafeUnwrap();
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
    const keys = (await generateKeyPair())._unsafeUnwrap();
    const expired = new ModelRecommendationsVerifier({
      now: () => new Date("2027-01-01T00:00:00Z"),
    });
    const result = await signList(list, keys.privateKey, expired);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ListInvalid");
    expect(error.type === "ListInvalid" ? error.reason : "").toContain(
      "expired",
    );
  });

  it("refuses a private key that is not PKCS #8 Ed25519", async () => {
    const keys = (await generateKeyPair())._unsafeUnwrap();
    const result = await signList(
      list,
      keys.publicKey,
      new ModelRecommendationsVerifier({ now: () => NOW }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("SignFailed");
  });

  it("refuses a list whose envelope would exceed the 64 KiB a client accepts", async () => {
    const keys = (await generateKeyPair())._unsafeUnwrap();
    // Each newline is one byte in the list but two (an escaped \n) in the envelope,
    // so a list under 64 KiB can still produce an envelope over it.
    const big = `${list}${"\n".repeat(40_000)}`;
    expect(new TextEncoder().encode(big).byteLength).toBeLessThan(
      MAX_MODEL_RECOMMENDATIONS_BYTES,
    );
    const result = await signList(
      big,
      keys.privateKey,
      new ModelRecommendationsVerifier({ now: () => NOW }),
    );
    expect(result._unsafeUnwrapErr().type).toBe("EnvelopeInvalid");
  });

  it("reports missing arguments and unreadable files as errors, not exceptions", async () => {
    expect((await signFiles([]))._unsafeUnwrapErr().type).toBe("Usage");
    const missing = await signFiles([
      "/nonexistent/list.json",
      "/nonexistent/key",
      "/nonexistent/out.json",
    ]);
    expect(missing._unsafeUnwrapErr()).toEqual({
      type: "ReadFailed",
      path: "/nonexistent/list.json",
    });
  });
});
