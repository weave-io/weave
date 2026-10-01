/**
 * Fakes for scenarios that involve published model recommendations (Spec 39):
 * an in-memory recommendations cache, a scripted `fetch`, and a throwaway
 * Ed25519 key pair that signs lists the way the website's deploy does.
 *
 * Nothing here touches the network or the disk.
 */

import {
  type CacheIoError,
  type ModelRecommendationsFetch,
  type ModelRecommendationsFiles,
  type ModelRecommendationsShell,
  signModelRecommendations,
} from "@weaveio/weave-config";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

/** An Ed25519 key pair, both halves base64 (raw public, PKCS #8 private). */
export interface SigningKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/** A fresh key pair for one test file. */
export async function generateSigningKeys(): Promise<SigningKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: base64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

/** The signed envelope for `list`, as tryweave.io serves it. */
export async function signedEnvelope(
  list: unknown,
  keys: SigningKeys,
): Promise<string> {
  const signed = await signModelRecommendations(
    JSON.stringify(list),
    keys.privateKey,
  );
  return signed._unsafeUnwrap();
}

/** A cache held in memory, implementing both cache interfaces. */
export class MemoryRecommendationsCache
  implements ModelRecommendationsFiles, ModelRecommendationsShell
{
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  constructor(private readonly now: () => Date) {}

  exists(path: string): ResultAsync<boolean, CacheIoError> {
    return okAsync(this.files.has(path));
  }

  read(path: string): ResultAsync<string, CacheIoError> {
    const text = this.files.get(path);
    if (text === undefined) return errAsync(this.error("read", path));
    return okAsync(text);
  }

  write(path: string, text: string): ResultAsync<void, CacheIoError> {
    this.files.set(path, text);
    return okAsync(undefined);
  }

  modifiedAt(path: string): ResultAsync<number | undefined, CacheIoError> {
    if (this.dirs.has(path) || this.files.has(path))
      return okAsync(this.now().getTime());
    return okAsync(undefined);
  }

  move(from: string, to: string): ResultAsync<void, CacheIoError> {
    const text = this.files.get(from);
    if (text === undefined) return errAsync(this.error("move", from));
    this.files.delete(from);
    this.files.set(to, text);
    return okAsync(undefined);
  }

  makeDir(path: string): ResultAsync<boolean, CacheIoError> {
    if (this.dirs.has(path)) return okAsync(false);
    this.dirs.add(path);
    return okAsync(true);
  }

  makeDirs(path: string): ResultAsync<void, CacheIoError> {
    this.dirs.add(path);
    return okAsync(undefined);
  }

  remove(path: string): ResultAsync<void, CacheIoError> {
    this.dirs.delete(path);
    this.files.delete(path);
    return okAsync(undefined);
  }

  private error(
    operation: CacheIoError["operation"],
    path: string,
  ): CacheIoError {
    return { type: "CacheIoError", operation, path, message: "not found" };
  }
}

/** A `fetch` that answers with whatever the test last served. */
export class ScriptedFetch {
  readonly urls: string[] = [];
  private respond: () => Response = () => new Response(null, { status: 404 });

  serve(body: string): void {
    this.respond = () => new Response(body, { status: 200 });
  }

  fail(status: number): void {
    this.respond = () => new Response(null, { status });
  }

  fetch: ModelRecommendationsFetch = (url) => {
    this.urls.push(url);
    return Promise.resolve(this.respond());
  };
}
