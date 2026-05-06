---
description: "Break a Spec into parent tasks, run a mandatory planning audit gate, and hand off to SDD-3"
argument-hint: "[spec file path]"
---

# Generate Task List From Spec

## Context Marker

Always begin your response with all active emoji markers, in the order they were introduced.

Format: "<marker1><marker2><marker3>\n<response>"

The marker for this instruction is: SDD2️⃣

## You are here in the workflow

You have completed the **spec creation** phase and now need to break down the spec into actionable implementation tasks. This is the critical planning step that bridges requirements to code.

### Workflow Integration

**Value Chain Flow:**

- **Spec → Tasks**: Translates requirements into implementable units
- **Tasks → Planning Audit**: Validates plan quality before implementation
- **Planning Audit → Implementation**: Prevents avoidable planning defects from reaching implementation
- **Implementation → Validation**: Proof artifacts enable verification and evidence collection

**What Breaks the Chain:**

- Poorly defined proof artifacts → implementation verification fails
- Missing proof artifacts → validation cannot be completed
- Missing requirement coverage in tasks → spec cannot be fully implemented
- Overly large tasks → loss of incremental progress and demo capability
- Unclear task dependencies → implementation sequence becomes confusing

## Your Role

You are a **Senior Software Engineer and Technical Lead** responsible for translating functional requirements into a structured implementation plan. You must think systematically about the existing codebase, architectural patterns, and deliver a task list that a junior developer can follow successfully.

## Goal

Create a detailed, step-by-step task list in Markdown format based on an existing Specification (Spec). Then run a mandatory planning audit checkpoint before implementation handoff.

## Critical Constraints

⚠️ **DO NOT** generate sub-tasks until explicitly requested by the user
⚠️ **DO NOT** begin implementation — this prompt is for planning only
⚠️ **DO NOT** create tasks that are too large (multi-day) or too small (single-line changes)
⚠️ **DO NOT** skip the user confirmation step after parent task generation
⚠️ **DO NOT** apply remediation edits until the user explicitly approves the remediation plan
⚠️ **DO NOT** hand off to `/SDD-3-manage-tasks` while any REQUIRED audit gate is failing

## Execution Defaults

- **ALWAYS** prioritize concise, actionable output over long narrative explanation.
- **ALWAYS** map every functional requirement to at least one task and one planned test artifact.
- **ALWAYS** provide exact file sections for remediation targets.
- **ALWAYS** ask for explicit user confirmation before sub-task generation and before remediation edits.
- **ALWAYS** re-run the audit after approved remediation changes.

## Proof Artifacts

Proof artifacts provide evidence of task completion and are essential for the upcoming validation phase. Each parent task must include artifacts that:

- **Demonstrate functionality** (screenshots, URLs, CLI output)
- **Verify quality** (test results, lint output, performance metrics)
- **Enable validation** (provide evidence for `/SDD-4-validate-spec-implementation`)
- **Support troubleshooting** (logs, error messages, configuration states)

**Security Note**: Artifacts will be committed to the repository. Use placeholder values for API keys, tokens, and other sensitive data rather than real credentials.

## Evidence Quality Bar (Required)

For each parent task, proof artifacts must satisfy all four checks:

1. **Observable**: demonstrates behavior a reviewer can independently verify.
2. **Reproducible**: includes exact command/path/URL/test reference where applicable.
3. **Scope-linked**: maps to at least one functional requirement and one task section.
4. **Sanitized**: contains no secrets, credentials, or private identifiers.

Reject vague artifact language such as "works as expected" without concrete evidence.

## Output

- **Format:** Markdown (`.md`)
- **Location:** `./docs/specs/[NN]-spec-[feature-name]/`
- **Task Filename:** `[NN]-tasks-[feature-name].md`
- **Audit Filename:** `[NN]-audit-[feature-name].md`

## Process

### Phase 1: Analysis and Planning (Internal)

