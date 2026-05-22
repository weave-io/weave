# Plan: `prompt_append_file` for agents and categories

**Goal:** Add a `prompt_append_file` field to both `agent` and `category` DSL blocks, mirroring how `prompt_file` works for the primary prompt slot. The field is mutually exclusive with `prompt_append`, resolves relative to the config scope's `prompts/` directory, and participates in Mustache template rendering.

---

## Affected files

| File | Change type |
|---|---|
| `packages/core/src/schema.ts` | Add field + mutual-exclusion refinement (both schemas) |
| `packages/core/src/validate.ts` | Add path-safety refinement for `prompt_append_file` |
| `packages/core/src/__tests__/schema.test.ts` | New schema-level tests |
| `packages/core/src/__tests__/validate.test.ts` | New validate-level tests |
| `packages/core/src/__tests__/parse_config.test.ts` | New E2E pipeline tests |
| `packages/config/src/resolve.ts` | Resolve `prompt_append_file` for agents and categories |
| `packages/config/src/__tests__/resolve.test.ts` | New resolve-level tests |
| `packages/engine/src/compose.ts` | Load and render `prompt_append_file` in `composeAgentDescriptor` |
| `packages/engine/src/__tests__/compose.test.ts` | New compose-level tests |
| `docs/specs/01-spec-core-dsl/index.md` (or equivalent DSL spec) | Document new field |

---

## Tasks

- [x] **Step 1**: `packages/core/src/schema.ts` — add `prompt_append_file` field + mutual-exclusion and path-safety refinements to `AgentConfigSchema` and `CategoryConfigSchema`
- [x] **Step 2**: `packages/core/src/__tests__/schema.test.ts` — schema-level tests for new field
- [x] **Step 3**: `packages/core/src/__tests__/validate.test.ts` — validate-level tests
- [x] **Step 4**: `packages/core/src/__tests__/parse_config.test.ts` — E2E pipeline tests
- [x] **Step 5**: `packages/config/src/resolve.ts` — resolve `prompt_append_file` for agents and categories
- [x] **Step 6**: `packages/config/src/__tests__/resolve.test.ts` — resolve-level tests
- [x] **Step 7**: `packages/engine/src/compose.ts` — load and render `prompt_append_file` in `composeAgentDescriptor`
- [x] **Step 8**: `packages/engine/src/__tests__/compose.test.ts` — compose-level tests
- [x] **Step 9**: `docs/` — document new field in DSL spec

---

## Step-by-step implementation

### Step 1 — `packages/core/src/schema.ts`: add field + refinements

**`AgentConfigSchema`**

1. Add `prompt_append_file: z.string().optional()` alongside `prompt_append`.
2. Add a `.refine()` for mutual exclusion:
   ```ts
   .refine(
     (data) => !(data.prompt_append !== undefined && data.prompt_append_file !== undefined),
     { message: "prompt_append and prompt_append_file are mutually exclusive" },
   )
   ```
3. Add a path-safety `.refine()` mirroring the existing `prompt_file` check:
   ```ts
   .refine(
     (data) => {
       if (data.prompt_append_file === undefined) return true;
       if (data.prompt_append_file.startsWith("/")) return false;
       if (data.prompt_append_file.includes("..")) return false;
       return true;
     },
     { message: "prompt_append_file must be a relative path without '..' or absolute paths" },
   )
   ```

**`CategoryConfigSchema`**

1. Add `prompt_append_file: z.string().optional()` alongside `prompt_append`.
2. Add the same mutual-exclusion `.refine()` as above.
3. Add the same path-safety `.refine()` as above.

> **Note:** `CategoryConfigSchema` currently has no `.refine()` calls. The first `.refine()` converts it from a plain `z.object()` to a `ZodEffects` — this is fine; Zod chains refinements correctly.

**Inferred types** — no manual type changes needed; `AgentConfig` and `CategoryConfig` are derived via `z.infer<>` and will automatically include the new optional field.

---

