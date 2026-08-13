# Pi generous child limits: budget the serialized wire, not the source text

## The mistake

Every "loosen this limit" change in this plan measured its new budget in
**source UTF-8 bytes**. That is the right unit for what a human wrote, and the
wrong unit for what the transport carries. Two ceilings in this adapter are
enforced on *serialized* bytes, and both were quietly overrun:

| Ceiling | Enforced on | Overrun by |
| --- | --- | --- |
| `MAX_CONTROL_BODY_BYTES` = 64 KiB | canonical JSON body bytes, before signing | a 32 KiB diagnostic reason |
| engine `resultJson` = 256,000 characters | the opaque adapter-command result envelope | a 128 KiB `children.result` page |

## Why source bytes are not a bound on serialized bytes

JSON string escaping has **no bounded expansion factor**. Per source byte:

| Content | Escaped as | Cost |
| --- | --- | --- |
| C0 control byte (not `\b \t \n \f \r`) | `\u00XX` | **6x** |
| `"` `\` `\b` `\t` `\n` `\f` `\r` | two characters | **2x** |
| ASCII printable | itself | 1x |
| non-ASCII | itself, UTF-8 | 1x |

So the approved 32 KiB diagnostic ceiling admits a reason that canonicalizes
to 192 KiB — three times the 64 KiB control body cap. The failure mode is
worse than an oversized message: `signEnvelope` returns `BodyTooLarge`, the
whole `cancel`/`error`/`settled` body never ships, and the **typed failure
code the body existed to deliver is destroyed by its own display prose**. The
projection was added precisely so oversized prose could never do that.

Identically, a 128 KiB authoritative `children.result` page of C0 bytes
serializes to 786,432 characters against a 256,000-character envelope: 3.07x
over, and the command fails for exactly the content it exists to return.

## The two fixes

**Diagnostics — project against both budgets.**
`child-diagnostic-projection.ts` now carries a source ceiling *and* a
serialized ceiling:

- `MAX_DIAGNOSTIC_REASON_BYTES` = 32 KiB stays the upper bound on source bytes.
- `MAX_DIAGNOSTIC_SERIALIZED_BYTES` = 48 KiB bounds the JSON string literal,
  quotes included. The largest diagnostic-bearing body (`delegate-response`)
  frames the reason in well under 200 bytes, so 48 KiB leaves 16 KiB of
  headroom inside the 64 KiB cap.

`projectDiagnosticText` walks by code point and stops at whichever budget
binds first, charging the truncation marker against both. Escape-heavy prose
therefore keeps less source text — about 8 KiB for pure C0 — which is correct:
the wire cost, not the character count, is the scarce resource.
`jsonStringSerializedByteLength` computes the exact cost without materializing
the escaped string, and is unit-tested against `JSON.stringify` for every
escape class.

**Authoritative results — encode, do not escape.**
`children.result` pages now travel as base64 under an explicit
`contentEncoding: "base64"`, with `contentByteOffset`, `contentByteLength`,
and a per-page `contentDigest` over the decoded bytes. Base64 is chosen for
one property: its expansion is a **fixed** `4 * ceil(n / 3)` for any bytes at
all. 128 KiB of decoded bytes is always 174,764 characters, leaving roughly
80,000 characters of envelope headroom no content can consume.

## The rule this produces

> A budget must be measured in the unit the ceiling that will reject it is
> measured in.

Concretely, for anything crossing a Weave/Pi boundary:

1. **Non-authoritative display text** may be projected. Project it against the
   serialized budget, cut on a code-point boundary, leave an explicit marker,
   and keep the typed code untouched.
2. **Authoritative bytes** may never be projected, so they must not be escaped
   into a text envelope either. Give them a byte-preserving encoding whose
   expansion is bounded and constant, and describe the window explicitly:
   encoding, decoded offset, decoded length, digest.
3. Never let a projection and an authoritative page share a field name or a
   command. `children.show --content` stays `contentKind:
   "sanitized-projection"`; `children.result` stays `exact: true` with a
   declared encoding. Neither can be read as the other.

## Test shape that would have caught it

Not "does a 32 KiB reason pass the schema" — it did. The test has to run the
whole path the value actually takes:

- diagnostics: project → build body → `canonicalizeToBytes` → `signEnvelope` →
  `verifyEnvelope` → `parseControlBody`, for **exact, exact-plus-one, C0,
  quotes, backslashes, and multibyte** inputs;
- results: dispatch through `dispatchAdapterCommand`, assert
  `resultJson.length` against the real envelope ceiling, then **decode the
  page and compare bytes** with the original.

A schema-only assertion proves the value is admissible. Only the end-to-end
assertion proves it is deliverable.
