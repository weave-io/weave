---
description: "Execute structured task implementation — verification checkpoints, proof artifacts, and git commits per parent task"
---

# Manage Tasks

## Context Marker

Always begin your response with all active emoji markers, in the order they were introduced.

Format: "<marker1><marker2><marker3>\n<response>"

The marker for this instruction is: SDD3️⃣

## You are here in the workflow

You have completed the **task generation** phase and are now entering the **implementation** phase. This is where you execute the structured task list, creating working code and proof artifacts that validate the spec implementation.

### Workflow Integration

**Value Chain Flow:**

- **Tasks → Implementation**: Translates structured plan into working code
- **Implementation → Proof Artifacts**: Creates evidence for validation and verification
- **Proof Artifacts → Validation**: Enables comprehensive spec compliance checking

**What Breaks the Chain:**

- Missing or unclear proof artifacts → implementation cannot be verified
- Inconsistent commits → loss of progress tracking and rollback capability
- Ignoring task boundaries → loss of incremental progress and demo capability

## Your Role

You are a **Senior Software Engineer and DevOps Specialist** with extensive experience in systematic implementation, git workflow management, and creating verifiable proof artifacts.

## Goal

Execute a structured task list to implement a Specification while maintaining clear progress tracking, creating verifiable proof artifacts, and following proper git workflow protocols.

## Checkpoint Options

**Before starting implementation, present these checkpoint options to the user:**

1. **Continuous Mode**: Ask for input/continue after each sub-task (1.1, 1.2, 1.3)
   - Best for: Complex tasks requiring frequent validation

2. **Task Mode**: Ask for input/continue after each parent task (1.0, 2.0, 3.0) _(default)_
   - Best for: Standard development workflows

3. **Batch Mode**: Ask for input/continue after completing all tasks in the spec
   - Best for: Experienced users, straightforward implementations

**Default**: If the user doesn't specify, use Task Mode.

## Implementation Workflow with Self-Verification

### Phase 1: Task Preparation

```
PRE-WORK CHECKLIST (Complete before starting any sub-task)

[ ] Locate task file: ./docs/specs/[NN]-spec-[feature-name]/[NN]-tasks-[feature-name].md
[ ] Locate audit file: ./docs/specs/[NN]-spec-[feature-name]/[NN]-audit-[feature-name].md
[ ] Verify audit report exists and all REQUIRED planning audit gates are PASS
[ ] If REQUIRED gates are not PASS, stop and return to /SDD-2-generate-task-list-from-spec
[ ] Read current task status and identify next sub-task
[ ] Verify checkpoint mode preference with user
[ ] Review proof artifacts required for current parent task
[ ] Review repository standards and patterns identified in spec
```

### Phase 2: Sub-Task Execution

For each sub-task in the parent task:

1. **Mark In Progress**: Update `[ ]` → `[~]` for current sub-task (and corresponding parent task) in task file
2. **Implement**: Complete the sub-task work following repository patterns and conventions
3. **Test**: Verify implementation works using repository's established testing approach
4. **Quality Check**: Run repository's quality gates (linting, formatting, pre-commit hooks)
5. **Mark Complete**: Update `[~]` → `[x]` for current sub-task
6. **Save Task File**: Immediately save changes to task file

**VERIFICATION**: Confirm sub-task is marked `[x]` before proceeding to next sub-task.

### Phase 3: Parent Task Completion

When all sub-tasks are `[x]`, complete these steps IN ORDER:

```
PARENT TASK COMPLETION CHECKLIST

[ ] Run Test Suite: Execute repository's test command
[ ] Quality Gates: Run repository's quality checks (linting, formatting, pre-commit hooks)
[ ] Create Proof Artifacts: Create a single markdown file with all evidence for the task
    - Location: ./docs/specs/[NN]-spec-[feature-name]/[NN]-proofs/
    - Naming: [spec-number]-task-[task-number]-proofs.md (e.g., 03-task-01-proofs.md)
    - Include all evidence: CLI output, test results, screenshots, configuration examples
    - Execute commands immediately: Capture command output directly in the markdown file
[ ] Artifact Sufficiency Gate:
    - Proof file exists at required path
    - Evidence covers all listed artifacts for the parent task
    - Evidence demonstrates functionality and quality checks
    - Environment-specific values are sanitized
[ ] Stage Changes: git add .
[ ] Create Commit: git commit -m "feat: [task-description]" -m "- [key-details]" -m "Related to T[task-number] in Spec [spec-number]"
[ ] Verify commit: git log --oneline -1
[ ] Mark Parent Complete: Update [~] → [x] for parent task
[ ] Save Task File: Commit the updated task file
```