### Step 2 — `packages/core/src/__tests__/schema.test.ts`: schema-level tests

Per the schema evolution rules in AGENTS.md, add tests for every new constraint:

**For `AgentConfigSchema`:**
- Accept `prompt_append_file` with a valid relative path (no `prompt_append` present).
- Accept `prompt_append` alone (existing behaviour, regression guard).
- Reject when both `prompt_append` and `prompt_append_file` are set → error message includes "mutually exclusive".
- Reject `prompt_append_file` with `..` in path → error message includes "relative path".
- Reject `prompt_append_file` with absolute path → error message includes "relative path".

**For `CategoryConfigSchema`:**
- Accept `prompt_append_file` with a valid relative path.
- Reject when both `prompt_append` and `prompt_append_file` are set → "mutually exclusive".
- Reject `prompt_append_file` with `..` → "relative path".
- Reject `prompt_append_file` with absolute path → "relative path".

---

### Step 3 — `packages/core/src/__tests__/validate.test.ts`: validate-level tests

The `validate()` function runs the full lex → parse → Zod pipeline. Add:

- Agent with `prompt_append_file "extra.md"` → `result.isOk()` and `config.agents.X.prompt_append_file === "extra.md"`.
- Category with `prompt_append_file "cat-extra.md"` → `result.isOk()` and `config.categories.X.prompt_append_file === "cat-extra.md"`.
- Agent with both `prompt_append` and `prompt_append_file` → `result.isErr()` with "mutually exclusive" in message.
- Category with both → same.
- Agent with `prompt_append_file "../bad.md"` → `result.isErr()` with "relative path" in message.
- Agent with `prompt_append_file "/etc/passwd"` → `result.isErr()` with "relative path" in message.

---

### Step 4 — `packages/core/src/__tests__/parse_config.test.ts`: E2E pipeline tests

Add at least two E2E tests through `parseConfig()`:

- Agent with `prompt_append_file "extra.md"` parses successfully; field is present in output.
- Category with `prompt_append_file "cat-extra.md"` parses successfully; field is present in output.
- Agent with both `prompt_append` and `prompt_append_file` → `result.isErr()`.

These catch wiring errors (e.g. the field being stripped by `astToPlainObject`) that unit tests cannot.

---

### Step 5 — `packages/config/src/resolve.ts`: resolve `prompt_append_file`

The current `resolvePromptPaths` function:
- Iterates `config.agents`, resolves `prompt_file` to an absolute path.
- Explicitly skips categories (comment says "Categories are not modified").

**Changes:**

1. **Agents loop** — after resolving `prompt_file`, also resolve `prompt_append_file` if present:
   ```ts
   if (agent.prompt_append_file !== undefined) {
     const absoluteAppendPath = normalizePath(
       posix.join(normalizePath(scope.rootDir), "prompts", agent.prompt_append_file),
     );
     resolvedAgents[name] = { ...resolvedAgents[name], prompt_append_file: absoluteAppendPath };
   }
   ```
   > Ensure the spread uses the already-updated agent object (after `prompt_file` resolution) so both fields are resolved in one pass.

2. **Categories loop** — add a new loop over `config.categories` to resolve `prompt_append_file`:
   ```ts
   const resolvedCategories: WeaveConfig["categories"] = {};
   for (const [name, category] of Object.entries(config.categories)) {
     if (category.prompt_append_file === undefined) {
       resolvedCategories[name] = category;
       continue;
     }
     const absolutePath = normalizePath(
       posix.join(normalizePath(scope.rootDir), "prompts", category.prompt_append_file),
     );
     resolvedCategories[name] = { ...category, prompt_append_file: absolutePath };
   }
   return { ...config, agents: resolvedAgents, categories: resolvedCategories };
   ```

3. Update the JSDoc comment to reflect that categories are now also modified (for `prompt_append_file`).

---

### Step 6 — `packages/config/src/__tests__/resolve.test.ts`: resolve-level tests

Mirror the existing `prompt_file` test cases for `prompt_append_file`:

