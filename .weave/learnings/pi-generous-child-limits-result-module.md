# Learning — splitting the Pi durable-result protocol out of the session store

## Context

`packages/adapters/pi/src/child-native-sessions.ts` had grown to 5,041 lines. It
owned two different things at once: the Weave-owned native session tree
(filesystem containment, session lifecycle, JSONL paging) and the durable
child-result protocol (wire schemas, identity rules, encoded budgets, chunking,
and the bounded group scanner). A structural review blocked the file: the
security argument for durable results was spread across a store class that also
resolved paths, opened directories, and validated headers.

## What changed

The file is now three modules with a strictly acyclic dependency graph:

```
child-native-session-contracts.ts   (no adapter imports)
        ^                    ^
        |                    |
child-native-results.ts      |
        ^                    |
        +---- child-native-sessions.ts
```

| Module | Owns |
| --- | --- |
| `child-native-session-contracts.ts` | The closed failure taxonomy, the injected no-follow filesystem port, the host session port, the session record/header shapes, the read ceilings, and the shared base64url cursor codec. No behaviour beyond mapping one failure set onto another. |
| `child-native-results.ts` | The durable-result protocol end to end: entry types, schemas, identity and commit-identity rules, the encoded-budget derivation, chunk splitting and digesting, the whole-array reader, the append sequence, and the bounded two-pass scanner. Owns no storage. |
| `child-native-sessions.ts` | Native session ownership: root resolution, containment, creation/open/delete, tombstones, JSONL line paging, header validation, and the store methods that authorize a descriptor before handing it to the result protocol. |

`child-native-sessions.ts` re-exports the moved public names, so every existing
importer and `index.ts` entry keeps working unchanged.

## The seam that made the split work

The scanner used to be two private store methods that took a file handle, a
ref, a stat, and an offset. It now runs over one narrow interface:

```ts
interface PiNativeResultScanSource {
  readonly ref: string;
  readonly size: number;
  readonly headerEnd: number;
  readonly leaf: PiNativeResultLeafIdentity;
  readBackward(endExclusive: number, limit: number): ResultAsync<PiNativeResultScanPage, PiNativeSessionError>;
  readForward(offset: number, limit: number): ResultAsync<PiNativeResultScanPage, PiNativeSessionError>;
}
```

The store builds a source from one already-authorized descriptor, after the
header proved the child, native session, and origin parent. The protocol then
sees lines and offsets only — no path, no directory, no way to reopen anything.
That is what turns "every returned byte came from one proven leaf" into a
property of the type instead of a property of the call sites.

The write side got the mirror-image seam: the protocol decides *when* each
storage check runs (`PiNativeResultAppendGuards.beforeChunks` /`beforeCommit`
/`afterCommit`), and the store decides *what* a check proves, because only it
holds the directory and the leaf. The audited order — prove identity, prove the
leaf, write chunks, prove leaf and live session, write the commit, prove the
leaf again — is now stated once, in `appendResultGroup`.

## Rules worth keeping

1. **Extract the contracts before extracting the behaviour.** The first attempt
   would have left `child-native-results.ts` importing types from
   `child-native-sessions.ts` while the store imported values back. `import type`
   is erased at runtime, so that "works" — and it still leaves a cycle in the
   module graph that the next reader has to reason about. Moving the failure
   taxonomy and the ports down into a third module removed the back edge
   entirely.
2. **A limit belongs to exactly one module.** `PI_NATIVE_SESSION_ENTRY_PAGE_BOUNDS`
   and `PI_NATIVE_SESSION_MAX_RANGE_LENGTH` feed the encoded scan-budget
   derivation, so they now live in the contracts module and are imported by
   both sides. A copy would silently change what a budget proves. The module
   isolation test asserts the store restates none of them.
3. **Shared budget helpers move with the budget.** The bounded thread-metadata
   scan reuses the result scan's page/byte ceilings, so `PiNativeResultScanBudget`
   and `exceedsResultScanBudget` are exported rather than duplicated.
4. **Prove isolation with a test, not a convention.**
   `__tests__/child-native-results-module.test.ts` reads the source of both new
   modules and asserts the import graph, and it proves a committed group over an
   array-backed source that touches no filesystem. A refactor that reintroduces
   a storage dependency fails there first.

## Pitfalls hit during the move

- Deleting extracted line ranges from the original file must be done in strictly
  descending order. Applying a lower range after a higher one silently removed
  the wrong lines (it truncated a type alias mid-declaration). Verify with
  `tsc --noEmit` immediately after each mechanical move, not at the end.
- BSD `sed -i ''` does not support `\b`; use `perl -pi -e` for word-boundary
  renames in this repo.
- `parseJsonlBodyLine` only ever yields non-null objects for `kind: "entry"`, so
  an absent `entry` field is a safe "not a decodable body line" sentinel in the
  scan-page type. Keep that invariant if the parser changes.
