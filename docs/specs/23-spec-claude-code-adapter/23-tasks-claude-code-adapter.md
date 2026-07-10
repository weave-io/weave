## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `packages/adapters/claude-code/package.json` | New package definition |
| `packages/adapters/claude-code/tsconfig.json` | TypeScript config |
| `packages/adapters/claude-code/tsconfig.build.json` | Build-time TS config |
| `packages/adapters/claude-code/src/index.ts` | Barrel export |
| `packages/adapters/claude-code/src/adapter.ts` | `ClaudeCodeAdapter` implementing `HarnessAdapter` |
| `packages/adapters/claude-code/src/agent-translation.ts` | AgentDescriptor → Claude Code agent markdown |
| `packages/adapters/claude-code/src/tool-classification.ts` | Claude Code tool names → abstract capabilities |
| `packages/adapters/claude-code/src/skill-discovery.ts` | Command file discovery → `SkillInfo[]` |
| `packages/adapters/claude-code/src/model-resolution.ts` | Static model context for `resolveAdapterModelIntent()` |
| `packages/adapters/claude-code/src/__tests__/agent-translation.test.ts` | Translation unit tests |
| `packages/adapters/claude-code/src/__tests__/tool-classification.test.ts` | Tool classification unit tests |
| `packages/adapters/claude-code/src/__tests__/skill-discovery.test.ts` | Skill discovery unit tests |
| `packages/adapters/claude-code/src/__tests__/adapter.test.ts` | Adapter integration tests |
| `docs/claude-code-adapter.md` | Planning doc to update status |

### Notes

- All tests use mocked filesystem/process — no real Claude Code binary required.
- Follow the existing OpenCode adapter structure as a reference.
- Use `neverthrow` for all fallible paths.
- Use Bun APIs exclusively (no Node.js runtime surface).

## Tasks

### [x] 1.0 Package skeleton and build configuration

#### 1.0 Tasks

- [x] 1.1 Create `packages/adapters/claude-code/package.json` with name `@weaveio/weave-adapter-claude-code`, dependencies on `@weaveio/weave-core`, `@weaveio/weave-engine`, and `neverthrow`.
- [x] 1.2 Create `packages/adapters/claude-code/tsconfig.json` and `tsconfig.build.json` mirroring the OpenCode adapter pattern.
- [x] 1.3 Create `packages/adapters/claude-code/src/index.ts` barrel export.
- [x] 1.4 Verify `bun install` succeeds with the new workspace package.

### [x] 2.0 Tool classification module

#### 2.0 Tasks

- [x] 2.1 Create `packages/adapters/claude-code/src/tool-classification.ts` with a `CLAUDE_CODE_TOOL_CLASSIFICATIONS` constant array mapping Claude Code tools (Read, Write, Edit, MultiEdit, Bash, Task, WebFetch, WebSearch) to abstract capabilities.
- [x] 2.2 Export a helper function `getClaudeCodeToolClassifications()` returning the classifications array.
- [x] 2.3 Create `packages/adapters/claude-code/src/__tests__/tool-classification.test.ts` verifying all mappings are correct and cover all abstract capabilities.

### [x] 3.0 Agent translation module

#### 3.0 Tasks

- [x] 3.1 Create `packages/adapters/claude-code/src/agent-translation.ts` with a `translateAgentToMarkdown(descriptor: AgentDescriptor, resolvedModel: string, allowedTools: string[]): string` function that produces Claude Code agent markdown format with YAML frontmatter.
- [x] 3.2 Handle: name, description, model, tools list in frontmatter; composedPrompt as markdown body.
- [x] 3.3 Create `packages/adapters/claude-code/src/__tests__/agent-translation.test.ts` testing basic agent, category shuttle agent, and agent with all fields populated.

### [x] 4.0 Model resolution module

#### 4.0 Tasks

- [x] 4.1 Create `packages/adapters/claude-code/src/model-resolution.ts` with a static `CLAUDE_CODE_AVAILABLE_MODELS` set and a `buildClaudeCodeModelInput(descriptor: AgentDescriptor): ModelResolutionInput` helper.
- [x] 4.2 Create `packages/adapters/claude-code/src/__tests__/model-resolution.test.ts` verifying model input construction and availability filtering.

### [x] 5.0 Skill discovery module

#### 5.0 Tasks

- [x] 5.1 Create `packages/adapters/claude-code/src/skill-discovery.ts` with a `discoverClaudeCodeSkills(projectRoot: string, homeDir: string): ResultAsync<SkillInfo[], Error>` function that discovers `.claude/commands/*.md` and `~/.claude/commands/*.md`.
- [x] 5.2 Create `packages/adapters/claude-code/src/__tests__/skill-discovery.test.ts` with mocked filesystem testing discovery of global and project commands.

### [x] 6.0 Adapter implementation

#### 6.0 Tasks

- [x] 6.1 Create `packages/adapters/claude-code/src/adapter.ts` implementing `HarnessAdapter` with `init()`, `loadAvailableSkills()`, and `spawnSubagent()`.
- [x] 6.2 `init()` should detect Claude Code availability (check for `.claude/` directory or `claude` binary), build capability contract, log readiness.
- [x] 6.3 `spawnSubagent()` should resolve model, resolve tool decisions, translate to markdown, and write to `.claude/agents/<name>.md`.
- [x] 6.4 Create `packages/adapters/claude-code/src/__tests__/adapter.test.ts` with mocked filesystem testing init, skill loading, and agent materialization.

### [x] 7.0 Build verification and integration

#### 7.0 Tasks

- [x] 7.1 Verify `bun run typecheck` passes for the new package.
- [x] 7.2 Verify `bun test` passes for all new test files.
- [x] 7.3 Verify `bun run build` succeeds (add build script to package.json if needed).
- [x] 7.4 Update `docs/claude-code-adapter.md` status from "Planning note" to "Initial implementation — materialization adapter".
