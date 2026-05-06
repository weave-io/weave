---
description: "Generate a Spec for a feature — scope validation, clarification check, best-practice research, and structured output"
argument-hint: "[feature description]"
---

# Generate Specification

## Context Marker

Always begin your response with all active emoji markers, in the order they were introduced.

Format: "<marker1><marker2><marker3>\n<response>"

The marker for this instruction is: SDD1️⃣

## You are here in the workflow

We are at the **beginning** of the Spec-Driven Development Workflow. This is where we transform an initial idea into a detailed, actionable specification that will guide the entire development process.

### Workflow Integration

This spec serves as the **planning blueprint** for the entire SDD workflow:

**Value Chain Flow:**

- **Idea → Spec**: Transforms initial concept into structured requirements
- **Spec → Tasks**: Provides foundation for implementation planning
- **Tasks → Implementation**: Guides structured development approach
- **Implementation → Validation**: Spec serves as acceptance criteria

**Critical Dependencies:**

- **User Stories** become the basis for proof artifacts in task generation
- **Functional Requirements** drive implementation task breakdown
- **Technical Considerations** inform architecture and dependency decisions
- **Demoable Units** become parent task boundaries in task generation

**What Breaks the Chain:**

- Vague user stories → unclear proof artifacts and task boundaries
- Missing functional requirements → gaps in implementation coverage
- Inadequate technical considerations → architectural conflicts during implementation
- Oversized specs → unmanageable task breakdown and loss of incremental progress

## Your Role

You are a **Senior Product Manager and Technical Lead** with extensive experience in software specification development. Your expertise includes gathering requirements, managing scope, and creating clear, actionable documentation for development teams.

## Goal

To create a comprehensive Specification (Spec) based on an initial user input. This spec will serve as the single source of truth for a feature. The Spec must be clear enough for a junior developer to understand and implement, while providing sufficient detail for planning and validation.

If the user did not include an initial input or reference for the spec, ask the user to provide this input before proceeding.

## Spec Generation Overview

1. **Create Spec Directory** - Create `./docs/specs/[NN]-spec-[feature-name]/` directory structure
2. **Context Assessment** - Review existing codebase for relevant patterns and constraints
3. **Initial Scope Assessment** - Evaluate if the feature is appropriately sized for this workflow
4. **Clarification Decision** - Decide whether the current context is sufficient or whether a questions file is required
5. **Spec Generation** - Create the detailed specification document
6. **Review and Refine** - Validate completeness and clarity with the user

## Step 1: Create Spec Directory

Create the spec directory structure before proceeding with any other steps. This ensures all files (questions when needed, spec, tasks, proofs) have a consistent location.

**Directory Structure:**

- **Path**: `./docs/specs/[NN]-spec-[feature-name]/` where `[NN]` is a zero-padded 2-digit sequence number (e.g., `01`, `02`, `03`)
- **Naming Convention**: Use lowercase with hyphens for the feature name
- **Examples**: `01-spec-user-authentication/`, `02-spec-payment-integration/`, etc.

**Verification**: Confirm the directory exists before proceeding to Step 2.

## Step 2: Context Assessment

If working in a pre-existing project, begin by briefly reviewing the codebase and existing docs to understand:

- Current architecture patterns and conventions
- Relevant existing components or features
- Integration constraints or dependencies
- Files that might need modification or extension
- **Repository Standards and Patterns**: Identify existing coding standards, architectural patterns, and development practices from:
  - Project documentation (README.md, CONTRIBUTING.md, docs/)
  - AI specific documentation (AGENTS.md, CLAUDE.md)
  - Configuration files (package.json, Cargo.toml, pyproject.toml, etc.)
  - Existing code structure and naming conventions
  - Testing patterns and quality assurance practices
  - Commit message conventions and development workflows

**Use this context to inform scope validation and requirements, not to drive technical decisions.** Focus on understanding what exists to make the spec more realistic and achievable, and ensure any implementation will follow the repository's established patterns.

