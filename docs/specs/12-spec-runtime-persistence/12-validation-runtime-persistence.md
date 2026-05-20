# Validation Report: Runtime Persistence (Spec 12)

**Validation Date:** 2026-05-20
**Validated By:** openai/gpt-5.5 (via Weft)
**Overall:** PASS
**Implementation Ready:** Yes

---

## 1. Executive Summary

Spec 12 Runtime Persistence validates successfully. All 54 functional requirements across U1–U6 have concrete implementation and/or test evidence, all proof artifacts are accessible, the full test suite passes with 1305 tests, typecheck passes, and the three previously reported HIGH blockers are fixed.

**Validation gates:** A PASS, B PASS, C PASS, D1 PASS, E PASS, F PASS.

**Key metrics:**
- Functional Requirements: 54/54 PASS (100%)
- Proof Artifacts: 6/6 accessible and functional
- Full suite: `bun test` → 1305 pass, 0 fail
- Typecheck: `bun run typecheck` → all packages exit 0
- Credential scan: no real credentials found in proof artifacts

---

## 2. Coverage Matrix

### Functional Requirements

| Requirement ID/Name | Status | Evidence |
| --- | --- | --- |
| U1-FR1 top-level `settings` block | PASS | `packages/core/src/schema.ts`, `validate.ts`; tests in core schema/validate/parser/parse_config |
| U1-FR2 accept `settings { log_level INFO }`, reject top-level `log_level` | PASS | `validate.ts:139-200`; proof `12-task-01-proofs.md` |
| U1-FR3 accept `settings.runtime.journal.strict`, default false | PASS | `schema.ts:200-220`; tests verified |
| U1-FR4 normalized settings object | PASS | `WeaveConfigSchema.settings`; config merge tests |
| U1-FR5 schema/parser/validate/full tests updated | PASS | 122 targeted core tests in proof artifact |
| U2-FR1 runtime domain types in engine | PASS | `packages/engine/src/runtime/types.ts` |
| U2-FR2 workflow statuses exact enum | PASS | `WORKFLOW_INSTANCE_STATUSES` in `types.ts` |
| U2-FR3 artifacts refs/metadata only | PASS | `ArtifactRef`, `WorkflowInstance.artifacts`; CRUD tests |
| U2-FR4 lease fields | PASS | `ExecutionLease` includes id/workflow/owner/acquired/expires/heartbeat |
| U2-FR5 lease identifies active workflow; no pointer | PASS | `ExecutionLease.workflowInstanceId`; lease repo |
| U2-FR6 one active lease per project | PASS | SQLite/memory lease conflict tests |
| U2-FR7 atomic expiry/check with one clock source | PASS | injected `clock`; `SqliteExecutionLeaseRepository.acquire()` |
| U2-FR8 expired replace, unexpired conflict | PASS | runtime SQLite/memory tests |
| U2-FR9 normalized session snapshots only | PASS | `SessionSnapshot` type and snapshot tests |
| U2-FR10 snapshot excludes secrets/private payloads | PASS | `sanitizeSnapshotMetadata`; tests |
| U2-FR11 repository methods use `ResultAsync` | PASS | `runtime/store.ts` interfaces |
| U2-FR12 find/get null vs NotFound semantics | PASS | contract tests |
| U2-FR13 RuntimeStore composition and transactions | PASS | `RuntimeStore`, transaction tests |
| U3-FR1 Kysely dependency | PASS | `packages/engine/package.json`, `bun.lock` |
| U3-FR2 Bun SQLite dialect; no Node SQLite deps | PASS | `kysely-bun-sqlite.ts`; grep found no `better-sqlite3`/`node:fs`/`child_process` |
| U3-FR3 lazy `.weave/runtime/weave.db` creation | PASS | `SqliteRuntimeStore.ensureInitialized()` and tests |
| U3-FR4 versioned idempotent migrations | PASS | `sqlite/migrations.ts`; migration tests |
| U3-FR5 restrictive permissions | PASS | `chmod 700/600` in `store.ts` |
| U3-FR6 transactional migrations | PASS | `runMigrations()` transaction block |
| U3-FR7 newer schema fails typed | PASS | `migration_version` tests |
| U3-FR8 JSON rows + indexed columns | PASS | `sqlite/schema.ts`, migration SQL |
| U3-FR9 required runtime tables incl metadata salt | PASS | `runtime_metadata`; project salt lifecycle tests |
| U3-FR10 source-of-truth writes fail on persistence errors | PASS | repository ResultAsync error paths |
| U3-FR11 journal best-effort default / strict setting | PASS | writer wiring in SQLite/memory transactions |
| U3-FR12 best-effort commits; strict rolls back | PASS | memory strictJournal tests; SQLite strict rollback tests |
| U3-FR13 fixed default DB path | PASS | CLI `DEFAULT_RUNTIME_DB_PATH` |
| U3-FR14 future path config out of scope noted | PASS | spec/task unchanged; no configurable path added |
| U4-FR1 journal observational, not state source | PASS | types/proof; no replay dependency |
| U4-FR2 fixed journal envelope | PASS | `RuntimeJournalEntry`, `RuntimeJournalWriter.validateEnvelope()` |
| U4-FR3 structured source indexed | PASS | `source_kind`, `source_name` columns/indexes |
| U4-FR4 JSON serializable, size bounded, sanitized | PASS | writer/sanitizer tests |
| U4-FR5 no raw prompts/completions; salted fingerprints | PASS | sanitizer + fingerprint tests |
| U4-FR6 project salt CSPRNG ≥128 bits | PASS | `createProjectSalt()` uses 16 random bytes |
| U4-FR7 SHA-256 or stronger | PASS | `fingerprintContent()` uses Web Crypto SHA-256 |
| U4-FR8 recreated store gets new salt | PASS | SQLite salt lifecycle tests |
| U4-FR9 adapters use narrow writer | PASS | `RuntimeJournalWriter` exported; transaction writers wired |
| U4-FR10 writer validates/sanitizes/fingerprints boundary | PASS | `journal-writer.ts`, `sanitizer.ts`, tests |
| U4-FR11 64 KiB payload bound | PASS | `MAX_DATA_BYTES = 64 * 1024`; tests |
| U4-FR12 deny secrets/raw content | PASS | denylist sanitizer; proof and tests |
| U4-FR13 retention deferred, timestamp indexes | PASS | no cleanup commands; timestamp index present |
| U5-FR1 export `createInMemoryRuntimeStore()` | PASS | engine barrel exports |
| U5-FR2 same interfaces/transaction semantics | PASS | `memory-store.ts`; contract tests |
| U5-FR3 injectable failure modes | PASS | `InMemoryRuntimeStoreFailureConfig` |
| U5-FR4 no harness/filesystem writes | PASS | in-memory `Map` implementation |
| U6-FR1 read-only `runtime status` | PASS | `packages/cli/src/commands/runtime.ts`; CLI tests |
| U6-FR2 status reports path/schema/lease/workflows | PASS | `Schema version:` output verified |
| U6-FR3 read-only `runtime journal --limit` | PASS | CLI parser/runtime tests |
| U6-FR4 deterministic TOON-style journal output | PASS | deterministic output test |
| U6-FR5 no filters/export/cleanup/write commands | PASS | only status/journal routes implemented |

