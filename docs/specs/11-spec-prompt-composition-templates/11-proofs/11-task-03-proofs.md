# Task 3 Proof Artifact — Integrate Mustache Template Rendering into `composeAgentDescriptor()`

## Test Output

```
bun run --filter '@weave/engine' test

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

### 3. Prompt assembly order correct

The final prompt is assembled in this order:
1. **Rendered primary source** — `renderPromptTemplate(promptSource, ...)` 
2. **Optional fallback `delegation.section`** — inserted only when:
   - `delegationTargets.length > 0`
   - Primary source does NOT reference any `delegation.*` paths (checked via `extractTemplatePaths()`)
   - `templateContext.delegation.section !== undefined`
3. **Rendered `prompt_append`** — `renderPromptTemplate(agentConfig.prompt_append, ...)` with `sourceKind: "prompt_append"`

Sections are joined with `"\n\n"`.

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

### 6. Fallback suppression detection

`primarySourceReferencesDelegation()` uses `extractTemplatePaths()` (which only returns real variable/section/unescaped tokens — not comments, escaped literals, raw text, or close tokens) and checks if any path starts with `"delegation"`. This is called on the **primary source only**, not on `prompt_append`.

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
