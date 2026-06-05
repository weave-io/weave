# Prompt Inspect CLI Command

## TL;DR
> **Summary**: Add `weave prompt inspect <agent-name>` and `weave prompt list` CLI commands that render and display the fully composed prompt for any agent, enabling prompt evaluation, diffing, and regression detection without custom code.
> **Estimated Effort**: Medium

## Context
### Original Request
Add a CLI command to inspect the final rendered prompt that a model receives for any Weave agent. Agent prompts are Mustache templates (`.md` files with `{{agent.name}}`, `{{#delegation.targets}}`, etc.) and there's currently no way to see the composed output without writing custom code.

### Key Findings
1. **`composeAgentDescriptor()`** in `packages/engine/src/compose.ts` is the core composition function. It takes `(agentName, agentConfig, config, allAgents, category?)` and returns `ResultAsync<AgentDescriptor, ComposeError>` where `AgentDescriptor.composedPrompt` is the final rendered text.

2. **`materializeAgents()`** in `packages/engine/src/materialization.ts` orchestrates composing ALL agents (explicit + generated category shuttles). It builds the combined agent map, handles disabled agents, and calls `composeAgentDescriptor` per agent.

3. **`loadConfig()`** in `packages/config/src/loader.ts` handles the full pipeline: builtins (with inlined prompts) → discover user configs → resolve prompt paths → merge. It accepts an optional `FileReader` for testability.

4. **`generateCategoryShuttles()`** in `packages/engine/src/descriptors.ts` produces synthetic `shuttle-{category}` agents from category definitions plus the base `shuttle` agent.

5. **CLI patterns**: The `runtime` command already uses subcommands (`status`|`journal`) parsed as flags in `args.ts`. The `validate` command shows config-loading patterns with `MemoryFileSystem` for testing.

6. **Arg parsing**: `packages/cli/src/args.ts` uses manual parsing — the `Command` type is a union, subcommands are parsed as flags after the command is identified. Commands are dispatched via dynamic `import()` in `cli.ts`.

7. **Error handling**: Commands return `Result<number, CliError>`. Errors are formatted via `formatCliError()` and written to stderr. The exit code pattern: return `ok(0)` for success, `ok(1)` for user-facing errors, and the `CliError` type for truly unexpected failures.

8. **Testing**: Tests use `MemoryFileSystem`, `BufferTerminal`, and `ThemeManager({ isTty: () => false })`. The validate test demonstrates the pattern clearly.

## Objectives
### Core Objective
Provide a zero-ceremony way to see the exact composed prompt for any Weave agent — builtins, category shuttles, and custom agents — directly from the CLI.

### Deliverables
- [ ] `weave prompt inspect <agent-name>` — outputs the fully rendered `composedPrompt`
- [ ] `weave prompt inspect <agent-name> --json` — outputs JSON with metadata (name, mode, models, temperature, tool policy, composedPrompt)
- [ ] `weave prompt list` — outputs all available agent names (explicit + generated shuttles)
- [ ] `weave prompt list --json` — outputs agent names as JSON array with metadata
- [ ] Error handling for unknown agent names, missing configs, composition failures

### Definition of Done
- [ ] `bun test` passes with new tests for the prompt command
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Running `weave prompt list` from the project root shows builtin agent names
- [ ] Running `weave prompt inspect loom` outputs the composed Loom prompt

### Guardrails (Must NOT)
- Must NOT write files or modify config (read-only inspection)
- Must NOT require a running harness
- Must NOT import adapter-specific code
- Must NOT use `console.*` (use `TerminalIO`)
- Must NOT throw exceptions (use `neverthrow` Results throughout)
- Must NOT read all prompt files when only one agent is requested (efficiency)

## TODOs

