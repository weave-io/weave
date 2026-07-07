# Task 3 Proof Artifact — Integrate Mustache Template Rendering into `composeAgentDescriptor()`

> **Amendment:** The fallback `delegation-section` insertion logic and fallback suppression detection (`primarySourceReferencesDelegation()`) were subsequently removed from `compose.ts`. The prompt assembly order is now: rendered primary source, then rendered `prompt_append` (no fallback step). Notes 3 and 6 below reflect the original implementation and are preserved for historical reference.

## Test Output

```
bun run --filter '@weaveio/weave-engine' test

 472 pass
   0 fail
 1369 expect() calls
Ran 472 tests across 13 files. [65.00ms]
Exited with code 0
```

## Code Review Notes

### 1. `ResultAsync<AgentDescriptor, ComposeError>` return type preserved

`composeAgentDescriptor()` signature is unchanged:

```ts
export function composeAgentDescriptor(
  agentName: string,
  agentConfig: AgentConfig,
  config: WeaveConfig,
  allAgents: Record<string, AgentConfig>,
  category?: CategoryInput,
): ResultAsync<AgentDescriptor, ComposeError>
```

The function uses `.andThen()` to chain the async prompt-load with synchronous template rendering, keeping the entire pipeline in `ResultAsync`.

### 2. No `try/catch` for expected failures

`compose.ts` contains zero `try/catch` blocks. All expected failure paths use `neverthrow` Result types:
- `loadPromptSource()` uses `ResultAsync.fromPromise()` to wrap the `Bun.file().text()` call
- `renderPromptTemplate()` returns `Result<string, ComposeError>` using `renderTemplate()` which itself returns `Result`
- `buildTemplateContext()` returns `Result<AgentPromptTemplateContext, TemplateContextError>`
- All error paths use `err(...)` / `errAsync(...)` and early returns

### 3. Prompt assembly order *(historical — subsequently amended)*

> **Amendment:** Step 2 (fallback `delegation-section` insertion) was removed. The current assembly order is: (1) rendered primary source, (2) rendered `prompt_append`. Sections are joined with `"\n\n"`.

Original assembly order (preserved for reference):
1. **Rendered primary source** — `renderPromptTemplate(promptSource, ...)`
2. ~~**Optional fallback `delegation-section`**~~ — **REMOVED**
3. **Rendered `prompt_append`** — `renderPromptTemplate(agentConfig.prompt_append, ...)` with `sourceKind: "prompt_append"`

### 4. `ComposeError` extended with `PromptTemplateError` variant

```ts
export type PromptTemplateReason =
  | { kind: "MalformedSyntax"; message: string; line?: number; column?: number }
  | { kind: "UnsupportedTag"; tag: string; message: string }
  | { kind: "UnknownPath"; path: string; message: string }
  | { kind: "UnsafePath"; path: string; message: string }
  | { kind: "FunctionValue"; path: string; message: string }
  | { kind: "SectionMismatch"; message: string }
  | { kind: "UnresolvedTag"; tag: string; message: string };

export type ComposeError =
  | { type: "PromptSourceMissingError"; agentName: string; message: string }
  | { type: "PromptFileReadError"; agentName: string; promptFilePath: string; message: string; fileErrorMessage: string }
  | {
      type: "PromptTemplateError";
      agentName: string;
      sourceKind: "prompt" | "prompt_file" | "prompt_append";
      promptFilePath?: string;
      message: string;
      reason: PromptTemplateReason;
    };
```

### 5. Template Context built from agent/policy/category/delegation inputs

`buildTemplateContext()` is called with:
- `agentName`, `description`, `mode`, `skills` from `agentConfig`
- `effectiveToolPolicy` from `evaluateEffectiveToolPolicy(agentConfig.tool_policy)`
- `delegationTargets` from `buildDelegationTargets()`
- Optional `category` passed through from the caller

### 6. Fallback suppression detection *(historical — feature removed)*

> **Amendment:** `primarySourceReferencesDelegation()` and the fallback suppression check were removed from `compose.ts` along with the fallback-append logic. The following is preserved for historical reference only.

`primarySourceReferencesDelegation()` used `extractTemplatePaths()` (which only returned real variable/section/unescaped tokens — not comments, escaped literals, raw text, or close tokens) and checked if any path started with `"delegation"`. This was called on the **primary source only**, not on `prompt_append`.

### 7. Static prompts work unchanged

Prompts with no Mustache tags pass through `renderTemplate()` unchanged — Mustache renders them as-is. Verified by test `Static_prompt_without_mustache_tags_works_unchanged`.

## New Tests Added (compose.test.ts)

All tests in the `"template rendering"` describe block:

| Test | Covers |
|------|--------|
| `Inline_template_renders_agent_name_into_composedPrompt` | Inline prompt rendering |
| `Inline_template_renders_tool_policy_into_composedPrompt` | Tool policy context rendering |
| `Prompt_file_template_renders_agent_name_from_file` | Prompt-file template rendering |
| `Prompt_append_is_rendered_as_template` | Rendered append |
| `Fallback_delegation_section_inserted_when_primary_has_no_delegation_tags` | Fallback placement |
| `Fallback_delegation_suppressed_when_primary_references_delegation_tag` | Source-only suppression |
| `Prompt_append_delegation_reference_does_not_suppress_fallback` | Append no-suppress behavior |
| `Static_prompt_without_mustache_tags_works_unchanged` | Static prompt compatibility |
| `Template_error_in_primary_prompt_returns_PromptTemplateError` | Typed template error metadata (prompt) |
| `Template_error_in_prompt_file_returns_PromptTemplateError_with_promptFilePath` | Typed template error metadata (prompt_file) |
| `Template_error_in_prompt_append_returns_PromptTemplateError_with_sourceKind_prompt_append` | Typed template error metadata (prompt_append) |
| `Final_prompt_order_is_rendered_primary_then_fallback_then_rendered_append` | Final prompt order |

Also updated: `Delegation_section_is_formatted_as_markdown_in_composedPrompt` → `Delegation_section_is_formatted_as_markdown_with_mermaid_in_composedPrompt` to match new Mermaid-enhanced delegation section format.
