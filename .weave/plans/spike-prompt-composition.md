# Spike: Prompt Composition (Issue #6)

## TL;DR
> **Summary**: Prove the full `.weave` DSL → engine → adapter → agent files loop for OpenCode and Pi, discovering the shape of the `AgentDescriptor` the engine hands to adapters.
> **Estimated Effort**: Medium

## Context
### Original Request
Build a spike that parses a `.weave` config with Loom + Thread, composes prompts with delegation info, and produces working agent `.md` files for both OpenCode and Pi harnesses.

### Key Findings
- **Core pipeline works**: Lexer → parser → Zod validation → `WeaveConfig` is complete. `resolvePromptPaths()` resolves `prompt_file` to absolute paths but does NOT read file content.
- **Runner is thin**: `WeaveRunner.run()` iterates agents, calls `adapter.spawnSubagent(name, AgentConfig)`. It passes raw `AgentConfig` (the Zod-inferred type) directly — no intermediate descriptor with composed prompt content.
- **The gap**: There is no prompt composition step. The engine never reads prompt files, never injects delegation tables, never produces a "ready to render" descriptor. Adapters receive `AgentConfig` with an unresolved `prompt_file` path and must do everything themselves.
- **OpenCode agent format**: YAML frontmatter with `mode`, `model`, `tools` (map), optional `hidden`, `color`. Body is the prompt markdown. Files go in `.opencode/agent/`.
- **Pi agent format**: YAML frontmatter with `name`, `description`, `tools` (comma-separated), `model`. Body is the prompt markdown. Files go in `.pi/agents/` (or project `agents/` dir).
- **Adapter packages exist** but are empty stubs (`packages/adapters/opencode/src/index.ts` is blank).
- **Adapter boundary rule**: Engine owns prompt composition (confirmed in `adapter-boundary.md` ownership matrix). Engine should produce a composed prompt; adapters translate the descriptor into harness-specific files.

## Objectives
### Core Objective
Discover and validate the shape of `AgentDescriptor` — the composed, prompt-resolved, delegation-enriched representation the engine hands to adapters.

### Deliverables
- [ ] `AgentDescriptor` type in `@weave/engine`
- [ ] `composeAgentDescriptor()` function that reads prompt files, injects delegation info, returns `AgentDescriptor`
- [ ] OpenCode adapter that writes `.opencode/agent/*.md` files from descriptors
- [ ] Pi adapter that writes `agents/*.md` files from descriptors (Pi convention)
- [ ] Runnable spike script: `bun run spike:compose --harness opencode|pi`
- [ ] Both harnesses produce working agent files for Loom (with delegation to Thread) and Thread

### Definition of Done
- [ ] `bun run spike:compose --harness opencode` produces `.opencode/agent/loom.md` and `.opencode/agent/thread.md` with correct frontmatter and composed prompts
- [ ] `bun run spike:compose --harness pi` produces `agents/loom.md` and `agents/thread.md` with correct frontmatter and composed prompts
- [ ] Loom's composed prompt includes delegation info mentioning Thread
- [ ] Thread's composed prompt has no delegation info
- [ ] Tool policies are translated to harness-specific tool permissions in frontmatter

### Guardrails (Must NOT)
- Do NOT change `@weave/core` (lexer, parser, schema) — it's complete
- Do NOT implement skills, workflows, categories, hooks, or analytics
- Do NOT make the engine discover harness resources (adapter boundary rule)
- This is throwaway spike code — don't over-engineer

## TODOs

- [x] 1. Define `AgentDescriptor` type
  **What**: Create the intermediate representation the engine produces after prompt composition. This is the spike's core discovery. Shape:
  ```ts
  interface AgentDescriptor {
    name: string;
    description?: string;
    composedPrompt: string;        // Full prompt text (file content + prompt_append + delegation section)
    models: string[];              // Ordered preference list
    mode: "primary" | "subagent" | "all";
    temperature?: number;
    toolPolicy: ToolPolicy;        // From @weave/core
    delegationTargets: DelegationTarget[];  // Agents this agent can delegate to
  }
  interface DelegationTarget {
    name: string;
    description?: string;
    triggers: DelegationTrigger[];  // From @weave/core
  }
  ```
  Key design decision: `composedPrompt` is a fully-assembled string. The engine owns composition; adapters just drop it into the markdown body.
  **Files**: `packages/engine/src/compose.ts`
  **Acceptance**: Type compiles, exported from `@weave/engine`

- [x] 2. Implement `composeAgentDescriptor()`
  **What**: Pure function that takes `AgentConfig`, agent name, the full `WeaveConfig` (for delegation lookup), and reads prompt file content. Returns `Result<AgentDescriptor, ComposeError>`.
  Steps:
  1. Read prompt content: if `prompt` is set, use it directly. If `prompt_file` is set (already resolved to absolute path by `@weave/config`), read file via `Bun.file().text()`.
  2. Build delegation targets: scan `config.agents` for agents whose `triggers` reference domains this agent can delegate to. For the spike, simplify: if agent has `tool_policy.delegate === "allow"`, include ALL other non-disabled agents as delegation targets.
  3. If delegation targets exist, append a `## Delegation` section to the prompt listing each target with its description and triggers.
  4. Append `prompt_append` if present.
  5. Assemble `AgentDescriptor`.
  **Files**: `packages/engine/src/compose.ts`
  **Acceptance**: Unit test with inline prompt + delegation targets produces expected composed prompt string

