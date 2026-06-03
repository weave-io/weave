# docs/artifacts — Non-Normative Artifact Archive

This directory holds non-normative historical artifacts: proof outputs, terminal captures, diff summaries, and audit evidence produced during spec implementation.

**These files are not maintained as the system evolves.** They are audit history, not reference documentation.

See [Documentation Policy](../documentation-policy.md) for the full classification rules and retention policy.

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
