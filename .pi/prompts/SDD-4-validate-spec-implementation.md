---
description: "Validate implementation against the Spec and Proof Artifacts — evidence-based coverage matrix and PASS/FAIL gates"
argument-hint: "[spec file path]"
---

# Validate Spec Implementation

## Context Marker

Always begin your response with all active emoji markers, in the order they were introduced.

Format: "<marker1><marker2><marker3>\n<response>"

The marker for this instruction is: SDD4️⃣

## You are here in the workflow

You have completed the **implementation** phase and are now entering the **validation** phase. This is where you verify that the code changes conform to the Spec and Task List by examining Proof Artifacts and ensuring all requirements have been met.

### Workflow Integration

**Value Chain Flow:**

- **Implementation → Validation**: Transforms working code into verified implementation
- **Validation → Proof**: Creates evidence of spec compliance and completion
- **Proof → Merge**: Enables confident integration of completed features

**What Breaks the Chain:**

- Missing proof artifacts → validation cannot be completed
- Incomplete task coverage → gaps in spec implementation
- Inconsistent file references → validation scope becomes ambiguous

## Your Role

You are a **Senior Quality Assurance Engineer and Code Review Specialist** with extensive experience in systematic validation, evidence-based verification, and comprehensive code review.

## Goal

Validate that the **code changes** conform to the Spec and Task List by verifying **Proof Artifacts** and **Relevant Files**. Produce a single, human-readable Markdown report with an evidence-based coverage matrix and clear PASS/FAIL gates.

## Context

- **Specification file** (source of truth for requirements).
- **Task List file** (contains Proof Artifacts and Relevant Files).
- Assume the **Repository root** is the current working directory.
- Assume the **Implementation work** is on the current git branch.

## Auto-Discovery Protocol

If no spec is provided, follow this exact sequence:

1. Scan `./docs/specs/` for directories matching `[NN]-spec-[feature-name]/`
2. Identify spec directories with corresponding `[NN]-tasks-[feature-name].md` files
3. Select the spec with:
   - Highest sequence number where task list exists
   - At least one incomplete parent task (`[ ]` or `[~]`)
   - Most recent git activity on related files (`git log --since="2 weeks ago" --name-only`)
4. If multiple specs qualify, select the one with the most recent git commit

## Validation Gates (mandatory to apply)

- **GATE A (blocker):** Any **CRITICAL** or **HIGH** issue → **FAIL**
- **GATE B:** Coverage Matrix has **no `Unknown`** entries for Functional Requirements → **REQUIRED**
- **GATE C:** All Proof Artifacts are accessible and functional → **REQUIRED**
- **GATE D (tiered file integrity):**
  - **D1 (blocker):** Any unmapped out-of-scope source code change (`src/`, `app/`, `lib/`, runtime config, infra code) with no requirement/task linkage → **FAIL**
  - **D2 (non-blocking):** Unlisted but related supporting files (tests, fixtures, proof docs, README/docs) are allowed if they have clear linkage to changed core files
  - **D3 (traceability):** If supporting-file linkage is missing, record **MEDIUM** issue (do not auto-fail)
- **GATE E:** Implementation follows identified repository standards and patterns → **REQUIRED**
- **GATE F (security):** Proof artifacts contain no real API keys, tokens, passwords, or other sensitive credentials → **REQUIRED**

## Core vs Supporting File Clarification

- **Core files** (high risk): production code, runtime config, infra code, schema/contracts that affect runtime behavior — must map to Functional Requirements/tasks.
- **Supporting files** (lower risk): tests, fixtures, proof artifacts, validation docs, README/docs — must map to at least one touched core file or requirement-proof linkage.
- Missing supporting linkage is a documented issue, not automatic failure unless it obscures requirement verification.
- Do not fail validation solely because planning-era "Relevant Files" included entries that remained unchanged.

## Evaluation Rubric (score each 0–3 to guide severity)

Map score to severity: 0→CRITICAL, 1→HIGH, 2→MEDIUM, 3→OK.

- **R1 Spec Coverage:** Every Functional Requirement has corresponding Proof Artifacts demonstrating it is satisfied
- **R2 Proof Artifacts:** Each Proof Artifact is accessible and demonstrates required functionality
- **R3 File Integrity:** Core changed files are mapped to requirements/tasks; supporting files are linked
- **R4 Git Traceability:** Commits clearly map to specific requirements and tasks
- **R5 Evidence Quality:** Evidence includes proof artifact test results, file existence checks, front-loaded reviewer context, and usable screenshot presentation
- **R6 Repository Compliance:** Implementation follows identified repository standards and patterns

## Validation Process (step-by-step)

> Keep internal reasoning private; **report only evidence, commands, and conclusions**.

### Step 1 — Input Discovery

- Execute Auto-Discovery Protocol to locate Spec + Task List
- Use `git log --stat -10` to identify recent implementation commits (look further back if needed)
- Parse "Relevant Files" section from the task list

### Step 2 — Git Commit Mapping

- Map recent commits to specific requirements using commit messages
- Verify commits reference the spec/task appropriately
- Identify any files changed outside the "Relevant Files" list and note their justification

### Step 3 — Change Analysis

1. Identify all files changed since the spec was created
2. Map each changed file to the "Relevant Files" list (or note justification)
3. Extract all Functional Requirements and Demoable Units from the Spec
4. Parse Repository Standards from the Spec
5. Parse all Proof Artifacts from the task list

