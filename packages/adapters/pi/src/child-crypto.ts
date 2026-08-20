/**
 * Injected randomness/HMAC ports and secret-handling helpers for the
 * private child transport (Pi adapter contract). Production implementations use
 * only Web Crypto (`crypto.getRandomValues`/`crypto.subtle`), which Bun
 * implements natively - no Node `crypto` module import.
 */
import { ResultAsync } from "neverthrow";

export interface RandomPort {
  /** Returns `length` cryptographically random bytes. */
  randomBytes(length: number): Uint8Array;
}

export type HmacError = {
  readonly type: "HmacFailed";
  readonly reason: string;
};

export interface HmacPort {
  /** Computes lowercase-hex HMAC-SHA-256 of `data` under `key`. */
  signHex(key: Uint8Array, data: Uint8Array): ResultAsync<string, HmacError>;

  /**
   * Verifies `expectedMacHex` against a freshly computed HMAC-SHA-256 of
   * `data` under `key` using the underlying implementation's own
   * constant-time verify primitive (`crypto.subtle.verify`), rather than
   * recomputing a MAC and comparing hex strings in adapter code. Resolves
   * `ok(true)` only on an exact match; a malformed `expectedMacHex` (not a
   * 64-hex-char string) resolves `ok(false)`, never an error - shape
   * problems are the caller's (Zod's) responsibility, not a crypto failure.
   */
  verifyHex(
    key: Uint8Array,
    data: Uint8Array,
    expectedMacHex: string,
  ): ResultAsync<boolean, HmacError>;
}

export class WebCryptoRandomPort implements RandomPort {
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }
}

export class WebCryptoHmacPort implements HmacPort {
  signHex(key: Uint8Array, data: Uint8Array): ResultAsync<string, HmacError> {
    return ResultAsync.fromPromise(
      this.computeHex(key, data),
      (cause): HmacError => ({
        type: "HmacFailed",
        reason: describeThrown(cause),
      }),
    );
  }

  verifyHex(
    key: Uint8Array,
    data: Uint8Array,
    expectedMacHex: string,
  ): ResultAsync<boolean, HmacError> {
    return ResultAsync.fromPromise(
      this.computeVerify(key, data, expectedMacHex),
      (cause): HmacError => ({
        type: "HmacFailed",
        reason: describeThrown(cause),
      }),
    );
  }

  private async importHmacKey(key: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      toFreshBuffer(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  private async computeHex(key: Uint8Array, data: Uint8Array): Promise<string> {
    const cryptoKey = await this.importHmacKey(key);
    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      toFreshBuffer(data),
    );
    return bytesToHex(new Uint8Array(signature));
  }

  /**
   * Uses `crypto.subtle.verify` - the implementation's own constant-time
   * comparison primitive - rather than a hand-rolled hex-string compare, so
   * verification timing is governed by the platform's crypto
   * implementation, not adapter-level code. A malformed hex string decodes
   * to no signature bytes matching any real MAC and simply verifies false.
   */
  private async computeVerify(
    key: Uint8Array,
    data: Uint8Array,
    expectedMacHex: string,
  ): Promise<boolean> {
    const macBytes = hexToBytes(expectedMacHex);
    if (macBytes === undefined) return false;
    const cryptoKey = await this.importHmacKey(key);
    return crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      toFreshBuffer(macBytes),
      toFreshBuffer(data),
    );
  }
}

/**
 * Copies `bytes` into a freshly allocated, non-shared `ArrayBuffer`-backed
 * view. Web Crypto's DOM typings require a plain `ArrayBuffer` (not the
 * generic `ArrayBufferLike`, which also admits `SharedArrayBuffer`); a
 * fresh copy is also safer than passing a live secret's own backing buffer.
 */
function toFreshBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Deliberately does not surface the thrown value's own message: an
 * exception from Web Crypto could in principle echo back input material,
 * and this reason string can end up in adapter failure `correlation`
 * fields, which must never carry raw payload/secret content (Pi adapter contract
 *). Every HMAC failure is reported through this single bounded,
 * closed-set reason regardless of cause.
 */
function describeThrown(_cause: unknown): string {
  return "webcrypto-hmac-operation-failed";
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time hex string comparison. Always scans the full length of the
 * longer input so a length mismatch does not itself leak timing
 * information beyond "these differ".
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    const codeA = i < a.length ? a.charCodeAt(i) : 0;
    const codeB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= codeA ^ codeB;
  }
  return diff === 0;
}

const SECRET_BYTES = 32; // 256 bits
const NONCE_BYTES = 16; // 128 bits

/**
 * A 256-bit secret held in an erasable buffer. `dispose()` zeroes the
 * underlying bytes so no reference to the live secret value can outlive a
 * terminal path (spawn failure, handshake timeout, settlement, abort, or
 * shutdown) - Pi adapter contract.
 */
export class ErasableSecret {
  private bytes: Uint8Array | undefined;

  constructor(initial: Uint8Array) {
    this.bytes = initial;
  }

  /** Returns the live secret bytes, or `undefined` once disposed. */
  peek(): Uint8Array | undefined {
    return this.bytes;
  }

  dispose(): void {
    if (this.bytes === undefined) return;
    this.bytes.fill(0);
    this.bytes = undefined;
  }
}

export function generateChildSecret(random: RandomPort): ErasableSecret {
  return new ErasableSecret(random.randomBytes(SECRET_BYTES));
}

export function generateNonceHex(random: RandomPort): string {
  return bytesToHex(random.randomBytes(NONCE_BYTES));
}