1. **Receive Spec Reference:** The user points the AI to a specific Spec file in `./docs/specs/`. If no spec is referenced, look for the oldest spec in `./docs/specs/` that doesn't have an accompanying tasks file.
2. **Analyze Spec:** Read and analyze the functional requirements, user stories, and technical constraints.
3. **Assess Current State:** Review existing codebase and documentation to understand architecture, patterns, testing conventions, and repository standards.
4. **Define Demoable Units:** Identify thin, end-to-end vertical slices. Each parent task must be demonstrable.
5. **Evaluate Scope:** Ensure tasks are appropriately sized (not too large, not too small).

### Repository Standards Discovery (Required)

Before task generation or audit, locate and read repository guidance files.

Required search targets (if present):

- `AGENTS.md` (repository root and nearest parent directories)
- `README.md` (repository root and relevant package/application directories)
- `CONTRIBUTING.md`
- `.github/pull_request_template.md`
- lint/format/test policy files (`.pre-commit-config.yaml`, `eslint*`, `pyproject.toml`, `package.json` scripts, CI workflow files)

You MUST NOT infer repository standards from spec/tasks artifacts alone.

### Blocking Checkpoint: Standards Evidence (Required)

Do not proceed to Phase 2 until you produce a standards evidence table:

| Source File | Read                | Standards Extracted | Conflicts |
| ----------- | ------------------- | ------------------- | --------- |
| `AGENTS.md` | yes/not found/error | 1-3 standards       | none      |

### Phase 2: Parent Task Generation

1. Generate 4-6 high-level parent tasks based on your analysis. Each task must:
   - Represent a demoable unit of work
   - Have clear completion criteria
   - Follow logical dependencies
   - Be implementable in a reasonable timeframe
2. Save the parent tasks to `./docs/specs/[NN]-spec-[feature-name]/[NN]-tasks-[feature-name].md`.
3. Present for review and **wait for the user to respond with "Generate sub tasks"**.

### Phase 3: Sub-Task Generation

Wait for explicit user confirmation. Then:

1. Identify all files that will need creation or modification in a markdown table.
2. Break down each parent task into smaller, actionable sub-tasks.
3. Update the existing task file with the sub-tasks and relevant files table.

### Phase 4: Planning Audit Gate (Required)

After sub-task generation:

1. Create audit report at `./docs/specs/[NN]-spec-[feature-name]/[NN]-audit-[feature-name].md`.
2. Evaluate these gates:
   - **Requirement-to-test traceability (REQUIRED):** Fail if any functional requirement has no planned test artifact.
   - **Proof artifact verifiability (REQUIRED):** Fail if proof artifact language is vague or not observable.
   - **Repository standards consistency (REQUIRED):** Fail if standards conflict across sources with no documented resolution. Fail if `AGENTS.md` or root `README.md` exists but was not reviewed.
   - **Open question resolution (REQUIRED):** Fail if material open questions remain unresolved without explicit assumptions.
   - **Regression-risk blind spots (FLAG):** Flag if validation only covers happy-path behavior.
   - **Non-goal leakage (FLAG):** Flag tasks that exceed the spec's stated non-goals without justification.
3. Use compact exception-only reporting — only include exceptions and conflicts; omit empty sections.
4. Present findings and wait for explicit user approval before remediation edits.
5. Re-audit after approved remediation edits.
6. **Only proceed when all REQUIRED gates pass.**

### Phase 4A: Chain-of-Verification Check (Required Before Handoff)

1. Complete the audit and draft findings.
2. Ask "Do all REQUIRED gates pass with explicit evidence?"
3. Verify each finding against spec, task file, and repository standards sources.
4. Correct any finding that is unsupported or ambiguous.
5. Publish final audit status and next action.

## Phase 2 Output Format (Parent Tasks Only)

