# Learnings — Pi Generous Child Limits

Review discrepancies found on Task 13 and how each was resolved.

## 1. A shared scan budget cannot verify a group at the retained cap

**Discrepancy.** `readResultGroup` charged one shared 128 MiB budget across
every pass: the backward walk to the newest commit, the backward walk to that
group's index-0 chunk, and the forward verification pass. The budget was also
sized against the *decoded* 64 MiB result ceiling. A session's JSONL encodes
result payload as JSON strings, and a payload of C0 control bytes expands
sixfold (`U+0001` → `\u0001`). A 64 MiB result at worst-case escaping is about
385 MiB on disk, so the shared budget was exhausted long before the group could
be proven, and a legitimate result at the retained cap reported
`scan-exhausted`.

**Resolution.**

- The number of passes dropped from three to two. The backward walk now finds
  the newest commit *and* that group's index-0 chunk in one traversal; both
  facts live in the same trailing region, so two separate walks re-read it.
- Budgets are per pass, not shared. Each pass starts from a fresh
  `{pages, bytes}` counter, so no pass inherits another's spend.
- Both ceilings are derived, not chosen.
  `PI_NATIVE_RESULT_MAX_ENCODED_ENTRY_BYTES` is one full chunk at the
  worst-case escape factor plus a bounded envelope;
  `PI_NATIVE_RESULT_MAX_ENCODED_GROUP_BYTES` multiplies that by the chunk count
  a 64 MiB result can reach, plus the commit line.
  `maxScanBytesPerPass` is that number plus a fixed slack.

**Pitfall to keep in mind.** The derived per-entry ceiling must stay below
`PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxLineBytes` (512 KiB) and below
`maxBytesScanned` (1 MiB), or a fully escaped chunk line could not be read
inside one page budget and no scan could make progress. A 48 KiB chunk encodes
to about 289 KiB at worst, which clears both. Raising
`PI_NATIVE_RESULT_CHUNK_BYTES` past roughly 85 KiB would silently break this.

**Testing note.** Materializing a 385 MiB fixture is not reasonable in a unit
test. `child-result-integrity.test.ts` instead builds *one real* worst-case
chunk line, measures its exact encoded bytes, and asserts the production budget
constants clear that measurement times the production chunk count — so the
proof exercises the real budget calculation. Real escape-heavy round trips run
at sizes the in-memory port can hold.

## 2. Retrieval proved reachability, not identity

**Discrepancy.** `children.result` passed only the session ref and the origin
parent session. Any row that could reach a valid ref under the same parent was
served that session's result, so a sibling child of the same parent could be
handed another child's authoritative output. The continuation cursor carried
only `{resultId, chunkIndex}`, so a cursor also crossed child, session, and
commit boundaries freely.

**Resolution.**

- `readResultGroup(ref, expected, options)` now takes the full
  `{childId, nativeSessionId, parentSession}` identity. The ref component, the
  session header id, and the header parent are all proven before any scan; a
  mismatch is a typed `SessionCorrupt` / `identity-mismatch`.
- The cursor schema moved to version 2 and carries the identity plus the exact
  commit (`resultId` *and* `digest`). Identity mismatch is
  `identity-mismatch`; a different or changed commit is `stale-cursor`. Version
  1 cursors no longer decode.
- `children.result` passes the identity from the cache row it already holds,
  and maps `identity-mismatch` to a `Conflict`.

**Why the digest is in the cursor.** `resultId` alone lets a rewritten group
reuse an id. Binding the digest means a cursor can only resume the exact bytes
it was issued against.

## 3. Commit acceptance depended on a writer-side path check

**Discrepancy.** The host append is path-backed. The writer checked the leaf
`{dev,ino}` before the chunks, again before the commit, and once more after the
commit. That last check is *after* the commit is already durable: a leaf
replaced in the commit window left a fully formed, readable group on disk, and
any later reader accepted it as complete. The writer returning an error did not
change what a reader saw.

**Resolution.** Acceptance no longer depends on anything the writer does. The
commit record now carries the identity it was authorized against — child,
native session, origin parent, and the `{dev,ino}` of the leaf observed under
the held no-follow directory before the first chunk landed — and every reader
recomputes all five against the leaf it is actually reading. A commit that
reached a different leaf names a file it is not in, so it is never acceptable.

- Result entry `schemaVersion` moved to `2`. A version 1 commit does not decode,
  so an older record is reported absent rather than accepted on weaker evidence.
- `readNativeResultGroup(expected, entries)` takes the same acceptance contract,
  so the whole-array helper cannot accept a group the paged reader would refuse.
- The regression test writes the chunks and commit for real through a
  file-writing host, swaps the leaf in the exact commit window, and then reads
  with a *fresh* store: the commit is durable, and the read is still incomplete
  with `identity-mismatch` and no content.