- [x] 1. Extend arg parser with `prompt` command and subcommands
  **What**: Add `"prompt"` to the `Command` union type. Parse `inspect` and `list` as subcommands (like `runtime` uses `runtimeSubcommand`). Capture the agent name as the first positional after `inspect`.
  **Files**: `packages/cli/src/args.ts`
  **Acceptance**: `parseArgs(["bun", "weave", "prompt", "inspect", "loom"])` returns `{ command: "prompt", flags: { promptSubcommand: "inspect", agentName: "loom" } }`. `parseArgs(["bun", "weave", "prompt", "list"])` returns `{ command: "prompt", flags: { promptSubcommand: "list" } }`.

- [x] 2. Add CLI error variants for prompt command
  **What**: Add `AgentNotFoundError` and `CompositionFailureError` to the `CliError` discriminated union with formatting in `formatCliError()`.
  **Files**: `packages/cli/src/errors.ts`
  **Acceptance**: New error types compile and `formatCliError()` handles them with human-readable messages.

- [x] 3. Implement the prompt command handler
  **What**: Create `runPrompt()` function following the same pattern as `runValidate()` and `runRuntime()`. The handler should:
  - Accept a context object with `terminal`, `theme`, `flags`, and an optional config loader (for DI in tests)
  - For `list`: load config → generate category shuttles → enumerate all agent names (explicit + generated, minus disabled) → output to stdout
  - For `inspect`: load config → generate category shuttles → build combined agent map → verify agent exists → call `composeAgentDescriptor()` for the single requested agent → output `composedPrompt` to stdout
  - For `--json` mode: wrap output in a JSON object with metadata fields (`name`, `description`, `mode`, `models`, `temperature`, `effectiveToolPolicy`, `composedPrompt`)
  - Return `ok(0)` on success, `ok(1)` on user errors (unknown agent, missing subcommand)
  **Files**: `packages/cli/src/commands/prompt.ts`
  **Acceptance**: Calling `runPrompt()` with a mock config that has an inline-prompt agent returns `ok(0)` and writes the composed prompt to stdout.

- [x] 4. Wire the prompt command into the CLI router
  **What**: Add `case "prompt"` to the `switch` in `cli.ts` that dynamically imports and calls `runPrompt()`. Show usage help when no subcommand is provided (like `runtime` does). Add `prompt` to the help text in `theme/render.ts`.
  **Files**: `packages/cli/src/cli.ts`, `packages/cli/src/theme/render.ts`
  **Acceptance**: Running `weave prompt` without a subcommand shows usage. Running `weave prompt inspect loom` dispatches to the handler.

- [x] 5. Write unit tests for arg parsing
  **What**: Add test cases in the existing args test file (or create one) verifying parsing of `prompt inspect <name>`, `prompt list`, `prompt inspect --json <name>`, and error cases (missing agent name).
  **Files**: `packages/cli/src/__tests__/args.test.ts`
  **Acceptance**: All new arg parsing paths are covered with assertions on `command`, `promptSubcommand`, and `agentName`.

- [x] 6. Write unit tests for the prompt command handler
  **What**: Test `runPrompt()` with mocked config loading. Use inline-prompt fixtures so `composeAgentDescriptor()` doesn't hit the filesystem. Test cases:
  - `list` returns all agent names (builtins + explicit + generated shuttles)
  - `list --json` returns JSON array
  - `inspect <existing>` outputs composed prompt text
  - `inspect <existing> --json` outputs JSON with all metadata fields
  - `inspect <unknown>` exits 1 with "agent not found" error
  - Missing subcommand shows usage and exits 1
  - Config load failure exits 1 with formatted error
  **Files**: `packages/cli/src/commands/__tests__/prompt.test.ts`
  **Acceptance**: All test cases pass with `bun test packages/cli/src/commands/__tests__/prompt.test.ts`.

- [x] 7. Add routing integration test
  **What**: Add a test in `routing.test.ts` verifying that `weave prompt` is recognized as a command (not "unknown command") and that `weave prompt --help` or bare `weave prompt` shows usage guidance.
  **Files**: `packages/cli/src/__tests__/routing.test.ts`
  **Acceptance**: The routing test file passes with the new cases.

