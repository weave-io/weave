# Pi child ref run order: separate the ordering clock from the run count

## What went wrong

`packages/adapters/pi/src/child-session-refs.ts` used **one** counter for three
different jobs:

1. the run ordinal shown to a user (`run`, `totalRuns`),
2. the retained newest-last window over run history (`maxRuns`),
3. the persisted envelope ordering identity that decides which record wins on
   read (`sequence`).

They shared a single ceiling, `maxRunOrdinal: 1_000_000`. Two failures followed
from that, and both only appear late in a healthy thread's life:

- `appendRunDivider` rejected run 1,000,001 with `ChildRefInvalid`. A thread
  that had simply worked long enough could no longer run.
- `nextSequence` clamped with `Math.min(known + 1, maxRunOrdinal)`. At the
  ceiling every later append reused the same sequence, so `scanEntries`
  reported `duplicate-entry` and kept the **first** record it saw. Newest-wins
  resolution silently inverted: later lifecycle updates were discarded.

Raising the shared ceiling would only move both failures further out. The
counter still had to be a single monotonic lifetime value with a finite bound,
so it would still saturate eventually and still reuse values when it did.

## The rule

**Ordering identity is not a count.** A run ordinal answers "how many times was
this thread asked to work"; an envelope sequence answers "which persisted
record is newest". Give them separate fields with separate derivations, or a
window bound and a display bound will silently become a correctness bound.

## What the design is now

`PI_CHILD_REF_ORDER` holds the ordering identity as a **hybrid logical clock**:

```
sequence = max(previousSequence + 1, wallClockMillis)
```

- Strictly increasing per child, so a value is never reused and `duplicate-entry`
  cannot arise from a healthy append.
- Independent of the run count, so run dividers and lifecycle updates share one
  order without competing for the same numbers.
- Anchored to wall time, so a restarted store that has read nothing still
  outranks every earlier append; a store that *has* read is additionally seeded
  from the highest observed sequence.
- Fails closed rather than clamping. Clamping is what produced the silent
  inversion; a typed `ChildRefInvalid` on `sequence` is the safe degradation.

`maxSequence` is **derived, not chosen**: `appendedAt` stops being schema-valid
past `maxTimestamp` (year 2100), and the clock only outruns wall time by the
number of appends made faster than the clock ticks. Doubling the wall-clock
ceiling leaves about 4.1e12 spare ticks beyond any schema-valid instant, and
each tick would need its own separately persisted parent entry. No schema-valid
thread lifetime reaches it.

`maxRunOrdinal` is then derived from the same invariant instead of being an
independent literal: every run divider is one append and every append advances
the clock by at least one, so `run <= totalRuns <= sequence <= maxSequence`
holds for anything this store can write. Binding the ordinal to the clock
ceiling keeps the field finite without reintroducing a *lower* second ceiling
that a healthy thread would hit first.

`maxRuns: 64` survives, but only as what it always should have been: a bounded
newest-last display/ref window. Dropping its oldest entries is a projection
concern and never blocks an append.

## Compatibility notes worth keeping

- **Legacy refs still decode.** Old sequences are small run-derived integers, so
  any new append outranks them automatically — newest-wins keeps working across
  the change with no migration and no schema version bump.
- **Mirrored ceilings drift.** `child-overlay-types.ts` is the acyclic root of
  the overlay runtime and must not import the ref store, so it restates
  `maxRunOrdinal`. `child-metadata-cache.ts` can and does import the real bound.
  Anything that restates a ref bound needs an equality test pinning it, exactly
  like `maxTitleLength` already had — a stale mirror rejects precisely the
  long-lived threads the widening was for.
- **Not every wrapping counter is this bug.** `MAX_LIVE_ASSISTANT_LIFECYCLES` in
  `child-overlay-replay.ts` deliberately wraps: it is in-memory, per child, never
  persisted, and its wrap distance dwarfs the retained window, so a reused slot
  cannot collide with a live entry. The problem is a *persisted ordering* value
  that saturates, not a bounded counter as such.

## Test landmarks

Coverage that would have caught this must cross the boundaries, not just exceed
the window: run 65, run 1,001, run 1,000,001, several run dividers past that
point, several *lifecycle* appends at that point, and a restart in between. The
assertions that matter are that sequences stay strictly increasing and unique,
that `counts.duplicateEntries` is zero, and that the newest status is the one a
read returns.

Also note the shape of the tests this changed: two existing tests asserted exact
sequence values (`[1, 2, 3]`). Once ordering stopped deriving from the run count
those literals were wrong by construction. Assert the *contract* — increasing
and unique — not the arithmetic.