**Pitfall to keep in mind.** This makes an inode change fatal to an existing
result. That is intended and consistent with `requireSameLeafIdentity`, which
already refuses a session whose leaf changed. Any future rotation or rewrite of
a session file would have to re-commit its results.

## 4. A durable `completed` lifecycle preceded result persistence

**Discrepancy.** In `direct-dispatch-transport.ts`, the terminal lifecycle
append ran before `persistCompletedOutput`. A `completed` lifecycle record is a
durable claim that the step's result is retrievable, so a persistence failure
left the ref saying `completed` while no result existed.

**Resolution.** Result persistence now runs first, and the terminal lifecycle
status is derived from it: persistence failure produces a `failed` lifecycle
and a failed settlement. The step still writes exactly one terminal record.

**Note on the ordinary delegation path.** `delegation-controller.ts` was already
correct for a different reason: `persistPrivateOutput` runs from the child's
private-output observer, which `rpc-child.ts` awaits before the child settles,
and `recordThreadSettlement` runs after settlement. The ordering there is a
consequence of the settlement-capture gate, not an explicit sequencing — worth
remembering before that gate is refactored.

## 5. Read-time identity authorized a leaf the scan never had to read

**Discrepancy.** `readResultGroup` proved the ref, the header, and the leaf
`{dev,ino}` up front, then ran both scan passes through
`readSessionEntryPage`, which reopens the session *by name* for every page. The
authorization and the reads were therefore about different files. A leaf
replaced after authorization was scanned as if it were the authorized file, and
because the commit record inside a file can claim any `{dev,ino}`, a
replacement carrying the authorized identity was accepted as `complete` and its
bytes returned as authoritative.

**Resolution.** The leaf is resolved by name exactly once. `readResultGroup`
opens one held no-follow directory, opens the session file once, and runs
header validation, the backward anchor pass, and the forward verification pass
against that single identity-bound descriptor. The descriptor's own `{dev,ino}`
*is* the authorization passed to `commitIdentityMatches`, and the port
re-verifies the held descriptor and the directory leaf around every content
read, so a replacement anywhere inside the read window fails closed and typed.
One final `stat` after the scan repeats the check. No reopen means no window
where "the leaf I authorized" and "the leaf I read" can differ.

**Pitfall to keep in mind.** The generic `readSessionEntryPage` still reopens
per page, which is correct for the *interactive* history pager: each call is an
independent, cursor-checked read, and the cursor carries `{dev,ino}`. It is not
correct for a multi-page proof of a single artifact. Any future scan that
verifies one durable object must page from a held descriptor, not from the
cursor API.

## 6. The scan budget was derived from group size, not from paging cost

**Discrepancy.** `maxScanBytesPerPass` was `encoded group + 32 MiB slack`
(438,098,944 bytes), which counts every group byte exactly once. Paging does
not read that way. The forward pass resumed with `direction: "newer"`, and
`pageNewer` re-reads the cursor's anchor line before it can find where the next
line starts. With a worst-case escaped entry line of ~295 KiB and a 1 MiB page
ceiling, a page fits three such lines and spends one of them on the anchor, so
1,367 entries needed ≥604,340,224 bytes — well past the budget, and a
legitimate result at the retained cap reported `scan-exhausted`.

**Resolution.** Both halves changed.

- *Paging no longer re-reads anchors.* Because the whole read now runs on one
  descriptor, position is a plain byte offset. The forward pass resumes at the
  byte immediately after the last line it consumed; the backward pass resumes
  at the offset of the oldest line it returned. No line is read to discover
  where a page starts.
- *The budget is derived from measured paging cost.* A pass pays for every
  region byte once, plus a bounded re-read per page boundary:
  `scanPageRereadBytes = maxLineBytes + PI_NATIVE_SESSION_MAX_RANGE_LENGTH`
  (589,824) covers both ways a page can stop — mid-line at the byte ceiling, or
  on the entry limit with part of a range chunk already pulled. A page that
  stops on its byte ceiling therefore consumes at least
  `scanPageProgressFloorBytes = maxBytesScanned - scanPageRereadBytes`
  (458,752), which bounds the page count:

  ```
  region  = encoded group (404,544,512) + slack (33,554,432) = 438,098,944
  pages  <= ceil(region / 458,752) + ceil(9,559 entries / 100) + 2 = 1,053
  bytes  <= region + pages * 589,824                              = 1,059,183,616
  ```

  That is the production `maxScanPagesPerPass` / `maxScanBytesPerPass`, and it
  clears the reproduced 604,340,224-byte requirement with room to spare.

