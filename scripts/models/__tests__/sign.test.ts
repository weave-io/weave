import { describe, expect, it } from "bun:test";
import {
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  ModelRecommendationsVerifier,
} from "@weaveio/weave-config";
import { generateKeyPair } from "../keygen.js";
import { type SignFileIo, signFiles, signList } from "../sign.js";

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

  it("reports missing arguments as a usage error", async () => {
    expect((await signFiles([]))._unsafeUnwrapErr().type).toBe("Usage");
  });

  describe("with files", () => {
    class MemorySignFileIo implements SignFileIo {
      readonly files = new Map<string, string>();
      failWrites = false;

      async read(path: string): Promise<string> {
        const text = this.files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      }

      async write(path: string, text: string): Promise<void> {
        if (this.failWrites) throw new Error("disk full");
        this.files.set(path, text);
      }
    }

    const verifier = () => new ModelRecommendationsVerifier({ now: () => NOW });

    it("reads the list and key and writes the envelope", async () => {
      const keys = (await generateKeyPair())._unsafeUnwrap();
      const io = new MemorySignFileIo();
      io.files.set("/l.json", list);
      io.files.set("/k", `${keys.privateKey}\n`);
      const out = await signFiles(["/l.json", "/k", "/e.json"], io, verifier());

      expect(out._unsafeUnwrap()).toBe("/e.json");
      const envelope = io.files.get("/e.json") ?? "";
      expect(envelope.endsWith("\n")).toBe(true);
      expect(JSON.parse(envelope).payload).toBe(list);
    });

    it("returns ReadFailed for a missing list or key", async () => {
      const io = new MemorySignFileIo();
      io.files.set("/l.json", list);
      expect(
        (
          await signFiles(["/missing", "/k", "/e"], io, verifier())
        )._unsafeUnwrapErr(),
      ).toEqual({ type: "ReadFailed", path: "/missing" });
      expect(
        (
          await signFiles(["/l.json", "/k", "/e"], io, verifier())
        )._unsafeUnwrapErr(),
      ).toEqual({ type: "ReadFailed", path: "/k" });
    });

    it("returns WriteFailed when the envelope cannot be written", async () => {
      const keys = (await generateKeyPair())._unsafeUnwrap();
      const io = new MemorySignFileIo();
      io.files.set("/l.json", list);
      io.files.set("/k", keys.privateKey);
      io.failWrites = true;
      expect(
        (
          await signFiles(["/l.json", "/k", "/e"], io, verifier())
        )._unsafeUnwrapErr(),
      ).toEqual({ type: "WriteFailed", path: "/e" });
    });
  });
});
