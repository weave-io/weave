# 20-audit-opencode-adapter-materialization.md

## Executive Summary

- Overall Status: PASS
- Required Gate Failures: 0
- Flagged Risks: 0

## Gateboard

| Gate | Status | Why it failed (<=10 words) | Exact fix target |
| --- | --- | --- | --- |
| Requirement-to-test traceability | PASS | — | — |
| Proof artifact verifiability | PASS | — | — |
| Repository standards consistency | PASS | — | — |
| Open question resolution | PASS | — | — |
| Regression-risk blind spots | PASS | — | — |
| Non-goal leakage | PASS | — | — |

## Standards Evidence Table (Required)

| Source File | Read | Standards Extracted | Conflicts |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Bun-only runtime; use `neverthrow`; update docs with non-trivial changes | none |
| `README.md` | yes | use workspace `bun run build/typecheck/test`; adapter lives in `packages/adapters/opencode` | none |
| `package.json` | yes | root quality gates are lint, typecheck, build, test | none |
| `packages/adapters/opencode/package.json` | yes | adapter package has local build/typecheck scripts; SDK pinned to `~1.15.9` | none |
| `.github/workflows/ci.yml` | yes | CI runs install, lint, typecheck, build, test | none |
| `CONTRIBUTING.md` | not found | none | none |
| `.github/pull_request_template.md` | not found | none | none |
| `packages/adapters/opencode/README.md` | not found | none | none |

## Re-Audit Delta (Runs 2+ only)

- Changed gate statuses since previous run:
  - Proof artifact verifiability: FAIL → PASS
  - Open question resolution: FAIL → PASS
  - Regression-risk blind spots: FLAG → PASS
- Still-failing REQUIRED gates: none
