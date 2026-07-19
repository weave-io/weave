# Stable release trains

Stable cuts begin at the green protected `main` SHA, using the GitHub server time as `cutAt`. A train expires **at** `cutAt + 7 days`; the boundary is exclusive. Its content-addressed record holds the release ref, deterministic versions, exact consumed stable Changeset paths and preimage digests, plus content-addressed metadata writes for later replay.

Only stable-partition Changesets are consumed. Claude-only and post-cut files are recorded as preserved paths and are never included in the worktree plan. Stable package output is restricted to CLI and OpenCode.

`stable-fix` accepts only explicit green commits proven merged to `main`. It never merges `main`; the `release-refs` environment creates/updates refs with a read-current-head then ordinary non-force GitHub ref update. A changed head is a typed stale-CAS failure. A fix removes recorded artifact IDs and manifest binding so a new release SHA must rebuild and bind artifacts before any future OIDC action.

The `release` environment authorizes plan generation, while the separate `release-refs` environment alone holds the App token for ref mutation. Build/pack callers must verify `git status --porcelain` is empty before and after treating the release checkout as input.

Metadata replay, OIDC publishing, promotion, and finalization are intentionally deferred to their subsequent release-control stages.