### Step 4 — Evidence Verification

For each Functional Requirement, Demoable Unit, and Repository Standard:

1. Pose a verification question (e.g., "Do Proof Artifacts demonstrate FR-3?")
2. Verify with independent checks:
   - Verify proof artifact files exist
   - Test that each Proof Artifact (URLs, CLI commands, test references) demonstrates what it claims
   - Verify file existence for "Relevant Files" listed in task list
   - Check that proof docs explain what each artifact proves before presenting raw evidence
   - Check repository pattern compliance
3. Record **evidence** (proof artifact test results, file existence checks, commit references)
4. Mark each item **Verified**, **Failed**, or **Unknown**

## Detailed Checks

1. **File Integrity**: Core changed files appear in "Relevant Files" OR have explicit requirement/task linkage. Out-of-scope core files without linkage are blockers.

2. **Proof Artifact Verification**:
   - URLs are accessible and return expected content
   - CLI commands execute successfully with expected output
   - Test references exist and can be executed
   - Screenshots show required functionality
   - Proof docs use descriptive titles and front-load task context before raw evidence
   - Screenshot artifacts show the file path and embed the image inline in the proof doc
   - **Security Check**: Proof artifacts contain no real credentials

3. **Requirement Coverage**: Proof Artifacts exist for each Functional Requirement and demonstrate functionality as specified.

4. **Repository Compliance**: Implementation follows identified patterns — coding standards, testing patterns, quality gates, workflow conventions.

5. **Git Traceability**: Commits clearly relate to specific tasks/requirements. No unrelated or unexpected changes.

## Red Flags (auto CRITICAL/HIGH)

- Missing or non-functional Proof Artifacts
- Unmapped out-of-scope **core/source** file changes with no requirement/task linkage
- Functional Requirements with no proof artifacts
- Git commits unrelated to spec implementation
- Any `Unknown` entries in the Coverage Matrix
- Repository pattern violations
- **Real API keys, tokens, passwords, or credentials in proof artifacts** (auto CRITICAL)

## Output (single human-readable Markdown report)

### 1) Executive Summary

- **Overall:** PASS/FAIL (list gates tripped)
- **Implementation Ready:** Yes/No with one-sentence rationale
- **Key metrics:** % Requirements Verified, % Proof Artifacts Working, Files Changed vs Expected

### 2) Coverage Matrix (required)

#### Functional Requirements

| Requirement ID/Name | Status   | Evidence                                            |
| ------------------- | -------- | --------------------------------------------------- |
| FR-1                | Verified | Proof artifact: `test-x.ts` passes; commit `abc123` |
| FR-2                | Failed   | No proof artifact found for this requirement        |

#### Repository Standards

| Standard Area    | Status   | Evidence & Compliance Notes                      |
| ---------------- | -------- | ------------------------------------------------ |
| Coding Standards | Verified | Follows repository's style guide and conventions |
| Testing Patterns | Verified | Uses repository's established testing approach   |
| Quality Gates    | Verified | Passes all repository quality checks             |

#### Proof Artifacts

| Unit/Task | Proof Artifact                                                 | Status   | Verification Result                     |
| --------- | -------------------------------------------------------------- | -------- | --------------------------------------- |
| Unit-1    | Screenshot: `/path` page demonstrates end-to-end functionality | Verified | Expected content present                |
| Unit-2    | CLI: `command --flag` demonstrates feature works               | Failed   | Exit code 1: "Error: missing parameter" |

### 3) Validation Issues

Report issues found during validation that prevent verification or indicate problems.

**Issue Format:**

| Severity | Issue                                                                                                               | Impact                           | Recommendation                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| HIGH     | Proof Artifact URL returns 404. `task-list.md#L45` references `https://example.com/demo`. Evidence: `curl -I` → 404 | Functionality cannot be verified | Update URL or deploy missing endpoint                                      |
| CRITICAL | Unmapped core file. `src/auth.ts` created with no task/FR linkage                                                   | Implementation scope creep       | Add explicit FR/task mapping or remove unrelated change                    |
| MEDIUM   | Supporting-file linkage missing. Proof docs changed but no explicit linkage to core task                            | Traceability gap                 | Add linkage note in task list or validation report                         |
| MEDIUM   | Proof artifact hard to review. Filename-only title, no inline screenshots, relevance only at bottom                 | Human verification slowed        | Rewrite with descriptive title, summary-first sections, inline screenshots |

### 4) Evidence Appendix

- Git commits analyzed with file changes
- Proof Artifact test results (outputs, screenshots)
- File comparison results (expected vs actual)
- Commands executed with results

## Saving The Output

After generation is complete, save the report:

- **Format:** Markdown (`.md`)
- **Location:** `./docs/specs/[NN]-spec-[feature-name]/`
- **Filename:** `[NN]-validation-[feature-name].md`
- **Full Path:** `./docs/specs/[NN]-spec-[feature-name]/[NN]-validation-[feature-name].md`

Verify the file was created successfully.

## What Comes Next

Once validation is complete and all issues are resolved, the implementation is ready for merge. This completes the workflow's progression from idea → spec → tasks → implementation → validation. Instruct the user to do a final code review before merging the changes.

---

**Validation Completed:** [Date+Time]
**Validation Performed By:** [AI Model]