**Agents:**
- `(g)` builtin scope: agent with `prompt_append_file "extra.md"` → resolves to `<rootDir>/prompts/extra.md`.
- `(h)` global scope: same pattern.
- `(i)` project scope: same pattern.
- `(j)` agent without `prompt_append_file` is left unchanged.
- `(k)` agent with both `prompt_file` and `prompt_append_file` → both are resolved independently.
- `(l)` immutability: original config not mutated.

**Categories:**
- `(m)` project scope: category with `prompt_append_file "cat-extra.md"` → resolves to `<rootDir>/prompts/cat-extra.md`.
- `(n)` category without `prompt_append_file` is left unchanged.
- `(o)` immutability: original config not mutated.

---

### Step 7 — `packages/engine/src/compose.ts`: load and render `prompt_append_file`

The current `composeAgentDescriptor` function handles `prompt_append` as an inline string. Extend it to also handle `prompt_append_file`.

**Changes to `ComposeError` union** — add a new `sourceKind` variant:
```ts
sourceKind: "prompt" | "prompt_file" | "prompt_append" | "prompt_append_file";
```

**New helper `loadAppendSource`** (mirrors `loadPromptSource` but for the append slot):
```ts
function loadAppendSource(
  agentName: string,
  agentConfig: AgentConfig,
): ResultAsync<string | undefined, ComposeError> {
  if (agentConfig.prompt_append !== undefined)
    return okAsync(agentConfig.prompt_append);

  if (agentConfig.prompt_append_file === undefined)
    return okAsync(undefined);

  const appendFilePath = agentConfig.prompt_append_file;

  return ResultAsync.fromPromise(
    Bun.file(appendFilePath).text(),
    (cause) => ({
      type: "PromptFileReadError" as const,
      agentName,
      promptFilePath: appendFilePath,
      message: `Failed to read prompt_append_file for agent "${agentName}": ${appendFilePath}`,
      fileErrorMessage: cause instanceof Error ? cause.message : String(cause),
    }),
  ).map((text) => text);
}
```

**In `composeAgentDescriptor`** — replace the inline `prompt_append` rendering block with a call to `loadAppendSource`, then render the result:

```ts
// Determine sourceKind for error attribution
const appendSourceKind: "prompt_append" | "prompt_append_file" =
  agentConfig.prompt_append_file !== undefined
    ? "prompt_append_file"
    : "prompt_append";
const appendFilePath = agentConfig.prompt_append_file;
```

Then chain `loadAppendSource` into the existing `andThen`:
```ts
return loadPromptSource(agentName, agentConfig)
  .andThen((promptSource) => {
    // ... render primary ...
    return loadAppendSource(agentName, agentConfig);
  })
  .andThen((appendSource): Result<AgentDescriptor, ComposeError> => {
    // render appendSource if defined, then assemble composedPrompt
  });
```

> **Implementation note:** The current code uses a single `andThen` with an inline `Result` return. Restructure to two chained `andThen` calls (one for primary, one for append) to keep the happy path flat and avoid nested callbacks. Both `loadPromptSource` and `loadAppendSource` return `ResultAsync`, so the chain stays `ResultAsync` throughout.

**Category shuttle agents** — `composeAgentDescriptor` receives a merged `AgentConfig` for category shuttles (built by `generateCategoryShuttles` in `descriptors.ts`). The `prompt_append_file` field on the category config must be propagated into that merged agent config. Check `packages/engine/src/descriptors.ts` to confirm the merge path and add `prompt_append_file` to the spread if it is not already included via a full object spread.

---

### Step 8 — `packages/engine/src/__tests__/compose.test.ts`: compose-level tests

Add to the existing `describe("prompt_append")` block (or a new sibling `describe("prompt_append_file")`):