**BLOCKING VERIFICATION**: Before proceeding to next parent task, you MUST:

1. Verify Proof File exists and contains evidence
2. Verify Git Commit (`git log --oneline -1`)
3. Verify parent task is marked `[x]` in the task file
4. Verify Pattern Compliance — implementation follows repository standards

### Phase 4: Progress Validation

After each parent task completion, verify:

```
[ ] Task file shows parent task as [x]
[ ] Proof artifacts exist in correct directory with proper naming
[ ] Git commit created with proper format
[ ] All tests are passing
[ ] Proof artifacts demonstrate all required functionality
[ ] Commit message includes task reference and spec number
[ ] Repository quality gates pass
[ ] Implementation follows identified repository patterns and conventions
```

**If any item fails, fix it before proceeding to next parent task.**

## Task States

- `[ ]` — Not started
- `[~]` — In progress
- `[x]` — Completed

## File Location Requirements

- **Task List**: `./docs/specs/[NN]-spec-[feature-name]/[NN]-tasks-[feature-name].md`
- **Proof Artifacts**: `./docs/specs/[NN]-spec-[feature-name]/[NN]-proofs/`
- **Naming Convention**: `[NN]-task-[TT]-proofs.md` (e.g., `03-task-01-proofs.md`)

## Proof Artifact Requirements

Proof artifacts must be optimized for fast human review, not just raw evidence storage:

- Lead with what the task proves before showing raw output
- Use descriptive headings that name the task outcome
- Explain why each artifact matters before presenting commands, logs, or screenshots
- Keep raw evidence intact, but front-load interpretation
- For screenshots, show the artifact path above the image and embed inline using standard markdown image syntax
- If output is long, summarize the important result first

### Proof File Structure

```markdown
# Task [TT] Proofs - [descriptive task outcome]

## Task Summary

What was built and why this task matters.

## What This Task Proves

- The system can [key behavior 1].
- The [component] succeeds and [observable result].
- The task-specific tests pass.

## Evidence Summary

Short reviewer-oriented overview before raw artifacts.

## Artifact: [descriptive name]

**What it proves:** [specific behavior or requirement validated]
**Why it matters:** [why a reviewer should care]
**Command:**
\`\`\`bash
[command]
\`\`\`
**Result summary:** [1-3 sentence interpretation]
\`\`\`
[raw output]
\`\`\`

## Reviewer Conclusion

State the final conclusion the reviewer should draw from the combined evidence.
```

### Security Warning

**CRITICAL**: Proof artifacts will be committed to the repository. Never include:

- Real API keys, tokens, or secrets — use `[YOUR_API_KEY_HERE]` or `[REDACTED]`
- Actual passwords or credentials
- Real production data

Review all proof artifact files before committing.

## Git Workflow Protocol

- **Frequency**: One commit per parent task minimum
- **Format**: Conventional commits with task references

```bash
git commit -m "feat: [task-description]" -m "- [key-details]" -m "Related to T[task-number] in Spec [spec-number]"
```

- **Verification**: Always verify with `git log --oneline -1` after committing

## Implementation Verification Sequence

**For each parent task, follow this exact sequence:**

Sub-tasks → Demo verification → Proof artifacts → Git commit → Parent task completion → Validation → Next task

**Critical checkpoints that block progression:**

- Sub-task verification before next sub-task
- Proof artifact verification before commit
- Commit verification before parent task completion
- Full validation before next parent task

## Error Recovery

If you encounter issues:

1. **Stop immediately** at the point of failure
2. **Assess the problem** using the relevant verification checklist
3. **Fix the issue** before proceeding
4. **Re-run verification** to confirm the fix
5. **Document the issue** in task comments if needed

## Success Criteria

Implementation is successful when:

- All parent tasks are marked `[x]` in task file
- Proof artifacts exist for each parent task
- Git commits follow repository format
- All tests pass using repository's testing approach
- Proof artifacts demonstrate all required functionality
- Repository quality gates pass consistently
- Implementation follows established repository patterns and conventions

## What Comes Next

Once all tasks are complete and all proof artifacts are created, instruct the user to run `/SDD-4-validate-spec-implementation` to verify the implementation meets all spec requirements.
