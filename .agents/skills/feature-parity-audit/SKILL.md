---
name: feature-parity-audit
description: Audit feature parity between a current project and a legacy or reference implementation, then identify what is missing, partially implemented, or divergent. Use this whenever the user wants a parity audit, migration gap analysis, adapter comparison, legacy-vs-current feature review, issue-informed roadmap, or a matrix of features across two or more implementations. If the user mentions a specific harness, adapter, integration, repo, legacy codebase, or open issues that should inform the comparison, use this skill even if they do not explicitly say “feature parity.”
---

# Feature Parity Audit

## Goal

Produce a grounded parity audit across implementations, with a clear gap analysis and a matrix the user can act on.

Typical comparisons include:

- current project vs legacy project
- core engine vs adapter or integration layer
- current implementation vs open issues / roadmap
- one adapter vs another adapter

The specific adapter, harness, or comparison target should come from the user prompt. Do not hardcode one ecosystem into the workflow.

## Start by framing the audit

Extract or confirm these inputs from the user request and repository context:

1. **Current implementation** — the project being audited now.
2. **Reference implementation** — the legacy repo, previous version, alternate adapter, or other comparison target.
3. **Scope lens** — whole product, one adapter, one workflow, one package, or one subsystem.
4. **Issue source** — GitHub issues, local TODOs, roadmap docs, or no issue source.
5. **Expected output** — usually a narrative audit plus a parity matrix.

If the prompt already gives enough detail, proceed instead of interrogating the user.

## Audit principles

1. **Compare behavior, not just filenames.**
   - Find user-visible capabilities, workflow steps, constraints, extension points, and failure modes.
   - Avoid shallow “file exists / file missing” comparisons.

2. **Separate product features from implementation details.**
   - A feature may be present even if implemented differently.
   - A matching file or symbol does not prove parity.

3. **Use issues as evidence, not as truth.**
   - Open issues can reveal known gaps, planned work, regressions, and sharp edges.
   - Verify whether each issue still reflects reality in code.

4. **Call out partial parity explicitly.**
   - Distinguish `present`, `partial`, `missing`, `different-by-design`, and `unknown`.

5. **Be precise about confidence.**
   - When evidence is incomplete, say what was inspected and why the conclusion is tentative.

## Recommended workflow

### 1. Inventory the reference implementation

Identify the legacy or comparison implementation's:

- major user-facing capabilities
- workflows and commands
- configuration surfaces
- extension points and hooks
- adapter or harness-specific behavior
- docs and issue references that define expected behavior

Group findings into feature buckets rather than dumping a raw symbol list.

Example buckets:

- configuration and discovery
- prompt composition
- skill loading and resolution
- delegation and routing
- workflow execution
- adapter-specific behavior
- review / recovery / continuation behavior
- CLI or UX affordances

### 2. Inventory the current implementation

Map the same feature buckets onto the current project.

For each bucket, determine:

- what clearly exists
- what exists but differs materially
- what is missing
- what may have moved to a different abstraction boundary

### 3. Inspect the requested adapter or target layer

If the user names a specific adapter, harness, or integration, audit that layer separately.

Focus on:

- what the current system supports in the core
- what the named adapter exposes today
- what remains adapter-specific work versus engine/core work

Do not assume a core feature automatically means adapter parity.

### 4. Cross-check open issues

Review the open issues the user pointed to, or the active issue tracker if available.

Treat the issue review as two related tasks:

1. use issues as parity evidence
2. identify which issues look stale, out of date, superseded, or out of scope

For each relevant issue, classify it as one of:

- confirms a missing feature
- confirms a partial implementation
- indicates a bug or regression
- already resolved in code but issue is stale
- adjacent but out of parity scope

Use issues to sharpen the gap list and prioritize missing work.

When the issue review is done, explicitly surface cleanup candidates:

- issues that no longer match the code
- issues that are still valid but need narrower scope
- issues that duplicate other issues
- issues that are not actually parity-related

Then ask the user what to do next with issue updates:

- update all relevant issues
- update only selected issues
- do not update issues yet

Do not silently edit or rewrite issues unless the user asks for it.

### 5. Build a parity matrix

Create a matrix that compares the same features across all requested targets.

Use concise, scannable statuses such as:

- ✅ Present
- 🟡 Partial
- ❌ Missing
- ↔️ Different
- ❓ Unknown

Keep one row per feature or subfeature. Prefer smaller, concrete rows over vague umbrella rows.

## Output format

Use this structure unless the user asks for something else.

### 1. Scope

- current project audited
- reference implementation audited
- adapter / harness / subsystem focus
- issue sources reviewed

### 2. Executive summary

Summarize:

- overall parity level
- biggest missing areas
- biggest partial areas
- whether the remaining work looks core-level, adapter-level, or both

### 3. Key findings

For each major gap, provide:

- feature name
- current state
- reference state
- why this matters
- evidence inspected
- likely ownership: core, adapter, docs, or issue cleanup

### 4. Parity matrix

Use a table like this:

| Feature | Legacy / Reference | Current Core / Project | Named Adapter / Target | Notes / Evidence | Gap Owner |
|---|---|---|---|---|---|
| Feature X | ✅ | 🟡 | ❌ | Legacy supports A+B; current only A; adapter lacks exposure | Adapter |

If there is no separate adapter target, collapse the matrix to the relevant columns.

### 5. Gap backlog

Turn the audit into an action list:

1. highest-priority missing parity items
2. partial items needing refinement
3. stale issues or doc mismatches
4. unknowns requiring deeper investigation

For each item, say whether it is:

- a feature implementation task
- an adapter integration task
- a bug fix
- a documentation task
- an issue triage / cleanup task

If issue cleanup work is in scope, separate it into:

- stale issues to close or relabel
- issues that need rewritten acceptance criteria
- issues that should be split, merged, or deprioritized

## Analysis rules

- Prefer direct evidence from code, docs, tests, and issues.
- Name the specific files, packages, or modules that support each conclusion.
- If a feature has moved or been intentionally redesigned, call that out rather than marking it simply missing.
- Do not inflate certainty. If you cannot verify behavior, use `unknown` and say what is needed to verify it.
- When the reference project is older, watch for legacy behaviors that should **not** be restored; mark them as intentional divergence when appropriate.
- Treat issue tracker hygiene as a separate decision from the parity audit itself: recommend updates when useful, but let the user choose whether to update all issues, selected issues, or none.

## Example trigger shapes

Use this skill for prompts like:

- “Audit this repo against the old implementation and tell me what’s left for parity.”
- “Compare our current adapter to the legacy project and build a feature matrix.”
- “Use the open GitHub issues plus the old repo to figure out the remaining migration gaps.”
- “I need a gap analysis between the current system, the legacy codebase, and one adapter.”

## Finish strong

The final result should help the user answer three questions quickly:

1. What already matches?
2. What is still missing or partial?
3. Which remaining gaps belong to the core project versus the named adapter or integration?
