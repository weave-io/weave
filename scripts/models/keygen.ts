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
import { errAsync, ResultAsync } from "neverthrow";

const log = logger.child({ module: "models-keygen" });

/** Why no key pair was produced. */
export type KeygenError =
  | { readonly type: "Usage" }
  | { readonly type: "Exists"; readonly path: string }
  | { readonly type: "GenerateFailed" }
  | { readonly type: "WriteFailed"; readonly path: string };

/** A key pair, both halves base64. */
export interface KeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function exportPair(): Promise<KeyPair> {
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

/** A fresh Ed25519 key pair. */
export function generateKeyPair(): ResultAsync<KeyPair, KeygenError> {
  return ResultAsync.fromThrowable(
    exportPair,
    (): KeygenError => ({ type: "GenerateFailed" }),
  )();
}

async function writePrivateKey(
  path: string,
  privateKey: string,
): Promise<void> {
  await Bun.write(path, "");
  await $`chmod 600 ${path}`.quiet();
  await Bun.write(path, `${privateKey}\n`);
}

/** Run the script; resolves to the new public key instead of throwing. */
export function keygen(
  args: readonly string[],
): ResultAsync<string, KeygenError> {
  const [outPath] = args;
  if (outPath === undefined) return errAsync({ type: "Usage" });
  return ResultAsync.fromThrowable(
    () => Bun.file(outPath).exists(),
    (): KeygenError => ({ type: "WriteFailed", path: outPath }),
  )()
    .andThen((exists) =>
      exists
        ? errAsync<KeyPair, KeygenError>({ type: "Exists", path: outPath })
        : generateKeyPair(),
    )
    .andThen((keys) =>
      ResultAsync.fromThrowable(
        () => writePrivateKey(outPath, keys.privateKey),
        (): KeygenError => ({ type: "WriteFailed", path: outPath }),
      )().map(() => keys.publicKey),
    );
}

if (import.meta.main) {
  const [outPath] = Bun.argv.slice(2);
  const result = await keygen(Bun.argv.slice(2));
  result.match(
    (publicKey) =>
      log.info(
        { publicKey, privateKeyFile: outPath },
        "Generated an Ed25519 key pair",
      ),
    (error) => {
      if (error.type === "Usage")
        log.error("Usage: bun scripts/models/keygen.ts <private-key-out>");
      else log.error({ error }, "No key pair generated");
      process.exitCode = 1;
    },
  );
}
