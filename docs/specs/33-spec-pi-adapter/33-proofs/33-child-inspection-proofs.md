# Child-inspection acceptance proofs

This proof index ties the child-inspection and native-session contract to named
packed tests and the autonomous smoke checklist. The packed suite covers
rendering and fallback parity (P003), native interaction and recovery
(P004/P010), private projection and the parent-result boundary (P005/P006),
oversized native output (P007), explicit cleanup with tombstones (P008), and
settings validation including rejected legacy quota keys (P009).

ADR 0014 removed the JSONL child-history store, byte quotas, trimming, and
migration. There is no migration path; privacy and cleanup evidence now bind to
native Pi child sessions under the Weave XDG root.

The autonomous smoke is intentionally pending until it runs against the exact
packed artifact. A valid run must use disposable `XDG_DATA_HOME`,
`PI_CODING_AGENT_DIR`, and project roots; accept no human input; emit only
sanitized assertions/screenshots; and bind its report to artifact SHA-256,
subject SHA, exact host version, checklist version, and run attempt.

## Required live evidence

- S024–S031: inspection rendering, interaction, privacy, and bounded parent result.
- S032: more than 1 MiB native output, ten sequential runs and one maximum-
  parallelism batch, unique sentinels, and `childSettlementMissingCount: 0`.
- S033–S035: explicit cleanup/tombstones (no quotas), settings validation, and
  recovery/resume.
- S036: structured `ChildSettlementMissing` is rejected by discriminator even
  when logs contain no matching text.

The validator inspects structured results and private output directly. It never
uses log text as proof of settlement.