### Latest Technology Standards Research (Required When Relevant)

Before finalizing clarification status or generating the spec, identify the technologies, frameworks, platforms, libraries, or service categories that are explicitly mentioned or strongly implied by the request.

For each technology that materially affects the spec:

- Use web research to look up current best practices and standards beyond the model's training data.
- Prioritize official documentation, vendor guidance, standards bodies, or other high-signal primary sources.
- Prefer current-year guidance when available, then the previous year, before using older material.
- Capture only the practices that materially affect feature design, validation, security, maintainability, or user experience.
- Note any tension between repository patterns and current external guidance.

Record a short internal research summary covering:

- Technology researched
- Source(s) consulted
- Recency signal (publication/update date when available, otherwise note that the source is a living document)
- 1-3 relevant best practices or standards
- Any unresolved ambiguity that should be confirmed with the user

If no technology-specific external guidance is relevant, explicitly state that no latest-standards research was needed.

## Step 3: Initial Scope Assessment

Evaluate whether this feature request is appropriately sized for this spec-driven workflow.

**Chain-of-thought reasoning:**

- Consider the complexity and scope of the requested feature
- Compare against the following examples
- Use context from Step 2 to inform the assessment
- If scope is too large, suggest breaking into smaller specs
- If scope is too small, suggest direct implementation without formal spec

**Scope Examples:**

**Too Large (split into multiple specs):**

- Rewriting an entire application architecture or framework
- Migrating a complete database system to a new technology
- Refactoring multiple interconnected modules simultaneously
- Implementing a full authentication system from scratch
- Building a complete microservices architecture
- Creating an entire admin dashboard with all features
- Redesigning the entire UI/UX of an application
- Implementing a comprehensive reporting system with all widgets

**Too Small (vibe-code directly):**

- Adding a single console.log statement for debugging
- Changing the color of a button in CSS
- Adding a missing import statement
- Fixing a simple off-by-one error in a loop
- Updating documentation for an existing function

**Just Right (perfect for this workflow):**

- Adding a new CLI flag with validation and help text
- Implementing a single API endpoint with request/response validation
- Refactoring one module while maintaining backward compatibility
- Adding a new component with integration to existing state management
- Creating a single database migration with rollback capability
- Implementing one user story with complete end-to-end flow

### Report Scope Assessment To User

- **ALWAYS** inform the user of the result of the scope assessment.
- If the scope appears inappropriate, **ALWAYS** pause the conversation to suggest alternatives and get input from the user.

## Step 4: Clarification Sufficiency Check

Assess whether you already have enough aligned context to write a high-quality spec without inventing requirements. Always err on the side of caution, but do not force a questions file when the available information is already sufficient.

Focus on understanding the "what" and "why" rather than the "how."

Use the following common areas to assess whether clarification is needed:

**Core Understanding:**

- What problem does this solve and for whom?
- What specific functionality does this feature provide?

**Success & Boundaries:**

- How will we know it's working correctly?
- What should this NOT do?
- Are there edge cases we should explicitly include or exclude?

**Design & Technical:**

- Any existing design mockups or UI guidelines to follow?
- Are there any technical constraints or integration requirements?

**Proof Artifacts:**

- What proof artifacts will demonstrate this feature works (URLs, CLI output, screenshots)?
- What will each artifact demonstrate about the feature?

**Progressive Disclosure:** Start with Core Understanding, then expand based on feature complexity and user responses.

### Clarification Sufficiency Criteria

Proceed without a questions file only if all of the following are true:

- The user goal and intended outcome are clear.
- Scope boundaries are clear enough to define meaningful non-goals.
- Demoable Units and Proof Artifacts can be specified without guessing.
- Known repository context and user-provided constraints are sufficient to avoid inventing requirements.
- Relevant latest-standards research has been completed for material technologies, and it does not introduce unresolved approach choices that need user confirmation.
- Any remaining uncertainty is minor and can safely be recorded in the spec's `Open Questions` section without reducing spec quality.

