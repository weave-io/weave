/**
 * Sign a model recommendations list into the envelope tryweave.io serves
 * (Spec 39).
 *
 *   bun scripts/models/sign.ts <list.json> <private-key-file> <envelope-out.json>
 *
 * `<private-key-file>` holds an Ed25519 private key in PKCS #8 form, base64
 * (what `scripts/models/keygen.ts` writes). The list's exact bytes become the
 * envelope's `payload`, so what was reviewed is what is signed. The list must
 * pass the same checks a client makes (schema, expiry, a mis-dated `issued`,
 * the builtin baseline) or nothing is written: run
 * `weave models check <list> --expect <expect-file>` first for the resolution
 * check. The website's deploy workflow runs this with the key from its
 * `model-recommendations` environment; the private key never enters this
 * repository.
 */

import {
  describeModelRecommendationsError,
  ModelRecommendationsVerifier,
  signModelRecommendations,
} from "@weaveio/weave-config";
import { logger } from "@weaveio/weave-engine";
import { errAsync, type ResultAsync } from "neverthrow";

const log = logger.child({ module: "models-sign" });

/** Why an envelope was not produced. */
export type SignListError =
  | { readonly type: "ListInvalid"; readonly reason: string }
  | { readonly type: "SignFailed"; readonly reason: string };

/**
 * Check `listText` the way a client would, then sign its exact bytes. Returns
 * the envelope's JSON text.
 */
export function signList(
  listText: string,
  privateKey: string,
  verifier = new ModelRecommendationsVerifier(),
): ResultAsync<string, SignListError> {
  const checked = verifier.validateList(listText);
  if (checked.isErr())
    return errAsync({
      type: "ListInvalid",
      reason: describeModelRecommendationsError(checked.error),
    });
  return signModelRecommendations(listText, privateKey).mapErr(
    (error): SignListError => ({ type: "SignFailed", reason: error.message }),
  );
}

async function main(args: readonly string[]): Promise<number> {
  const [listPath, keyPath, outPath] = args;
  if (
    listPath === undefined ||
    keyPath === undefined ||
    outPath === undefined
  ) {
    log.error(
      "Usage: bun scripts/models/sign.ts <list.json> <private-key-file> <envelope-out.json>",
    );
    return 1;
  }
  const listText = await Bun.file(listPath).text();
  const privateKey = (await Bun.file(keyPath).text()).trim();
  const envelope = await signList(listText, privateKey);
  if (envelope.isErr()) {
    log.error({ error: envelope.error }, "Not signed");
    return 1;
  }
  await Bun.write(outPath, `${envelope.value}\n`);
  log.info({ list: listPath, envelope: outPath }, "Signed");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
