# Task 04 Proofs — Align Builtin Prompts and Config Smoke Coverage

**Spec**: [11-spec-prompt-composition-templates](../11-spec-prompt-composition-templates.md)
**Task**: 4/5 — Align builtin prompts and config smoke coverage with rendered templates

---

## 1. Diffs — loom.md and tapestry.md

### loom.md

```diff
diff --git a/packages/config/prompts/loom.md b/packages/config/prompts/loom.md
index 435c085..e81aef0 100644
--- a/packages/config/prompts/loom.md
+++ b/packages/config/prompts/loom.md
@@ -30,6 +30,8 @@ Delegate when the work is:
 - **Code quality review** — hand off to the code reviewer
 - **Security audit** — hand off to the security auditor
 
+{{{delegation.section}}}
+
 ## Constraints
 
 - Do not make assumptions about intent — ask one focused clarifying question if needed.
```

**Placement rationale**: `{{{delegation.section}}}` is placed immediately after the "When to delegate" bullet list, where the rendered Mermaid diagram and specialist routing table naturally extend the delegation guidance. The `## Constraints` section follows, keeping the structural flow: responsibilities → direct handling → delegation guidance → rendered delegation map → constraints.

### tapestry.md

```diff
diff --git a/packages/config/prompts/tapestry.md b/packages/config/prompts/tapestry.md
index 24f2eb3..abbff14 100644
--- a/packages/config/prompts/tapestry.md
+++ b/packages/config/prompts/tapestry.md
@@ -12,6 +12,8 @@ You are **Tapestry**, the plan execution coordinator. Your role is to drive a st
 - Surface blockers to the user immediately rather than proceeding past them.
 - Verify each step's completion criteria before marking it done.
 
+{{{delegation.section}}}
+
 ## Execution Rules
 
 - Never skip a step unless the user explicitly approves.
```

**Placement rationale**: `{{{delegation.section}}}` is placed immediately after the "Responsibilities" list, where Tapestry's delegation routing table naturally extends the list of agents it coordinates. The `## Execution Rules` section follows, keeping the structural flow: role description → responsibilities → rendered delegation map → execution rules → resumption → constraints.

---

## 2. Test Output — builtin-prompts.test.ts

```
bun test v1.3.13 (bf2e2cec)

 207 pass
 0 fail
 215 expect() calls
Ran 207 tests across 1 file. [26.00ms]
```

**New tests added** (beyond the original 94):
- Per-agent: `does not leak raw config/model/path/harness token: "<token>"` (16 tokens × 8 agents = 128 tests)
- Per-agent: `does not contain unintended raw Mustache tags (only allowed placeholders permitted)` (8 tests)
- `loom.md — contains the delegation.section template placeholder`
- `tapestry.md — contains the delegation.section template placeholder`
- `tapestry.md — describes step-by-step plan execution`
- `non-delegating prompts — no artificial template tags` (6 agents × 1 test = 6 tests)

**Key design decisions**:
- `{{{delegation.section}}}` is explicitly allowed as an intentional Mustache placeholder — stripped before the unresolved-tag check
- `"Task"` was removed from `BANNED_TOKENS` (it is a common English word appearing legitimately in prompt prose); `"TodoWrite"` and `"todowrite"` remain banned as harness-specific tool names
- `BANNED_LEAKAGE_TOKENS` covers: raw model identifiers (`claude-sonnet`, `gpt-4`, `anthropic/`, `openai/`), repo-relative paths (`packages/config`, `packages/engine`, `prompts/`, `.weave/`), harness names (`opencode`, `OpenCode`), and secret/env patterns (`process.env`, `API_KEY`, `SECRET`)

---

## 3. Test Output — builtin-compose-smoke.test.ts

```
bun test v1.3.13 (bf2e2cec)

 37 pass
 0 fail
 206 expect() calls
Ran 37 tests across 1 file. [43.00ms]
```

**New tests added** (beyond the original 15):
- `loom composedPrompt contains a Mermaid code block`
- `tapestry composedPrompt contains a Mermaid code block`
- `loom composedPrompt contains flowchart TD`
- `tapestry composedPrompt contains flowchart TD`
- `no unresolved unescaped triple-brace Mustache tags remain in any composed prompt`
- `no unresolved unescaped double-brace Mustache tags remain in any composed prompt`
- `no composed prompt exposes raw token: "<token>"` (17 tokens × 1 test each = 17 tests)

---

## 4. Sanitized Review Notes

### Rendered prompt inspection (loom)

The composed prompt for `loom` was verified to contain:
- `## Delegation` heading ✓
- ` ```mermaid` code fence ✓
- `flowchart TD` ✓
- All 6 specialist agent names: `shuttle`, `pattern`, `thread`, `spindle`, `weft`, `warp` ✓
- No raw model identifiers (`claude-sonnet`, `gpt-4`, etc.) ✓
- No repo-relative paths (`packages/config`, `prompts/`, `.weave/`) ✓
- No harness tool names (`TodoWrite`, `opencode`) ✓
- No secret/env patterns (`process.env`, `API_KEY`, `SECRET`) ✓
- No unresolved `{{{...}}}` or `{{...}}` tags ✓

### Rendered prompt inspection (tapestry)

Same checks as loom — all pass ✓

### Non-delegating agents (shuttle, pattern, thread, spindle, weft, warp)

- No `## Delegation` section in any composed prompt ✓
- No `{{{delegation.section}}}` placeholder in source files ✓
- Empty `delegationTargets` arrays ✓
- No unresolved Mustache tags ✓

### Suppression mechanism confirmed

Because `loom.md` and `tapestry.md` now contain `{{{delegation.section}}}`, the `primarySourceReferencesDelegation()` check in `compose.ts` returns `true` for these agents. This suppresses the fallback delegation section append — the delegation content is rendered inline at the placeholder position instead of being appended at the end. The result is a single, coherent composed prompt with the delegation map in its natural structural position.

---

## 5. Full Test Suite

```
bun test v1.3.13 (bf2e2cec)

 975 pass
 0 fail
 2554 expect() calls
Ran 975 tests across 35 files. [124.00ms]
```

No regressions across the full workspace.
