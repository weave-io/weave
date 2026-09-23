# docs/artifacts — Non-Normative Artifact Archive

This directory holds non-normative historical artifacts: proof outputs, terminal captures, diff summaries, and audit evidence produced during spec implementation.

**These files are not maintained as the system evolves.** They are audit history, not reference documentation.

See [Documentation Policy](../documentation-policy.md) for the full classification rules and retention policy.

---

## Index

- [`opencode2-feasibility/`](opencode2-feasibility/README.md) — go/no-go feasibility evidence for the opencode2 adapter (Spec 33), tasks A1–A6.
- [`cli-evals-migration-handoff.md`](cli-evals-migration-handoff.md) — working note for migrating `cli/evals` to scenario tests: method, the area's observable promises, and cautions.
- [`session-audit-2026-09.md`](session-audit-2026-09.md) — audit of 790 real OpenCode sessions (4–18 Sep 2026): baseline scorecard, decisions, and the WS0–WS4 remediation roadmap that Spec 37 starts.
- [`judge-bakeoff-2026-09-23.md`](judge-bakeoff-2026-09-23.md) — Spec 37 task 16.3: acceptance check for TypeSafe Jev as the eval judge against pass/fail labels on 20 real outputs and 10 constructed negatives, with Sonnet 5 as a reference. Outcome: Jev rejected (26/30 agreement, 8/12 fails caught).

---

## What belongs here

- Terminal captures and command output from spec proof runs
- Diff outputs used as proof that a spec was implemented
- One-time validation reports and audit checklists that are not tied to a specific spec directory
- Any proof artifact from a new spec that does not have a dedicated `<N>-proofs/` subdirectory

## What does not belong here

- Durable guides (`docs/*.md`)
- Formal specs (`docs/specs/<N>-spec-*/`)
- ADRs (`docs/adr/`)
- Any file that must be kept current as the system changes

---

## Security

Artifacts in this directory must not contain:

- API keys, tokens, passwords, or secrets
- Real user home paths or private filesystem layouts
- Private prompt content or harness session transcripts
- Internal-only runtime outputs with sensitive data

Replace sensitive values with `[REDACTED]` before committing.
