/**
 * Scenario support for published model recommendations (Spec 39): a
 * throwaway signing key, signed lists, a stub server standing in for
 * tryweave.io, and an empty global config directory per scenario, where the
 * recommendations cache lives. Nothing here touches the network.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { signModelRecommendations } from "../../packages/config/src/index.js";

export const HOUR = 3_600_000;

/** The base URL scenarios point the refresh at; only the stub answers it. */
export const STUB_BASE_URL = "https://models.test/models";

export interface Keys {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** A fresh Ed25519 key pair, base64-encoded the way the verifier reads it. */
export async function throwawayKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const base64 = (buffer: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return {
    publicKey: base64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A signed list issued `hoursAgo` and valid for 30 days. `sections` holds the
 * file's `default` section and, optionally, `harnesses`.
 */
export async function signedList(
  keys: Keys,
  hoursAgo: number,
  sections: Record<string, unknown>,
): Promise<{ readonly issued: string; readonly body: string }> {
  const issued = new Date(Date.now() - hoursAgo * HOUR);
  const payload = JSON.stringify({
    schema: 1,
    channel: "stable",
    issued: stamp(issued),
    expires: stamp(new Date(issued.getTime() + 30 * 24 * HOUR)),
    evidence: "https://tryweave.io/evals/runs/scenario",
    ...sections,
  });
  const body = (
    await signModelRecommendations(payload, keys.privateKey)
  )._unsafeUnwrap();
  return { issued: stamp(issued), body };
}

/** The recommendations server: whatever list it holds now, and every GET. */
export class StubServer {
  readonly requests: string[] = [];
  body = "";
  fetch = async (url: string): Promise<Response> => {
    this.requests.push(url);
    return new Response(this.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: `"${this.requests.length}"`,
      },
    });
  };
}

async function removeTree(dir: string): Promise<void> {
  await Bun.spawn(["rm", "-rf", dir], { stdout: "ignore", stderr: "ignore" })
    .exited;
}

/**
 * Runs `body` with `WEAVE_GLOBAL_CONFIG_DIR` pointing at an empty temporary
 * directory of its own, and puts it back afterwards. Scenarios using it must
 * not overlap.
 */
export async function withGlobalDir<T>(
  prefix: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const previous = process.env.WEAVE_GLOBAL_CONFIG_DIR;
  process.env.WEAVE_GLOBAL_CONFIG_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.WEAVE_GLOBAL_CONFIG_DIR;
    else process.env.WEAVE_GLOBAL_CONFIG_DIR = previous;
    await removeTree(dir);
  }
}