**Pitfall to keep in mind.** The byte ceiling is *I/O*, not memory. A page
still holds at most `PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS.maxBytesScanned`
(1 MiB), and the streamed group is never allocated. Raising `maxLineBytes` or
lowering `maxBytesScanned` shrinks the progress floor, and if the floor ever
reaches zero the page count stops converging — `child-result-integrity.test.ts`
asserts the floor is positive and that one worst-case entry still fits inside
it.

**Testing note.** The budget proof no longer compares a constant against raw
group size. It builds one real worst-case chunk line, feeds the measurement
through the same paging model the production constants use, and asserts the
constants cover the modeled pages *and* bytes. A separate test runs a real
escape-heavy multi-page read through a recording port and asserts the measured
bytes stay inside the model, so the model is checked against actual paging I/O
rather than trusted.

## 7. A hidden cumulative cap survived in a module nobody listed

**Discrepancy.** The plan removed the cumulative `maxRuns` of 1,000 from
`delegation-controller.ts`, but `child-session-refs.ts` held its own
`maxRuns: 64` and used it for two different jobs at once: the size of the
`runs` array stored in a parent entry *and* the ceiling on a run's ordinal.
`appendRunDivider` computed `record.runs.length + 1` and failed
`ChildRefInvalid` at run 65, so a thread that had already been retried 64 times
could never run again. The failure was durable — the count lives in a persisted
parent entry, so a restart reproduced it — and it was invisible from the
delegation limits the plan actually edited.

Three downstream projections carried the same conflation: the metadata cache
bounded `runCount` at 64, and the overlay descriptor and replay schemas bounded
the run *ordinal* at their 64-entry window size, so a valid run-65 divider would
have failed validation on the way to the UI.

**Resolution.** A window and a count are now separate things.

- `PI_CHILD_REF_BOUNDS.maxRuns` (64) bounds only the retained newest-last
  window; `maxRunOrdinal` (1,000,000) bounds the ordinal and the new
  `totalRuns` field. `appendRunDivider` trims the window and keeps appending.
- `totalRuns` is optional, so refs written before it existed still parse;
  `childRefTotalRuns` treats such a record's window as its whole history.
- `delegation-controller.ts` reconstructs live run state from
  `childRefTotalRuns`, not `runs.length`, so a restarted thread resumes its real
  ordinal instead of restarting inside the window.
- The overlay exports one `ChildOverlayRunOrdinalSchema` bounded by the ordinal
  ceiling, and the metadata cache mirrors the ordinal ceiling for `runCount`.
  Array sizes stayed at 64.

**Pitfall to keep in mind.** When a limit is removed, grep for the *number* and
for every field the removed limit fed, not just the module named in the plan.
A constant reused for "how many we keep" and "how high the counter goes" reads
as one bound and behaves as two. `child-compact-render.ts` was already correct
here, and its shape is the one to copy: `slice(-MAX_RUNS)` on the window, no
bound on `runNumber` at all.

## 8. A schema rejected input the projection policy would have fixed

**Discrepancy.** Task 6 introduced a 32 KiB UTF-8 diagnostic projection with a
truncation marker, but only the settlement failure reason used it. The protocol
`cancel` and `error` reasons kept `z.string().max(2_000)`, which is wrong twice
over. It counts UTF-16 code units where every other ceiling counts UTF-8 bytes,
and — worse — it *rejects* rather than shortens: an ordinary 2,001-character
reason failed the whole body, and with it the typed protocol code the body
existed to deliver. Truncating display prose loses prose; rejecting the body
loses the diagnosis.

Two independent copies of the same UTF-8-safe truncation loop had also grown, in
`child-runtime.ts` and `structured-completion.ts`.

**Resolution.** `child-diagnostic-projection.ts` now owns the single policy —
`MAX_DIAGNOSTIC_REASON_BYTES`, `DIAGNOSTIC_TRUNCATION_MARKER`,
`projectDiagnosticText`, `fitsDiagnosticBudget` — and all three call sites use
it. `cancel` and `error` reasons validate against the same 32 KiB UTF-8 bound
as the failure reason, and `makeCancelBody` / `makeErrorBody` project before
signing.

**Pitfall to keep in mind.** Order matters more than the number: *project, then
validate*. A schema placed before the projection turns a graceful degradation
into a hard failure, and the symptom appears at the protocol layer rather than
at the text that caused it. When a policy is approved for one field, check every
field of the same kind in the same file before assuming it landed.

**Testing note.** Byte-boundary tests must use multibyte input to mean anything:
`"🙂".repeat(8_192)` is 8,192 UTF-16 units and exactly 32,768 UTF-8 bytes, so it
passes a character cap and sits exactly on the byte cap. The projection tests
assert the cut lands on a code-point boundary by rebuilding the kept prefix from
its own code points, not by counting bytes alone.
