# Pi Adapter Spike — Align with Real ExtensionAPI

## TL;DR
> **Summary**: Fix the Pi adapter's local `PiExtensionAPI` interface, tool definition shape, event handler, and subprocess delegation to match the real Pi extension contract, then prove it loads end-to-end via `pi --extension`.
> **Estimated Effort**: Medium

## Context
### Original Request
Align the spike Pi adapter with the real Pi `ExtensionAPI` (from `pi-mono`) and prove it works end-to-end.

### Key Findings
From reading `pi-mono/packages/coding-agent/src/core/extensions/types.ts`:

1. **`ToolDefinition`** requires `name`, `label`, `description`, TypeBox `parameters` (TSchema), and `execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>`. The adapter currently uses JSON Schema objects and `execute(args): Promise<unknown>` / `handler(args)` — completely wrong shape.

2. **`BeforeAgentStartEvent`** has `{ type, prompt, images?, systemPrompt, systemPromptOptions }`. Handler signature is `(event: BeforeAgentStartEvent, ctx: ExtensionContext) => BeforeAgentStartEventResult | void`. Result is `{ systemPrompt?: string; message?: CustomMessage }`. The adapter currently probes for agent name fields that don't exist and sets multiple field names on the event — should just return `{ systemPrompt }`.

3. **`AgentToolResult`** requires `{ content: (TextContent | ImageContent)[]; details: T }` — not a bare unknown.

4. **Subprocess delegation**: Pi's own subagent example uses `node:child_process.spawn` directly (not `pi.exec`), with flags: `--mode json -p --no-session --model X --tools X --append-system-prompt <tempfile>` then task as positional arg. The adapter's `--system-prompt`, `--task`, `--tools` (comma-separated inline) flags are wrong.

5. **`ExtensionHandler<E, R>`** = `(event: E, ctx: ExtensionContext) => Promise<R | void> | R | void` — handler receives a second `ctx` parameter.

6. **TypeBox**: Pi uses `typebox` (not `@sinclair/typebox`). For the spike, we can use `Type.Object(...)` inline. Since this is a spike, we can add `typebox` as a dev dependency or use `Type.Unsafe()` with a JSON Schema literal to avoid the dependency.

7. **`pi.on()`** is strongly typed with overloads — the adapter's `on(event: string, handler)` is too loose.

8. **No `inputSchema` or `handler` fields** on tool definitions — those are adapter inventions.

## Objectives
### Core Objective
Make the Pi adapter produce a valid Pi extension that loads, injects prompts, registers a working delegate tool, and can delegate via subprocess.

### Deliverables
- [ ] Updated `PiExtensionAPI` local interface matching real Pi contract
- [ ] Updated `PiToolDefinition` type matching real `ToolDefinition` shape
- [ ] Fixed `before_agent_start` handler using real event/result types
- [ ] Fixed subprocess delegation using real Pi CLI flags
- [ ] Updated spike entry point exporting correct factory shape
- [ ] Unit tests for the adapter with mock Pi API
- [ ] End-to-end manual verification via `pi --extension`

### Definition of Done
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes (including new adapter tests)
- [ ] `pi --extension ./path/to/built-spike.js` loads without errors and injects Weave system prompt

### Guardrails (Must NOT)
- Do NOT add `@earendil-works/pi-coding-agent` as a dependency — keep local interface
- Do NOT restructure the adapter class — minimal changes to align types
- Do NOT change engine or core packages
- Keep TypeBox usage minimal (inline `Type.Object` for delegate tool params only)

## TODOs

- [x] 1. Add `typebox` dev dependency
  **What**: Add `typebox` (the Pi-vendored TypeBox package, v1.1.24) as a dev dependency to `@weave/adapter-pi`. This is needed for tool parameter schemas. If `typebox` is not available on npm (it may be Pi-internal), use `@sinclair/typebox` with an alias or use `Type.Unsafe()` to pass raw JSON Schema — check Pi's actual import path first.
  **Files**: `packages/adapters/pi/package.json`
  **Acceptance**: `bun install` succeeds; TypeBox `Type` is importable in the adapter

- [x] 2. Update `PiExtensionAPI` local interface
  **What**: Rewrite the local interface to match the real Pi `ExtensionAPI` surface used by the adapter:
  - `on("before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: any) => Promise<BeforeAgentStartEventResult | void> | void): void`
  - `registerTool<TParams>(tool: PiToolDefinition<TParams>): void` (generic over TypeBox schema)
  - `setActiveTools(toolNames: string[]): void` (already correct)
  - `exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>` (already roughly correct)
  - Add local types: `BeforeAgentStartEvent { type, prompt, systemPrompt, systemPromptOptions, images? }`, `BeforeAgentStartEventResult { systemPrompt?: string }`, `AgentToolResult { content: { type: string; text: string }[]; details: unknown }`, `ExecResult`
  - Remove the loose `on(event: string, ...)` overload
  **Files**: `packages/adapters/pi/src/index.ts`
  **Acceptance**: Interface matches the real Pi types for the methods the adapter calls

