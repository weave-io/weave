# 33 — Pi adapter: bounded transfers, acknowledged delivery, and settlement fields

Status: active. Owner: Pi adapter.

This specification governs how a private Pi child receives its work and returns
its result. It exists because a child could produce valid output that never
reached its parent: the parent then waited out its settlement timer and reported
`ChildSettlementMissing`, a code that names the symptom and hides the cause.

The rule this document enforces: **a child of any output size either returns its
result or fails with a typed error that names the real cause.** No delivery
problem may surface as a settlement timeout.

## 1. The three limits

Three numbers bound three different things. Conflating them is the bug this
specification prevents, so each has its own name, its own owner, and its own
test.

| Limit | Frozen value | Bounds | Owner |
| --- | --- | --- | --- |
| Native record cap | 8 MiB | One native Pi JSONL record on the wire | Pi's own protocol; `child-framing.ts` |
| Signed control-body cap | 64 KiB | One authenticated Weave control-envelope body | Weave security boundary; `child-envelope.ts` |
| Logical transfer cap | 64 MiB | One reassembled chunked-transfer payload | Weave transfer protocol; `child-transfer.ts` |

The signed control-body cap is a **security bound**: it is the amount of bytes a
single signature covers. It is never raised to make a payload fit. A payload
larger than a signed body is split into chunks that each fit inside one, which
is why the logical transfer cap grows independently of the other two.

The native record cap is not a Weave choice. Weave only refuses to buffer past
it, and reports that refusal as a typed framing error rather than letting a
runaway record poison the stream.

### Frozen constants

`PI_TRANSPORT_LIMITS` in `packages/adapters/pi/src/errors.ts` is the single
registry. `__tests__/failure-taxonomy.test.ts` freezes every value and proves
the registry agrees with `child-framing.ts`, `child-envelope.ts`, and
`child-tree.ts`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `nativeRecordBytes` | 8 MiB | Native Pi JSONL record cap |
| `signedControlBodyBytes` | 64 KiB | Signed control-body cap |
| `transferChunkPayloadBytes` | 24 KiB | Decoded payload bytes per chunk |
| `transferAggregateBytes` | 64 MiB | Reassembled transfer payload cap |
| `transferMaxChunks` | 65 536 | Chunks per transfer |
| `maxConcurrentTransfers` | 32 | Transfers one assembler tracks at once |
| `transferAckTimeoutMs` | 10 000 | Bounded wait for ACK or NACK |
| `transferMaxRetries` | 1 | Retries before a typed failure |
| `parentProjectionBytes` | 4 KiB | Cap on output projected to the parent model |

24 KiB of payload base64-encodes to 32 KiB, which leaves room for envelope
metadata inside the 64 KiB signed body. That headroom is asserted by test, not
assumed.

Changing any value here is a protocol change and must land with its test.

## 2. Failure codes

Four codes name transfer failures. They belong to the `protocol` phase and carry
the logical channel (`prompt`, `delegate-request`, or `output`) in correlation.

| Code | Raised when | Retryable |
| --- | --- | --- |
| `ChildTransferTimedOut` | No ACK or NACK arrived within the bounded wait | yes |
| `ChildTransferRejected` | The peer NACKed a chunk as malformed, duplicated, or out of range | yes |
| `ChildTransferTooLarge` | The payload exceeds the aggregate transfer cap | no |
| `ChildDeliveryFailed` | Delivery failed after the single bounded retry | yes |

`ChildTransferTooLarge` is not retryable: retrying an oversized payload
reproduces the same rejection.

Every `reason` in correlation is a closed, fixed string chosen by the transfer
module. Raw error text never reaches a correlation field, a log, or the TUI.

### The code these replace

`ChildSettlementMissing` remains, and keeps its original meaning: a child that
genuinely never settled. It is no longer the code a delivery problem produces.
A child that never received its prompt fails with a transfer code that says so.

## 3. The acknowledged transfer protocol

Every chunked transfer is acknowledged. The sequence is:

1. The sender splits the payload into chunks of at most
   `transferChunkPayloadBytes` decoded bytes, tagged with a transfer id, an
   index, and a total.
2. The sender writes every chunk, honouring stdin backpressure.
3. The receiver assembles chunks, enforcing per-chunk bytes, aggregate bytes,
   chunk count, and concurrent-transfer caps.
4. The receiver replies exactly once per transfer through its existing
   authenticated control path: an ACK on complete reassembly, a NACK carrying a
   closed reason otherwise.
5. The sender waits at most `transferAckTimeoutMs`. On NACK or timeout it
   retries the whole transfer once. A second failure produces a typed transfer
   failure.

The receiver rejects duplicate indices, indices outside `[0, total)`, totals
inconsistent with the transfer already in flight, chunks whose decoded size
exceeds the per-chunk cap, payloads whose running total exceeds the aggregate
cap, and new transfers beyond the concurrency cap. Each rejection has its own
closed reason.

Transfers may interleave. The assembler tracks up to `maxConcurrentTransfers`
independently and evicts nothing silently: exceeding the cap is a typed
rejection, not a quiet drop.

## 4. Settlement field layout

Settlement carries structured fields. It never repurposes one field to mean two
things.

A completed settlement has these structured fields:

- `assistantOutput` — the bounded parent projection;
- `completionCandidate` — direct-step structured completion JSON, never prose;
- `outputTransferId` — optional reference to an ACKed private output transfer;
- `outputByteLength` — numeric metadata for the full private output.

A direct-step child's structured completion candidate has its own field. The
parent interpreter reads that field and only that field when interpreting a
direct-step completion. Ordinary assistant output stays in its own separate
field, and the parent never parses it as a completion candidate.

This replaces the previous arrangement, in which a direct-step child serialized
its completion candidate into the summary field while the parent overwrote that
same field with terminal assistant text. Because a terminal `weave_complete_step`
message is a tool-use message, its extracted text was empty, and a valid
completion degraded to `CompletionSignalMissing`.

When final output exceeds `parentProjectionBytes`, the child sends it as
authenticated `transfer-chunk` controls *before* the terminal settlement
envelope. The parent reassembles it privately and replies with authenticated
`transfer-result` ACK or NACK; only after ACK does the child settle referencing
that transfer. Exactly-once settlement, strict sequence ordering, sequence
rollback on failed writes, and the single bounded retry all hold unchanged. A
failed output transfer degrades to bounded inline `assistantOutput` plus
`outputByteLength` — never to no settlement at all.

## 5. The parent projection rule

Full output is private. Bounded output is projected.

The inspector and the history service receive the complete output. The parent
model, controller results, and workflow completion receive only a projection
bounded by `parentProjectionBytes`, plus numeric metadata such as byte counts
and event counts.

Transcripts, thinking, tool calls, tool results, and extension UI events never
cross that boundary in either direction. Numeric metadata may cross; content may
not.

## 6. What must not weaken

Authentication, nonce and sequence checks, one-shot settlement, force-kill, and
the 64 KiB signed control-body cap are invariants. No transfer feature may relax
any of them. In particular, a larger payload is always solved by more chunks,
never by a larger signed body.