- Write a temp file with known content in `beforeAll` (reuse the existing `tempPromptFilePath` pattern).
- `prompt_append_file` content is appended after primary prompt, separated by `\n\n`.
- `prompt_append_file` with Mustache template (`{{agent.name}}`) is rendered correctly.
- When both `prompt_append` and `prompt_append_file` are absent, `composedPrompt` equals the primary prompt only (regression guard).
- `PromptFileReadError` is returned when `prompt_append_file` points to a non-existent file.
- Category shuttle with `prompt_append_file` resolves and appends correctly (requires a `CategoryMetadata` fixture with `prompt_append_file` set).

---

### Step 9 — `docs/` update

Update the DSL spec (likely `docs/specs/01-spec-core-dsl/index.md` or the AGENTS.md DSL section) to document:

- `prompt_append_file` field in the agent block table.
- `prompt_append_file` field in the category block table.
- Mutual exclusion rule with `prompt_append`.
- Path resolution semantics (same as `prompt_file`).
- Mustache rendering applies.

---

## Execution order and dependencies

```
Step 1 (schema)
  └─► Step 2 (schema tests)
  └─► Step 3 (validate tests)
  └─► Step 4 (parse_config tests)
Step 5 (resolve) — depends on Step 1 (new field in WeaveConfig type)
  └─► Step 6 (resolve tests)
Step 7 (compose) — depends on Step 1 + Step 5 (resolved absolute path available)
  └─► Step 8 (compose tests)
Step 9 (docs) — can be done any time after Step 1
```

Steps 1–4 are pure `@weave/core` changes and can be committed together.  
Steps 5–6 are `@weave/config` changes and depend on Step 1 being built/linked.  
Steps 7–8 are `@weave/engine` changes and depend on Steps 1 and 5.  
Step 9 is documentation and has no code dependency.

---

## Test coverage matrix (per AGENTS.md schema evolution rules)

| Constraint | schema.test.ts | validate.test.ts | parse_config.test.ts | resolve.test.ts | compose.test.ts |
|---|---|---|---|---|---|
| Accept valid `prompt_append_file` (agent) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Accept valid `prompt_append_file` (category) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reject `prompt_append` + `prompt_append_file` (agent) | ✅ | ✅ | ✅ | — | — |
| Reject `prompt_append` + `prompt_append_file` (category) | ✅ | ✅ | ✅ | — | — |
| Reject `..` in `prompt_append_file` (agent) | ✅ | ✅ | — | — | — |
| Reject absolute path in `prompt_append_file` (agent) | ✅ | ✅ | — | — | — |
| Reject `..` in `prompt_append_file` (category) | ✅ | ✅ | — | — | — |
| Path resolved to absolute (agent) | — | — | — | ✅ | — |
| Path resolved to absolute (category) | — | — | — | ✅ | — |
| File content appended in composed prompt | — | — | — | — | ✅ |
| Mustache rendering in `prompt_append_file` | — | — | — | — | ✅ |
| Missing file → `PromptFileReadError` | — | — | — | — | ✅ |
| Immutability (resolve does not mutate input) | — | — | — | ✅ | — |

---

## Key invariants to preserve

1. **No mutation** — `resolvePromptPaths` must return a new `WeaveConfig`; never mutate the input.
2. **neverthrow throughout** — `loadAppendSource` and any new fallible helpers return `Result`/`ResultAsync`. No `try/catch` except at Bun I/O boundaries via `ResultAsync.fromPromise`.
3. **Bun I/O only** — use `Bun.file(path).text()` for file reads; no `fs` or `node:fs`.
4. **Path safety enforced at schema layer** — `..` and absolute paths are rejected by Zod refinements before reaching `resolve.ts` or `compose.ts`.
5. **Mutual exclusion at schema layer** — the Zod `.refine()` is the single source of truth; no duplicate checks in `resolve.ts` or `compose.ts`.
6. **Category resolution is new** — `resolvePromptPaths` currently skips categories entirely. The new categories loop must not break existing category behaviour (categories without `prompt_append_file` pass through unchanged).
7. **`sourceKind` attribution** — `ComposeError.PromptTemplateError` must correctly attribute errors to `"prompt_append_file"` when the append source came from a file, so error messages are actionable.