- [x] 3. Rewrite `PiToolDefinition` and `buildDelegateTool()`
  **What**: Replace the JSON Schema `parameters`/`inputSchema` dual-field approach with a TypeBox schema. Match the real `ToolDefinition` shape:
  ```
  {
    name: "delegate",
    label: "Delegate",
    description: "...",
    parameters: Type.Object({ agent: Type.String(), task: Type.String() }),
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>
  }
  ```
  - Remove `inputSchema`, `handler` fields
  - Change `execute` signature from `(args: unknown) => Promise<unknown>` to `(toolCallId: string, params: {agent, task}, signal, onUpdate, ctx) => Promise<AgentToolResult>`
  - Return `{ content: [{ type: "text", text: "..." }], details: {} }` instead of bare values
  - Parse args from the typed `params` parameter (no more `parseDelegateToolArgs` on unknown)
  **Files**: `packages/adapters/pi/src/index.ts`
  **Acceptance**: Delegate tool definition matches Pi's `ToolDefinition` interface

- [x] 4. Fix `before_agent_start` handler
  **What**: Replace the current handler that probes for agent name and sets multiple system prompt fields. Pi is single-agent; always use the primary descriptor. The handler should:
  - Accept `(event: BeforeAgentStartEvent, ctx: any)`
  - Call `pi.setActiveTools(mapTools(primaryDescriptor.toolPolicy))`
  - Return `{ systemPrompt: primaryDescriptor.composedPrompt }` — this is the entire contract
  - Delete `extractAgentName()` function (Pi has no agent name in events)
  - Delete `injectSystemPrompt()` function (return value replaces prompt, don't mutate event)
  **Files**: `packages/adapters/pi/src/index.ts`
  **Acceptance**: Handler returns `{ systemPrompt }` only; no event mutation

- [x] 5. Fix subprocess delegation (`buildPiExecArgs` and `delegateToSubagent`)
  **What**: Align with real Pi CLI flags observed in the subagent example:
  - Use `--mode json -p --no-session` as base flags
  - Use `--model <model>` for model selection (already correct)
  - Use `--tools <comma-separated>` for tool restriction (already correct format)
  - Use `--append-system-prompt <tempfile>` instead of `--system-prompt <inline>` — write composed prompt to a temp file (use `Bun.write()` to a temp path)
  - Pass task as positional argument (not `--task`)
  - Remove `metadata` option from `pi.exec()` call (not in real API)
  - Consider whether to use `pi.exec()` or `Bun.spawn()` directly (Pi's own subagent uses `child_process.spawn`). For the spike, `pi.exec()` is simpler if it works with these flags.
  **Files**: `packages/adapters/pi/src/index.ts`
  **Acceptance**: Generated CLI args match `pi --mode json -p --no-session --model X --tools X --append-system-prompt /tmp/file "Task: ..."` pattern

- [x] 6. Update spike entry point
  **What**: Ensure `scripts/spike-pi-extension.ts` exports a valid `ExtensionFactory`:
  - `export default function(pi: PiExtensionAPI): Promise<void>` — already correct shape
  - Verify the spike builds to a `.js` file that Pi's jiti loader can consume
  - Remove the `-v2` agent renaming if it's no longer needed (Pi doesn't have built-in Weave agents to conflict with)
  - Simplify: just load config, run WeaveRunner, call `adapter.toExtension()(pi)`
  **Files**: `scripts/spike-pi-extension.ts`
  **Acceptance**: Spike exports default async function; builds cleanly

- [x] 7. Add unit tests for PiAdapter
  **What**: Create `packages/adapters/pi/src/__tests__/index.test.ts` with a `MockPiExtensionAPI` that records calls. Test:
  - `spawnSubagent()` collects descriptors
  - `toExtension()` registers delegate tool and before_agent_start handler
  - Delegate tool execute returns proper `AgentToolResult` shape
  - before_agent_start handler returns `{ systemPrompt }` with composed prompt
  - `setActiveTools` called with correct tool names based on policy
  - Subprocess args match expected Pi CLI flags
  **Files**: `packages/adapters/pi/src/__tests__/index.test.ts`
  **Acceptance**: `bun test packages/adapters/pi` passes

- [x] 8. Build and manual E2E verification
  **What**: Build the spike (`bun run build`), then run `pi --extension ./scripts/spike-pi-extension.ts` (or the built JS path) in the weave-vnext project directory. Verify:
  - Extension loads without errors in Pi's output
  - System prompt includes Weave-composed content (check via Pi's debug/verbose mode or by asking the agent "what are your instructions?")
  - Delegate tool appears in available tools
  - Active tools are set correctly
  **Acceptance**: Pi starts with Weave extension loaded; no errors in stderr; delegate tool visible

## Verification
- [x] `bun run typecheck` passes
- [x] `bun test` passes (all existing + new adapter tests)
- [x] `bun run build` succeeds
- [x] Manual: `pi --extension ./scripts/spike-pi-extension.ts` loads cleanly
- [x] No regressions in existing OpenCode adapter or core tests