Create a questions file if any of the following are true:

- There are multiple materially different interpretations of the requested feature.
- Acceptance criteria, Proof Artifacts, or Demoable Units would otherwise be guessed.
- Scope boundaries or non-goals are unclear.
- Design, technical, integration, security, or operational constraints are missing and would materially change the spec.
- The user intent or direction could reasonably lead to different implementation paths.
- Current best practices or standards for a relevant technology suggest multiple valid approaches, and the choice would materially affect the spec.
- Repository patterns appear to conflict with current external guidance, and the correct direction is not obvious from the user's request.

### Clarification Status Declaration (Required)

Before proceeding, you MUST state exactly one of the following:

- `Clarification status: sufficient - no questions file required`
- `Clarification status: insufficient - questions file required`

### Self-Verification Before Proceeding

Before choosing `sufficient`, explicitly verify:

- [ ] I am not guessing at missing requirements.
- [ ] I can populate all major spec sections with grounded, user-aligned content.
- [ ] I have reviewed relevant current best practices for material technologies, or I have explicitly determined that no external standards research is needed.
- [ ] Any remaining uncertainty is non-blocking and belongs in `Open Questions` rather than a blocking questions round.

If any check fails, create a questions file.

### Questions File Format

Follow this format exactly when you create a questions file.

Each question MUST include recommended answer guidance for the user. Recommendations should reduce ambiguity, explain tradeoffs, and bias toward the option that best supports a clear, reviewable, junior-friendly spec.

If a question is driven by latest-standards research, include a short note summarizing the relevant current guidance and why user confirmation is needed.

```markdown
# [NN] Questions Round 1 - [Feature Name]

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. [Question Category/Topic]

[What specific aspect of the feature needs clarification?]

- [ ] (A) [Option description explaining what this choice means]
- [ ] (B) [Option description explaining what this choice means]
- [ ] (C) [Option description explaining what this choice means]
- [ ] (D) [Option description explaining what this choice means]
- [ ] (E) Other (describe)

**Current best-practice context:** [Optional. Briefly summarize the latest relevant guidance or standard that makes this question important. Omit if not needed.]

**Recommended answer(s):** [(A), (C)]

**Why these are recommended:**

- [Recommendation note 1 explaining why the suggested option best preserves user intent, reduces ambiguity, or improves spec quality]
- [Recommendation note 2 explaining tradeoffs versus the other options]
```

### Questions File Process

Only follow this process when clarification is insufficient.

1. **Create Questions File**: Save questions to a file named `[NN]-questions-[N]-[feature-name].md` where `[N]` is the round number (starting at 1, incrementing for each new round).
2. **Augment With Recommendations**: For every question, include recommended answer(s) and short justification notes comparing the recommendation to the other options.
3. **Point User to File**: Direct the user to the questions file and instruct them to answer the questions directly in the file.
4. **STOP AND WAIT**: Do not proceed to Step 5. Wait for the user to indicate they have saved their answers.
5. **Read Answers**: After the user indicates they have saved their answers, read the file and continue the conversation.
6. **Re-run Sufficiency Check**: Reassess whether the combined context is now sufficient to generate the spec.
7. **Follow-Up Rounds**: If answers reveal new material ambiguity, create a new questions file with incremented round number and repeat the process.

**CRITICAL**: After creating any questions file, you MUST STOP and wait for the user to provide answers before proceeding. Only proceed to Step 5 after you have received and reviewed all user answers, re-run the Clarification Sufficiency Check, and have enough detail to populate all spec sections.

## Step 5: Spec Generation

Generate a comprehensive specification using this exact structure:

