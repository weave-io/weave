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
 * the builtin baseline), and the envelope must fit the 64 KiB a client
 * accepts, or nothing is written: run
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
import { err, errAsync, ok, ResultAsync } from "neverthrow";

const log = logger.child({ module: "models-sign" });

/** Why an envelope was not produced. */
export type SignListError =
  | { readonly type: "Usage" }
  | { readonly type: "ReadFailed"; readonly path: string }
  | { readonly type: "WriteFailed"; readonly path: string }
  | { readonly type: "ListInvalid"; readonly reason: string }
  | { readonly type: "EnvelopeInvalid"; readonly reason: string }
  | { readonly type: "SignFailed"; readonly reason: string };

/**
 * Check `listText` the way a client would, sign its exact bytes, and check
 * the envelope a client would download. Returns the envelope file's text.
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
  return signModelRecommendations(listText, privateKey)
    .mapErr(
      (error): SignListError => ({ type: "SignFailed", reason: error.message }),
    )
    .andThen((envelope) => {
      const text = `${envelope}\n`;
      const served = verifier.parseEnvelope(text);
      if (served.isErr())
        return err<string, SignListError>({
          type: "EnvelopeInvalid",
          reason: describeModelRecommendationsError(served.error),
        });
      return ok(text);
    });
}

function readText(path: string): ResultAsync<string, SignListError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).text(),
    (): SignListError => ({ type: "ReadFailed", path }),
  )();
}

function writeText(
  path: string,
  text: string,
): ResultAsync<number, SignListError> {
  return ResultAsync.fromThrowable(
    () => Bun.write(path, text),
    (): SignListError => ({ type: "WriteFailed", path }),
  )();
}

/** Run the script; resolves to the outcome instead of throwing. */
export function signFiles(
  args: readonly string[],
): ResultAsync<string, SignListError> {
  const [listPath, keyPath, outPath] = args;
  if (listPath === undefined || keyPath === undefined || outPath === undefined)
    return errAsync({ type: "Usage" });
  return readText(listPath)
    .andThen((listText) =>
      readText(keyPath).andThen((key) => signList(listText, key.trim())),
    )
    .andThen((envelope) => writeText(outPath, envelope))
    .map(() => outPath);
}

if (import.meta.main) {
  const result = await signFiles(Bun.argv.slice(2));
  result.match(
    (envelope) => log.info({ envelope }, "Signed"),
    (error) => {
      if (error.type === "Usage")
        log.error(
          "Usage: bun scripts/models/sign.ts <list.json> <private-key-file> <envelope-out.json>",
        );
      else log.error({ error }, "Not signed");
      process.exitCode = 1;
    },
  );
}