- [x] 3. Write unit tests for `composeAgentDescriptor()`
  **What**: Test cases:
  - Agent with `prompt` (inline) → `composedPrompt` equals the inline string
  - Agent with `prompt_file` → reads file, returns content (mock `Bun.file`)
  - Agent with `delegate: allow` → delegation section appended with target agents
  - Agent with `delegate: deny` → no delegation section
  - Agent with `prompt_append` → appended after prompt content
  - Missing prompt file → returns `ComposeError`
  **Files**: `packages/engine/src/__tests__/compose.test.ts`
  **Acceptance**: `bun test packages/engine/src/__tests__/compose.test.ts` passes

- [x] 4. Implement OpenCode adapter
  **What**: `OpenCodeAdapter` implements `HarnessAdapter`. For the spike, only `spawnSubagent` matters. It receives an `AgentDescriptor` (we'll update the interface — see note below) and writes a `.md` file to `.opencode/agent/{name}.md`.
  
  **Interface change for spike**: Change `spawnSubagent(name, config)` to `spawnSubagent(name, descriptor)` where descriptor is `AgentDescriptor`. This is the key spike learning — the adapter needs composed data, not raw config.
  
  OpenCode frontmatter mapping:
  - `mode` → `mode` (direct: `primary`/`subagent` map to OpenCode's `primary`/`subagent`; `all` → omit or use `primary`)
  - `model` → first entry from `descriptor.models`
  - `tools` → translate `toolPolicy` to OpenCode tool permission map (e.g. `{ "read": true, "write": true, "execute": true }` — spike can use simple boolean map)
  
  Body: `descriptor.composedPrompt`
  **Files**: `packages/adapters/opencode/src/index.ts`
  **Acceptance**: Calling `spawnSubagent("loom", loomDescriptor)` writes `.opencode/agent/loom.md` with valid YAML frontmatter + prompt body

- [x] 5. Create Pi adapter package and implement
  **What**: Create `@weave/adapter-pi` package (if not exists) with `PiAdapter` implementing `HarnessAdapter`.
  
  Pi frontmatter mapping:
  - `name` → `descriptor.name`
  - `description` → `descriptor.description`
  - `model` → first entry from `descriptor.models`
  - `tools` → translate `toolPolicy` to Pi tool list (comma-separated: `read, grep, find, ls, write, bash` etc. based on allow/deny)
  
  Body: `descriptor.composedPrompt`
  Output dir: `agents/{name}.md` (Pi convention from examples)
  **Files**: `packages/adapters/pi/src/index.ts`, `packages/adapters/pi/package.json`, `packages/adapters/pi/tsconfig.json`, `packages/adapters/pi/tsconfig.build.json`
  **Acceptance**: Calling `spawnSubagent("thread", threadDescriptor)` writes `agents/thread.md` with valid Pi frontmatter

- [x] 6. Update `HarnessAdapter` interface for spike
  **What**: Change `spawnSubagent` signature from `(name: string, config: AgentConfig)` to `(name: string, descriptor: AgentDescriptor)`. Update `WeaveRunner.run()` to call `composeAgentDescriptor()` for each agent before passing to adapter.
  
  **Important**: This is a spike change. The final API shape will be informed by what we learn. Mark the change with a `// SPIKE:` comment.
  **Files**: `packages/engine/src/adapter.ts`, `packages/engine/src/runner.ts`, `packages/engine/src/index.ts`
  **Acceptance**: `bun run typecheck` passes, existing runner test updated

- [x] 7. Update existing runner test
  **What**: Update `MockAdapter` in `packages/engine/src/__tests__/runner.test.ts` to accept `AgentDescriptor` instead of `AgentConfig`. Verify the mock still captures agent names correctly.
  **Files**: `packages/engine/src/__tests__/runner.test.ts`
  **Acceptance**: `bun test packages/engine/src/__tests__/runner.test.ts` passes

- [x] 8. Create spike runner script
  **What**: CLI script at `scripts/spike-compose.ts` that:
  1. Parses `.weave/config.weave` using `@weave/core`
  2. Resolves prompt paths using `@weave/config`
  3. Filters to just `loom` and `thread` agents (spike scope)
  4. Instantiates the chosen adapter (OpenCode or Pi) based on `--harness` arg
  5. Runs `WeaveRunner.run()` which composes descriptors and calls adapter
  6. Prints summary of generated files
  
  Add `package.json` script: `"spike:compose": "bun scripts/spike-compose.ts"`
  **Files**: `scripts/spike-compose.ts`, `package.json`
  **Acceptance**: `bun run spike:compose --harness opencode` and `bun run spike:compose --harness pi` both produce agent files

- [x] 9. Manual verification and findings doc
  **What**: Run the spike for both harnesses. Inspect output files. Write a short findings doc at `docs/spikes/spike-prompt-composition.md` capturing:
  - The `AgentDescriptor` shape that worked
  - What the engine should own vs what adapters needed to customize
  - Delegation info injection approach (did appending a section work? too rigid?)
  - Tool policy translation challenges per harness
  - Recommendations for the real implementation
  **Files**: `docs/spikes/spike-prompt-composition.md`
  **Acceptance**: Doc exists with concrete findings and recommendations

## Verification
- [x] `bun run typecheck` passes
- [x] `bun test` passes (all existing + new tests)
- [x] `bun run spike:compose --harness opencode` produces 2 agent files with correct format
- [x] `bun run spike:compose --harness pi` produces 2 agent files with correct format
- [x] Loom's output contains delegation info about Thread in both harnesses
- [x] Thread's output has NO delegation info in both harnesses
- [x] Findings doc written with learnings for the real implementation
