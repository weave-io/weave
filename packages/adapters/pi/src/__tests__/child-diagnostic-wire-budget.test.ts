/**
 * End-to-end proof that the shared diagnostic policy is measured against the
 * *serialized* wire, not just the source text.
 *
 * Every case here drives the real path a diagnostic actually takes: project →
 * build the control body → canonicalize → HMAC-sign → verify → parse. A source
 * -only budget passes the first two steps and then fails at signing with
 * `BodyTooLarge`, destroying the typed code the body exists to carry.
 */

import { describe, expect, it } from "bun:test";
import {
  makeCancelBody,
  makeErrorBody,
  parseControlBody,
} from "../child-control-bodies.js";
import {
  generateNonceHex,
  WebCryptoHmacPort,
  WebCryptoRandomPort,
} from "../child-crypto.js";
import {
  DIAGNOSTIC_TRUNCATION_MARKER,
  fitsDiagnosticBudget,
  jsonStringSerializedByteLength,
  MAX_DIAGNOSTIC_REASON_BYTES,
  MAX_DIAGNOSTIC_SERIALIZED_BYTES,
  projectDiagnosticText,
} from "../child-diagnostic-projection.js";
import {
  MAX_CONTROL_BODY_BYTES,
  type PiControlKind,
  signEnvelope,
  verifyEnvelope,
} from "../child-envelope.js";
import { canonicalizeToBytes, type JsonValue } from "../strict-json.js";

const randomPort = new WebCryptoRandomPort();
const hmacPort = new WebCryptoHmacPort();
const secret = new Uint8Array(32).fill(11);
const encoder = new TextEncoder();

/** Reason payloads that expand differently once JSON escaping is applied. */
const EXPANSION_CASES = [
  { name: "C0 control bytes (6x expansion)", unit: "\u0000", factor: 6 },
  { name: "quotes (2x expansion)", unit: '"', factor: 2 },
  { name: "backslashes (2x expansion)", unit: "\\", factor: 2 },
  { name: "newlines (2x expansion)", unit: "\n", factor: 2 },
  { name: "3-byte multibyte (1x expansion)", unit: "→", factor: 1 },
  { name: "4-byte multibyte (1x expansion)", unit: "🙂", factor: 1 },
  { name: "plain ASCII (1x expansion)", unit: "a", factor: 1 },
] as const;

async function signAndParse(
  kind: PiControlKind,
  body: JsonValue,
): Promise<
  | { readonly ok: true; readonly bodyBytes: number }
  | { readonly ok: false; readonly failure: string }
> {
  const signed = await signEnvelope(
    {
      childId: "child-1",
      generationId: "gen-1",
      direction: "child-to-parent",
      sequence: 1,
      nonce: generateNonceHex(randomPort),
      correlationId: "child-1",
      kind,
      body,
    },
    secret,
    hmacPort,
  );
  if (signed.isErr()) return { ok: false, failure: signed.error.type };
  const verified = await verifyEnvelope(
    signed.value as unknown as JsonValue,
    secret,
    hmacPort,
  );
  if (verified.isErr()) return { ok: false, failure: verified.error.type };
  const parsed = parseControlBody(kind, verified.value.body);
  if (!parsed.ok) return { ok: false, failure: "ControlBodyInvalid" };
  return {
    ok: true,
    bodyBytes: canonicalizeToBytes(body)._unsafeUnwrap().byteLength,
  };
}

describe("jsonStringSerializedByteLength", () => {
  it("matches JSON.stringify byte-for-byte across every escape class", () => {
    const samples = [
      "",
      "plain ascii",
      '"quoted"',
      "back\\slash",
      "\u0000\u0001\u001f",
      "\b\f\n\r\t",
      "é→🙂",
      'mixed \u0007 " \\ 🙂 → é\n',
      "\u007f\u0080\u2028\u2029",
    ];
    for (const sample of samples) {
      expect(jsonStringSerializedByteLength(sample)).toBe(
        encoder.encode(JSON.stringify(sample)).byteLength,
      );
    }
  });
});