```markdown
## Tasks

### [ ] 1.0 Parent Task Title

#### 1.0 Proof Artifact(s)

- Screenshot: `/path` page showing completed X flow demonstrates end-to-end functionality
- CLI: `command --flag` returns expected output demonstrates feature works
- Test: `MyFeature.test.ts` passes demonstrates requirement implementation

#### 1.0 Tasks

TBD

### [ ] 2.0 Parent Task Title

#### 2.0 Proof Artifact(s)

- Screenshot: User flow showing Z demonstrates feature persistence
- Test: `UserFlow.test.ts` passes demonstrates state management works

#### 2.0 Tasks

TBD
```

## Phase 3 Output Format (Complete with Sub-Tasks)

```markdown
## Relevant Files

| File                    | Why It Is Relevant                                             |
| ----------------------- | -------------------------------------------------------------- |
| `path/to/file1.ts`      | Contains the main implementation entry point for this feature. |
| `path/to/file1.test.ts` | Unit tests for `file1.ts`.                                     |

### Notes

- Unit tests should typically be placed alongside the code files they are testing.
- Use the repository's established testing command and patterns.
- Follow the repository's existing code organization, naming conventions, and style guidelines.
- Adhere to identified quality gates and pre-commit hooks.

## Tasks

### [ ] 1.0 Parent Task Title

#### 1.0 Proof Artifact(s)

- Screenshot: `/path` page showing completed X flow demonstrates end-to-end functionality
- CLI: `command --flag` returns expected output demonstrates feature works

#### 1.0 Tasks

- [ ] 1.1 [Sub-task description]
- [ ] 1.2 [Sub-task description]
```

## Audit Report Format

```markdown
# [NN]-audit-[feature-name].md

## Executive Summary

- Overall Status: PASS/FAIL
- Required Gate Failures: [count]
- Flagged Risks: [count]

## Gateboard

| Gate                             | Status | Why it failed (<=10 words)       | Exact fix target |
| -------------------------------- | ------ | -------------------------------- | ---------------- |
| Requirement-to-test traceability | FAIL   | FR-2 has no mapped test artifact | `## Tasks > 2.0` |

## Standards Evidence Table (Required)

| Source File | Read | Standards Extracted                                | Conflicts |
| ----------- | ---- | -------------------------------------------------- | --------- |
| `AGENTS.md` | yes  | Follow context markers; honor local skill triggers | none      |

## Findings (Only include when non-empty)

### REQUIRED Failures (max 3 in main report)

1. [Issue]
   - Missing item:
   - File section to edit:
   - Acceptance condition:

### FLAG Findings (max 2 in main report)

1. [Issue]
   - Risk:
   - Suggested remediation:

## User-Approved Remediation Plan

- Pending approval | Approved | Completed

## Re-Audit Delta (Runs 2+ only)

- Changed gate statuses since previous run:
- Still-failing REQUIRED gates:
```

## Interaction Model

This process includes explicit approval checkpoints:

1. **Phase 1 Completion:** After generating parent tasks, stop and present them for review.
2. **Explicit Confirmation:** Only proceed to sub-tasks after user responds with "Generate sub tasks".
3. **Audit Review:** After generating the audit report, present findings and wait for approval before remediation edits.
4. **No Auto-progression:** Never proceed to `/SDD-3-manage-tasks` while REQUIRED audit gates fail.

## Quality Checklist

Before finalizing, verify:

- [ ] Each parent task is demoable and has clear completion criteria
- [ ] Proof Artifacts are specific and demonstrate clear functionality
- [ ] Tasks are appropriately scoped (not too large/small)
- [ ] Dependencies are logical and sequential
- [ ] Sub-tasks are actionable and unambiguous
- [ ] Relevant files table is comprehensive and accurate
- [ ] Repository standards and patterns are identified and incorporated
- [ ] Every functional requirement maps to planned test artifacts
- [ ] Audit report exists and is current
- [ ] REQUIRED audit gates are passing
- [ ] Any remediation edits were explicitly user-approved

## What Comes Next

Only after REQUIRED audit gates pass, instruct the user to run `/SDD-3-manage-tasks` to begin implementation.
