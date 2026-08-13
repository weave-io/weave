/**
 * The one diagnostic projection policy shared by every Pi child surface.
 *
 * A diagnostic string - a settlement failure reason, a protocol `cancel`
 * reason, a protocol `error` reason, a completion message - is *display
 * prose*, never authoritative data. It is therefore always safe to shorten,
 * and never safe to reject: the body around it carries the typed code, and
 * rejecting the body to punish oversized prose throws that code away.
 *
 * Three rules follow, and this module is the only place any of them is
 * implemented:
 *
 * 1. The source budget is measured in **UTF-8 bytes**, not UTF-16 code
 *    units, so it matches what the framing ceilings actually count.
 * 2. The *serialized* budget is measured in the UTF-8 bytes the value costs
 *    **after JSON escaping**, because that - not the source text - is what
 *    the signed control body and the engine's opaque command envelope
 *    actually carry. A 32 KiB reason made of C0 control bytes serializes to
 *    192 KiB (`\u0000` is six bytes per source byte) and a 32 KiB reason made
 *    of quotes serializes to 64 KiB, either of which blows the 64 KiB
 *    control-body cap on its own and turns a valid settlement into a
 *    `BodyTooLarge` transport failure.
 * 3. Producers project **before** the value reaches a schema, and the schemas
 *    admit the projected value. A cut never splits a code point, and a cut
 *    always leaves an explicit marker.
 */

/**
 * The approved inline diagnostic prose budget, in source UTF-8 bytes.
 *
 * This remains the upper bound on any diagnostic: no projection ever returns
 * more source bytes than this, whatever the serialized budget allows.
 */
export const MAX_DIAGNOSTIC_REASON_BYTES = 32 * 1_024;

/**
 * The approved diagnostic budget measured on the JSON string literal - the
 * escaped text plus its two surrounding quotes - in UTF-8 bytes.
 *
 * Sized so that the *whole* signed control body stays under
 * `MAX_CONTROL_BODY_BYTES` (64 KiB) for every body kind that carries a
 * diagnostic reason. The largest such body is `delegate-response`, whose
 * canonical framing around the reason costs well under 200 bytes, so 48 KiB
 * leaves 16 KiB of headroom for every sibling field and all JSON structure.
 */
export const MAX_DIAGNOSTIC_SERIALIZED_BYTES = 48 * 1_024;

/** Appended to any projected diagnostic so truncation is never implicit. */
export const DIAGNOSTIC_TRUNCATION_MARKER = "\n… [diagnostic truncated]";

const encoder = new TextEncoder();

/**
 * UTF-8 bytes one code point costs *inside* a JSON string literal, under the
 * exact escaping `JSON.stringify` performs - which is what
 * `canonicalizeToBytes` uses and therefore what the signed body measures.
 *
 * `"` and `\` and the five short-form control escapes cost two bytes; every
 * other C0 byte costs six (`\u00XX`); a lone surrogate costs six as well
 * (`JSON.stringify` well-formed escaping, though the canonicalizer rejects
 * lone surrogates before they get this far); everything else costs its plain
 * UTF-8 length, because JSON does not escape non-ASCII.
 */
export function jsonEscapedCodePointByteLength(codePoint: string): number {
  const code = codePoint.codePointAt(0) ?? 0;
  if (code === 0x22 || code === 0x5c) return 2;
  if (
    code === 0x08 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d
  ) {
    return 2;
  }
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  if (code < 0x800) return 2;
  if (code < 0x1_0000) return 3;
  return 4;
}

/** Plain UTF-8 byte cost of one code point (a lone surrogate encodes as U+FFFD). */
function utf8CodePointByteLength(codePoint: string): number {
  const code = codePoint.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x1_0000) return 3;
  return 4;
}

/** Escaped UTF-8 byte cost of `value`'s content, excluding the quotes. */
function jsonEscapedContentByteLength(value: string): number {
  let total = 0;
  for (const codePoint of value) {
    total += jsonEscapedCodePointByteLength(codePoint);
  }
  return total;
}

/**
 * Exact UTF-8 byte length of the JSON string literal for `value`, including
 * its two surrounding quotes. Equals
 * `new TextEncoder().encode(JSON.stringify(value)).byteLength` without
 * materializing the escaped string.
 */
export function jsonStringSerializedByteLength(value: string): number {
  return 2 + jsonEscapedContentByteLength(value);
}

/** True when `value` already fits both budgets and needs no projection. */
export function fitsDiagnosticBudget(
  value: string,
  maxBytes: number = MAX_DIAGNOSTIC_REASON_BYTES,
  maxSerializedBytes: number = MAX_DIAGNOSTIC_SERIALIZED_BYTES,
): boolean {
  return (
    encoder.encode(value).byteLength <= maxBytes &&
    jsonStringSerializedByteLength(value) <= maxSerializedBytes
  );
}

/**
 * Projects display prose into both the source-byte and serialized-byte
 * budgets.
 *
 * The walk is by code point, so a cut can never split one: the result always
 * decodes as valid UTF-8 with no replacement character. The marker is charged
 * against *both* budgets, so the projected value including its marker fits
 * both. Typed codes, identifiers, and authoritative results are never routed
 * through here.
 *
 * If the marker alone cannot fit the budgets - only reachable with a
 * degenerate caller-supplied budget - the value is cut to the budgets with no
 * marker rather than returning something that overflows them.
 */
export function projectDiagnosticText(
  value: string,
  maxBytes: number = MAX_DIAGNOSTIC_REASON_BYTES,
  marker: string = DIAGNOSTIC_TRUNCATION_MARKER,
  maxSerializedBytes: number = MAX_DIAGNOSTIC_SERIALIZED_BYTES,
): string {
  if (fitsDiagnosticBudget(value, maxBytes, maxSerializedBytes)) return value;

  const markerSourceBytes = encoder.encode(marker).byteLength;
  const markerSerializedBytes = jsonEscapedContentByteLength(marker);
  const markerFits =
    markerSourceBytes <= maxBytes &&
    2 + markerSerializedBytes <= maxSerializedBytes;

  const sourceLimit = markerFits ? maxBytes - markerSourceBytes : maxBytes;
  const serializedLimit = markerFits
    ? maxSerializedBytes - 2 - markerSerializedBytes
    : Math.max(0, maxSerializedBytes - 2);

  let kept = "";
  let sourceUsed = 0;
  let serializedUsed = 0;
  for (const codePoint of value) {
    const sourceCost = utf8CodePointByteLength(codePoint);
    const serializedCost = jsonEscapedCodePointByteLength(codePoint);
    if (sourceUsed + sourceCost > sourceLimit) break;
    if (serializedUsed + serializedCost > serializedLimit) break;
    kept += codePoint;
    sourceUsed += sourceCost;
    serializedUsed += serializedCost;
  }
  return markerFits ? `${kept}${marker}` : kept;
}