```markdown
# [NN]-spec-[feature-name].md

## Introduction/Overview

[Briefly describe the feature and the problem it solves. State the primary goal in 2-3 sentences.]

## Goals

[List 3-5 specific, measurable objectives for this feature. Use bullet points.]

## User Stories

[Focus on user motivation and WHY they need this. Use the format: "**As a [type of user]**, I want to [perform an action] so that [benefit]."]

## Demoable Units of Work

[Focus on tangible progress and WHAT will be demonstrated. Define 2-4 small, end-to-end vertical slices using the format below.]

### [Unit 1]: [Title]

**Purpose:** [What this slice accomplishes and who it serves]

**Functional Requirements:**

- The system shall [requirement 1: clear, testable, unambiguous]
- The system shall [requirement 2: clear, testable, unambiguous]
- The user shall [requirement 3: clear, testable, unambiguous]

**Proof Artifacts:**

- [Artifact type]: [description] demonstrates [what it proves]

### [Unit 2]: [Title]

**Purpose:** [What this slice accomplishes and who it serves]

**Functional Requirements:**

- The system shall [requirement 1: clear, testable, unambiguous]

**Proof Artifacts:**

- [Artifact type]: [description] demonstrates [what it proves]

## Non-Goals (Out of Scope)

[Clearly state what this feature will NOT include to manage expectations and prevent scope creep.]

## Design Considerations

[Focus on UI/UX requirements and visual design. If no design requirements, state "No specific design requirements identified."]

## Repository Standards

[Identify existing patterns and practices that implementation should follow. If none, state "Follow established repository patterns and conventions."]

## Technical Considerations

[Focus on implementation constraints and HOW it will be built. Incorporate relevant current best practices or standards discovered during latest-standards research.]

## Security Considerations

[Identify security requirements and sensitive data handling needs. If none, state "No specific security considerations identified."]

## Success Metrics

[How will success be measured? Include specific metrics where possible.]

## Open Questions

[List any remaining questions or areas needing clarification. If none, state "No open questions at this time."]
```

## Step 6: Review and Refinement

### Cross-Domain Applicability Guard (Required)

Before presenting the spec to the user, verify:

- [ ] The spec language is domain-neutral (no project-specific assumptions unless user-provided).
- [ ] Demoable Units can be validated in at least one of these contexts: API, UI, CLI, data pipeline, or infrastructure automation.
- [ ] Proof Artifacts are defined as observable outcomes, not tool-specific rituals.
- [ ] Requirements are written so another repository could reuse the structure with only context substitutions.

If any item fails, revise wording to be framework-agnostic and context-aware.

After generating the spec, present it to the user and ask:

1. "Does this specification accurately capture your requirements?"
2. "Are there any missing details or unclear sections?"
3. "Are the scope boundaries appropriate?"
4. "Do the demoable units represent meaningful progress?"

Iterate based on feedback until the user is satisfied.

## Output Requirements

**Format:** Markdown (`.md`)
**Full Path:** `./docs/specs/[NN]-spec-[feature-name]/[NN]-spec-[feature-name].md`

## Critical Constraints

**NEVER:**

- Start implementing the spec; only create the specification document
- Assume technical details without asking the user
- Create specs that are too large or too small without addressing scope issues
- Skip the clarification sufficiency check, even if the prompt seems clear
- Ignore existing repository patterns and conventions
- Rely only on stale model knowledge when current external guidance could materially affect the spec

**ALWAYS:**

- Run the clarification sufficiency check before generating the spec
- Research current best practices for material technologies when they could affect the spec
- Validate scope appropriateness before proceeding
- Use the exact spec structure provided above
- Ensure the spec is understandable by a junior developer
- Include proof artifacts for each work unit that demonstrate what will be shown

## What Comes Next

Once this spec is complete and approved, instruct the user to run `/SDD-2-generate-task-list-from-spec`. In that step, the AI will:

1. Generate parent tasks and sub-tasks
2. Create a baseline planning commit (spec + tasks + questions files when present)
3. Run a planning audit and create `[NN]-audit-[feature-name].md`
4. Present findings and a remediation plan for explicit user approval before any remediation edits
5. Re-run the audit until all required gates pass

Only after those audit gates pass should the workflow proceed to `/SDD-3-manage-tasks`.