## Verification
- [x] `bun run typecheck` exits 0
- [x] `bun test` passes all existing and new tests
- [x] `bun run build` succeeds without errors
- [ ] Manual smoke test: `bun packages/cli/src/main.ts prompt list` shows agent names
- [ ] Manual smoke test: `bun packages/cli/src/main.ts prompt inspect loom` outputs rendered prompt

## Implementation Notes

### Arg Parsing Design

Follow the `runtime` subcommand pattern. In the command parsing `switch`, add `"prompt"`. Then after the command is identified, parse the next positional as `promptSubcommand` (`"inspect"` | `"list"`). For `inspect`, capture the next positional as `agentName`.

```
// New flag fields in ParsedArgs["flags"]:
promptSubcommand?: "inspect" | "list";
agentName?: string;
```

### Command Handler Architecture

```typescript
// packages/cli/src/commands/prompt.ts
export interface PromptContext {
  terminal: TerminalIO;
  theme: ThemeColors;
  flags: ParsedArgs["flags"];
  /** Injectable for testing. Defaults to loadConfig(cwd). */
  configLoader?: () => ResultAsync<WeaveConfig, ConfigLoadError[]>;
}

export async function runPrompt(ctx: PromptContext): Promise<Result<number, CliError>> {
  // 1. Validate subcommand
  // 2. Load config
  // 3. Dispatch to list or inspect
}
```

### Single-Agent Composition (Efficient Path)

Rather than materializing ALL agents (which reads all prompt files), the `inspect` command should:
1. Call `loadConfig()` to get the merged `WeaveConfig`
2. Call `generateCategoryShuttles(config)` to get generated shuttles
3. Build combined `allAgents` map (explicit + generated, filter disabled)
4. Look up the requested agent by name
5. Call `composeAgentDescriptor()` for just that one agent

This means only the requested agent's prompt file is read — not all of them.

### JSON Output Schema

```json
{
  "name": "loom",
  "description": "Loom (Main Orchestrator)",
  "mode": "primary",
  "models": ["claude-sonnet-4-5", "gpt-4o"],
  "temperature": 0.1,
  "effectiveToolPolicy": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "delegate": "allow",
    "network": "ask"
  },
  "skills": ["tdd", "code-review"],
  "delegationTargets": ["shuttle", "pattern", "weft"],
  "composedPrompt": "You are Loom, the primary orchestrator..."
}
```

### List Output Formats

**Plain** (one name per line, pipe-friendly):
```
loom
shuttle
pattern
weft
warp
spindle
thread
tapestry
shuttle-backend
shuttle-frontend
```

**JSON** (`--json`):
```json
{
  "agents": [
    { "name": "loom", "description": "Loom (Main Orchestrator)", "mode": "primary" },
    { "name": "shuttle", "description": "Shuttle (Domain Specialist)", "mode": "all" }
  ]
}
```

### Test Fixtures

For command handler tests, create a minimal `WeaveConfig` fixture with inline prompts:

```typescript
const testConfig: WeaveConfig = {
  agents: {
    "test-agent": {
      prompt: "You are {{agent.name}}.",
      models: ["test-model"],
      mode: "subagent",
    },
  },
  categories: {},
  workflows: {},
  disabled: { agents: [], hooks: [], skills: [] },
  settings: { log_level: "INFO" },
  continuation: { recovery: { compaction: false }, idle: { enabled: false, work: false, workflow: false } },
  analytics: { enabled: false, use_fingerprint: false },
};
```

This avoids any file I/O in `composeAgentDescriptor()` since the agent uses inline `prompt`.

### Dependency Injection for Config Loading

The command handler accepts an optional `configLoader` function. In production, this defaults to `() => loadConfig(process.cwd())`. In tests, it returns a pre-built fixture config. This keeps the handler testable without mocking `Bun.file()` or requiring real config files on disk.