### Repository Standards

| Standard Area | Status | Evidence & Compliance Notes |
| --- | --- | --- |
| Bun-only runtime | PASS | Uses `bun:sqlite`, `Bun.file`, `Bun.spawnSync`; allowed `node:path`/`node:os`; no forbidden Node APIs found |
| `neverthrow` fallible APIs | PASS | Runtime repository interfaces and implementations return `ResultAsync<..., RuntimeStoreError>` |
| No `console.*` in library code | PASS | `grep console\.` across `packages` returned 0 matches |
| Pino logging | PASS | journal/store warnings use shared `logger.child(...)` |
| Discriminated errors | PASS | `RuntimeStoreError` union in `errors.ts` |
| Classes for state/behaviour | PASS | SQLite/memory store repos and store classes |
| Scope control | PASS | Source changes map to Spec 12 U1–U6; `.codesight` changes are non-source metadata |

### Proof Artifacts

| Unit/Task | Proof Artifact | Status | Verification Result |
| --- | --- | --- | --- |
| U1 | `12-task-01-proofs.md` | PASS | Exists; includes targeted tests, typecheck, full suite evidence |
| U2 | `12-task-02-proofs.md` | PASS | Exists; includes domain/interface tests and typecheck evidence |
| U3 | `12-task-03-proofs.md` | PASS | Exists; includes SQLite/migration/CRUD/journal evidence |
| U4 | `12-task-04-proofs.md` | PASS | Exists; includes journal/fingerprint/security review evidence |
| U5 | `12-task-05-proofs.md` | PASS | Exists; includes memory store tests and public export evidence |
| U6 | `12-task-06-proofs.md` | PASS | Exists; includes CLI tests/build/read-only evidence |

---

## 3. Validation Issues

No blocking issues found.

---

## 4. Evidence Appendix

### Git Commits Analyzed

| Commit | Task | Description |
| --- | --- | --- |
| `7734b90` | U1 | feat(core): migrate log_level into settings block |
| `b3871fb` | U2 | feat(engine): define Runtime Store domain interfaces |
| `595f886` | U3 | feat(engine): implement SQLite/Kysely Runtime Store |
| `75a94a6` | U4 | feat(engine): add Runtime Journal writer and fingerprinting |
| `b79d4c5` | U5 | feat(engine): add in-memory runtime store test utility |
| `aa67d60` | U6 | feat(cli): add read-only runtime inspection commands |
| `5ecd6e3` | U3/U4/U5 | fix(engine): resolve Weft review findings — crypto, snapshot sanitization, best-effort journal |
| `92527c2` | U3/U4/U6 | fix(engine,cli): resolve validation blockers — project salt, strict journal wiring, schema version in status |

### Commands Run

```
bun test
→ 1305 pass, 0 fail, 3436 expect() calls

bun run typecheck
→ all 5 packages: exit 0

ls docs/specs/12-spec-runtime-persistence/12-proofs/
→ 12-task-01-proofs.md  12-task-02-proofs.md  12-task-03-proofs.md
   12-task-04-proofs.md  12-task-05-proofs.md  12-task-06-proofs.md

grep -r "createProjectSalt" packages/engine/src/runtime/sqlite/store.ts
→ match found (project salt lifecycle implemented)

grep -r "RuntimeJournalWriter" packages/engine/src/runtime/sqlite/store.ts packages/engine/src/runtime/memory-store.ts
→ matches found in both files (strict journal wiring implemented)

grep -r "Schema version\|schemaVersion\|CURRENT_SCHEMA_VERSION" packages/cli/src/commands/runtime.ts
→ matches found (schema version rendered in status output)

grep -r "node:crypto\|Buffer" packages/engine/src/runtime/
→ no import or usage found (Web Crypto API used instead)

grep -r "better-sqlite3\|node:fs\|child_process" packages/engine/src/
→ no matches (Bun-only constraint satisfied)
```

### GATE F — Credential Scan

High-confidence scan of `docs/specs/12-spec-runtime-persistence/12-proofs/*.md` found no real API keys, tokens, passwords, or sensitive credentials.

---

**Validation Completed:** 2026-05-20
**Validation Performed By:** openai/gpt-5.5 (via Weft)
