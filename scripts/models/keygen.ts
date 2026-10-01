/**
 * Generate an Ed25519 key pair for signing model recommendations (Spec 39).
 *
 *   bun scripts/models/keygen.ts <private-key-out>
 *
 * Writes the private key (PKCS #8, base64) to `<private-key-out>` with mode
 * 600 and logs the public key (raw, base64), which goes into
 * `MODEL_RECOMMENDATIONS_PUBLIC_KEYS` in
 * `packages/config/src/model-recommendations-keys.ts`. Use it for a rotation
 * (ship the public key in a release before signing with the new private key)
 * or for a local proof with a throwaway key. Never commit a private key.
 */

import { logger } from "@weaveio/weave-engine";
import { $ } from "bun";

const log = logger.child({ module: "models-keygen" });

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A fresh key pair, both halves base64. */
export async function generateKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: toBase64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: toBase64(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
  };
}

async function main(args: readonly string[]): Promise<number> {
  const [outPath] = args;
  if (outPath === undefined) {
    log.error("Usage: bun scripts/models/keygen.ts <private-key-out>");
    return 1;
  }
  if (await Bun.file(outPath).exists()) {
    log.error({ path: outPath }, "Refusing to overwrite an existing key file");
    return 1;
  }
  const keys = await generateKeyPair();
  await Bun.write(outPath, "");
  await $`chmod 600 ${outPath}`.quiet();
  await Bun.write(outPath, `${keys.privateKey}\n`);
  log.info(
    { publicKey: keys.publicKey, privateKeyFile: outPath },
    "Generated an Ed25519 key pair",
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