describe("serialized-aware diagnostic projection", () => {
  it("keeps the whole signed body under the 64 KiB cap for every expansion class", async () => {
    for (const testCase of EXPANSION_CASES) {
      // A source-sized reason: 32 KiB of source bytes, exactly the approved
      // source ceiling, before any escaping is applied.
      const unitSourceBytes = encoder.encode(testCase.unit).byteLength;
      const raw = testCase.unit.repeat(
        Math.floor(MAX_DIAGNOSTIC_REASON_BYTES / unitSourceBytes),
      );
      const rawSourceBytes = encoder.encode(raw).byteLength;
      expect(rawSourceBytes).toBeLessThanOrEqual(MAX_DIAGNOSTIC_REASON_BYTES);
      expect(rawSourceBytes).toBeGreaterThan(MAX_DIAGNOSTIC_REASON_BYTES - 4);
      // The expansion factor is real: this is what a source-only budget missed.
      expect(jsonStringSerializedByteLength(raw)).toBe(
        2 + rawSourceBytes * testCase.factor,
      );

      for (const kind of ["cancel", "error"] as const) {
        const body =
          kind === "cancel" ? makeCancelBody(raw) : makeErrorBody(raw);
        const outcome = await signAndParse(kind, body);
        expect({ case: testCase.name, kind, ok: outcome.ok }).toEqual({
          case: testCase.name,
          kind,
          ok: true,
        });
        if (!outcome.ok) continue;
        expect(outcome.bodyBytes).toBeLessThan(MAX_CONTROL_BODY_BYTES);
      }

      // The same reason on the largest diagnostic-bearing body kind.
      const settled = await signAndParse("settled", {
        outcome: "failed",
        reason: projectDiagnosticText(raw),
      });
      expect({ case: testCase.name, ok: settled.ok }).toEqual({
        case: testCase.name,
        ok: true,
      });
      if (settled.ok) {
        expect(settled.bodyBytes).toBeLessThan(MAX_CONTROL_BODY_BYTES);
      }

      const relayed = await signAndParse("delegate-response", {
        ok: true,
        settlement: { outcome: "failed", reason: projectDiagnosticText(raw) },
      });
      expect({ case: testCase.name, ok: relayed.ok }).toEqual({
        case: testCase.name,
        ok: true,
      });
      if (relayed.ok) {
        expect(relayed.bodyBytes).toBeLessThan(MAX_CONTROL_BODY_BYTES);
      }
    }
  });

  it("proves the unprojected C0 reason is exactly what used to blow the body cap", async () => {
    const raw = "\u0000".repeat(MAX_DIAGNOSTIC_REASON_BYTES);
    // 32 KiB of source becomes 192 KiB of `\u0000` escapes: 3x the cap.
    expect(jsonStringSerializedByteLength(raw)).toBe(
      2 + 6 * MAX_DIAGNOSTIC_REASON_BYTES,
    );
    const unprojected = await signAndParse("cancel", { reason: raw });
    expect(unprojected).toEqual({ ok: false, failure: "BodyTooLarge" });
    // The projected form of the identical reason signs and parses.
    const projected = await signAndParse("cancel", makeCancelBody(raw));
    expect(projected.ok).toBe(true);
  });

  it("accepts the exact serialized boundary and refuses one code point past it", () => {
    // Quotes double, so 24 KiB of them is exactly the 48 KiB serialized cap
    // once the two surrounding quote bytes are counted.
    const exact = '"'.repeat((MAX_DIAGNOSTIC_SERIALIZED_BYTES - 2) / 2);
    expect(jsonStringSerializedByteLength(exact)).toBe(
      MAX_DIAGNOSTIC_SERIALIZED_BYTES,
    );
    expect(fitsDiagnosticBudget(exact)).toBe(true);
    expect(fitsDiagnosticBudget(`${exact}"`)).toBe(false);
    for (const kind of ["cancel", "error"] as const) {
      expect(parseControlBody(kind, { reason: exact }).ok).toBe(true);
      expect(parseControlBody(kind, { reason: `${exact}"` }).ok).toBe(false);
    }
    // An exact-boundary value is returned untouched, with no marker.
    expect(projectDiagnosticText(exact)).toBe(exact);
    expect(projectDiagnosticText(`${exact}"`)).not.toBe(`${exact}"`);
  });

  it("keeps the source ceiling as the upper bound when nothing expands", () => {
    const exact = "a".repeat(MAX_DIAGNOSTIC_REASON_BYTES);
    expect(fitsDiagnosticBudget(exact)).toBe(true);
    expect(fitsDiagnosticBudget(`${exact}a`)).toBe(false);
    expect(projectDiagnosticText(exact)).toBe(exact);
    const projected = projectDiagnosticText(`${exact}a`);
    expect(encoder.encode(projected).byteLength).toBeLessThanOrEqual(
      MAX_DIAGNOSTIC_REASON_BYTES,
    );
    expect(projected).toEndWith(DIAGNOSTIC_TRUNCATION_MARKER);
  });

  it("projects every expansion class into both budgets, valid UTF-8, marked", () => {
    for (const testCase of EXPANSION_CASES) {
      const raw = testCase.unit.repeat(200_000);
      const projected = projectDiagnosticText(raw);
      expect({
        case: testCase.name,
        sourceOk:
          encoder.encode(projected).byteLength <= MAX_DIAGNOSTIC_REASON_BYTES,
        serializedOk:
          jsonStringSerializedByteLength(projected) <=
          MAX_DIAGNOSTIC_SERIALIZED_BYTES,
        marked: projected.endsWith(DIAGNOSTIC_TRUNCATION_MARKER),
        replacementFree: !projected.includes("\uFFFD"),
        fits: fitsDiagnosticBudget(projected),
      }).toEqual({
        case: testCase.name,
        sourceOk: true,
        serializedOk: true,
        marked: true,
        replacementFree: true,
        fits: true,
      });
      // The kept prefix is a whole number of the original code points: the
      // cut never lands inside one.
      const kept = projected.slice(0, -DIAGNOSTIC_TRUNCATION_MARKER.length);
      expect(kept).toBe(testCase.unit.repeat([...kept].length));
    }
  });

  it("binds on the serialized budget for escape-heavy text and on the source budget otherwise", () => {
    const c0 = projectDiagnosticText("\u0000".repeat(200_000));
    const c0Kept = c0.slice(0, -DIAGNOSTIC_TRUNCATION_MARKER.length);
    // 6 bytes per source byte: the serialized budget binds first, so only
    // about 8 KiB of source survives inside a 32 KiB source ceiling.
    expect(c0Kept.length).toBeLessThan(MAX_DIAGNOSTIC_REASON_BYTES / 3);
    expect(c0Kept.length).toBeGreaterThan(0);

    const ascii = projectDiagnosticText("a".repeat(200_000));
    const asciiKept = ascii.slice(0, -DIAGNOSTIC_TRUNCATION_MARKER.length);
    // No expansion: the 32 KiB source ceiling is what binds, minus the marker.
    expect(asciiKept.length).toBe(
      MAX_DIAGNOSTIC_REASON_BYTES -
        encoder.encode(DIAGNOSTIC_TRUNCATION_MARKER).byteLength,
    );
  });

  it("preserves the typed code and the explicit marker after a serialized cut", async () => {
    const body = makeErrorBody(`\u0000${"\\".repeat(200_000)}`);
    const outcome = await signAndParse("error", body);
    expect(outcome.ok).toBe(true);
    const parsed = parseControlBody("error", body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.reason).toEndWith(DIAGNOSTIC_TRUNCATION_MARKER);
  });
});
