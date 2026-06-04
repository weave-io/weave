# 23 Questions Round 1 - Thermonuclear Quality Remediation

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. Spec Granularity

When you say "create a spec for each issue," how should the review findings be grouped into specs?

- [ ] (A) One spec per blocker/major theme (for example: execution lifecycle decomposition, CLI init decomposition, docs information architecture, core/config model cleanup)
- [ ] (B) One spec per repository slice (core/config, engine/runtime, adapters/cli, docs/specs)
- [ ] (C) One spec per individual finding from the review, including minor cleanup items
- [ ] (D) One umbrella roadmap spec plus smaller child specs only for the highest-risk issues
- [ ] (E) Other (describe)

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` keeps each spec large enough to be meaningful but small enough to produce clean Demoable Units, proof artifacts, and implementation tasks.
- `(A)` preserves the important structural distinctions from the review without exploding the work into dozens of tiny specs.
- `(B)` is workable, but some slices mix unrelated problems and would produce weaker scope boundaries.
- `(C)` is not recommended because many findings are dependent cleanups rather than standalone user-aligned specs.
- `(D)` can work later, but it adds an extra planning layer before we have the remediation specs themselves.

## 2. Priority Cut Line

Which findings should become specs in this batch?

- [ ] (A) Blockers only
- [ ] (B) Blockers and majors
- [ ] (C) Blockers, majors, and minors
- [ ] (D) Only the top 3 highest-risk issues regardless of severity labels
- [ ] (E) Other (describe)

**Recommended answer(s):** [(B)]

**Why these are recommended:**

- `(B)` captures the issues that materially affect architecture, maintainability, and reviewability without turning this into an unbounded documentation exercise.
- `(B)` gives enough coverage to address the structural problems the council flagged while leaving minor cleanups to later direct work or smaller follow-up specs.
- `(A)` is likely too narrow because several major findings are natural dependencies of the blockers.
- `(C)` is likely too broad and will create too many specs with low-value duplication.

## 3. Documentation Scope

Should documentation-architecture issues be included alongside code-remediation specs in this batch?

- [ ] (A) Yes, include documentation remediation specs in the same batch
- [ ] (B) No, create only code-remediation specs now
- [ ] (C) Create code-remediation specs now and one later umbrella docs spec
- [ ] (D) Other (describe)

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` matches the council review, which identified docs structure as a real architectural problem rather than optional polish.
- `(A)` keeps the remediation effort aligned with the repository rule that non-trivial changes must update durable docs.
- `(B)` risks leaving broken navigation and missing canonical references in place while code evolves.
- `(C)` is viable if you want to sequence effort, but it weakens the immediate planning picture.
