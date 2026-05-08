# Weave — Agent Guide

## What is Weave?

Weave is a **harness-agnostic multi-agent orchestration framework** built in TypeScript, run exclusively on **Bun**. A custom `.weave` DSL declares agents, categories, workflows, and settings; the engine parses the DSL, validates the config, and drives the full agent lifecycle through whichever harness adapter is active — OpenCode, Claude Code, Pi, or any future target.

> **Reference**: `docs/legacy-architecture.md` documents the alpha, OpenCode-exclusive version of Weave (`opencode-weave`). That document is the source of truth for understanding what we are porting away from. The framework being built here is the harness-agnostic successor.

> **DSL-first agents**: Built-in agents (Loom, Tapestry, Shuttle, etc.) are defined using the same `.weave` DSL that end users use for custom agents. There is no separate code path for builtins — they are just well-known named entries in a config file. This means the DSL must be expressive enough to declare the full behaviour of any agent, and that users can replicate, extend, or replace any builtin by writing equivalent DSL config.

| Layer        | Package            | Responsibility                                                         |
| ------------ | ------------------ | ---------------------------------------------------------------------- |
| **Core**     | `@weave/core`      | DSL lexer, parser, AST, Zod schema validation, config types            |
| **Engine**   | `@weave/engine`    | `WeaveRunner`, `HarnessAdapter` interface, config loading, pino logger |
| **Adapters** | `@weave/adapter-*` | Harness-specific `HarnessAdapter` implementations                      |

## The `.weave` DSL

Weave uses a **custom configuration language** (`.weave` files) designed for readability and declarative agent orchestration. The syntax is block-structured and domain-specific — not TypeScript, not JSON, not YAML.

### Configuration Locations

| Scope       | Path                    | Purpose                                     |
| ----------- | ----------------------- | ------------------------------------------- |
| **Global**  | `~/.weave/config.weave` | User-level defaults, shared across projects |
| **Project** | `.weave/config.weave`   | Project-level config, overrides global      |

**Merge strategy**: Project values override global for scalars; objects deep-merge; arrays union-merge.

**Directory layout**:

```
~/.weave/                    # Global config root
├── config.weave             # Global agent/category/workflow definitions
└── prompts/                 # Global prompt files
    └── my-agent.md

.weave/                      # Project config root
├── config.weave             # Project agent/category/workflow definitions
├── prompts/                 # Project prompt files
│   ├── loom.md
│   ├── shuttle.md
│   └── custom-agent.md
├── plans/                   # Plan files (created by Pattern agent)
└── workflows/               # Additional workflow files (optional)
```

### DSL Syntax

#### Agents

```weave
agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    edit allow
    delegate allow
    search ask
  }

  triggers [
    { domain "Orchestration" trigger "Complex multi-step tasks" }
    { domain "Architecture" trigger "System design and planning" }
  ]

  skills ["tdd", "code-review"]
}

# Simple agent — minimal config with inline prompt
agent my-helper {
  prompt "You are a helpful assistant that answers questions concisely."
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.3
}

# Agent referencing a prompt file
agent shuttle {
  description "Shuttle (Domain Specialist)"
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
  mode all
  temperature 0.2

  tool_policy {
    read allow
    write allow
    edit allow
    delegate deny
  }
}
```

- `prompt` — inline prompt text (string)
- `prompt_file` — path to a `.md` file, resolved relative to the config scope's `prompts/` directory (e.g. `"loom.md"` → `.weave/prompts/loom.md`)
- `prompt` and `prompt_file` are **mutually exclusive**
- `models` — ordered preference list; first available wins
- `mode` — `primary` (respects UI model selection), `subagent` (uses own fallback chain), or `all` (both)
- `tool_policy` — abstract capability map with `allow` / `deny` / `ask` permissions; adapters map to harness-specific tool names and permission models
- `triggers` — delegation metadata for router agents (e.g. Loom's delegation table)

#### Categories

Categories define domain routing — glob patterns that direct work to specialised shuttle agents.

```weave
category backend {
  description "Backend APIs, services, persistence"
  models ["anthropic/claude-sonnet-4-5"]
  patterns ["src/api/**", "src/server/**", "src/db/**", "**/*.go"]
  prompt_append "Focus on API contracts, data integrity, and backwards compatibility."
  temperature 0.2

  tool_policy {
    read allow
    write allow
    delegate deny
  }
}

category frontend {
  description "Frontend UI, styling, accessibility"
  models ["openai/gpt-5"]
  patterns ["src/components/**", "src/pages/**", "**/*.tsx", "**/*.css"]
  prompt_append "Preserve accessibility, responsive behavior, and design-system consistency."
}
```

Categories automatically spawn `shuttle-{name}` agents (e.g. `shuttle-backend`, `shuttle-frontend`) that inherit from the base `shuttle` agent with category-specific overrides.

#### Workflows

Workflows define multi-step execution pipelines with agents, completion conditions, and artifact passing.

```weave
workflow secure-feature {
  description "Plan, implement, build, and review a feature with security audit"
  version 1

  step plan {
    name "Create implementation plan"
    type autonomous
    agent pattern
    prompt "Create a detailed implementation plan for: {{instance.goal}}"

    completion plan_created {
      plan_name "{{instance.slug}}"
    }

    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step review-plan {
    name "Review the plan"
    type interactive
    agent shuttle
    prompt "Review the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
    completion user_confirm
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent shuttle
    prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"

    completion plan_complete {
      plan_name "{{instance.slug}}"
    }

    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }

  step security-review {
    name "Security audit"
    type gate
    agent warp
    prompt "Perform a security audit of all changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}

workflow quick-fix {
  description "Fix a bug and get it reviewed"
  version 1

  step fix {
    name "Implement the fix"
    type autonomous
    agent shuttle
    prompt "Fix the following issue: {{instance.goal}}"
    completion agent_signal
  }

  step review {
    name "Code review"
    type gate
    agent weft
    prompt "Review the fix for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}
```

**Step types**: `autonomous` (agent works alone), `interactive` (user can intervene), `gate` (approve/reject checkpoint).

**Completion methods**: `agent_signal`, `user_confirm`, `plan_created`, `plan_complete`, `review_verdict`.

#### Settings and Disables

```weave
disable agents ["warp", "spindle"]
disable hooks ["on-session-idle"]
disable skills ["tdd"]

log_level INFO

continuation {
  recovery {
    compaction true
  }
  idle {
    enabled true
    work true
    workflow true
  }
}

analytics {
  enabled true
  use_fingerprint false
}
```

### DSL Design Principles

- **Readable** — Non-programmers should be able to read and roughly understand a config
- **Declarative** — Describes what, not how; no control flow, no functions, no imports
- **Block-structured** — `keyword name { ... }` for named blocks; flat `key value` for scalars
- **Minimal punctuation** — No semicolons, no trailing commas, no colons for key-value pairs
- **Comments** — `#` line comments
- **Strings** — Double-quoted; multi-line strings use triple-quote `""" ... """`
- **Arrays** — `["item1", "item2"]` — JSON-style for familiarity
- **Booleans** — bare `true` / `false`
- **Enums** — bare identifiers for fixed value sets (e.g. `allow`, `deny`, `ask`, `primary`, `subagent`)
- **Numbers** — bare numeric literals

## Package Structure

```
packages/
├── core/src/
│   ├── lexer.ts          Tokenizer for .weave files
│   ├── parser.ts         Token stream → AST
│   ├── ast.ts            AST node types
│   ├── schema.ts         Zod schemas for validated config
│   ├── config.ts         WeaveConfig and related inferred types
│   ├── errors.ts         Parse/validation error types
│   ├── validate.ts       AST → validated WeaveConfig (via Zod)
│   └── index.ts          barrel
├── engine/src/
│   ├── adapter.ts        HarnessAdapter interface
│   ├── loader.ts         Config file discovery, reading, merge
│   ├── logger.ts         shared pino instance
│   ├── runner.ts         WeaveRunner class
│   └── index.ts          barrel
└── adapters/
    ├── opencode/src/
    ├── claude-code/src/
    └── pi/src/
```

## Runtime — Bun Only

**Never use Node.js APIs.** Use Bun exclusively for everything:

- Runtime / package manager / test runner: `bun`
- Bundler: `bun build --target bun`
- Types: `bun-types` — never `@types/node`, `ts-node`, or `nodemon`
- File I/O: `Bun.file()` &nbsp;|&nbsp; Process: `Bun.spawn()` / `Bun.spawnSync()`

> **Note — `node:path` and `node:os` are allowed.** Bun implements these as built-in compatibility modules. Use `import { resolve } from "node:path"` for path manipulation and `import { homedir } from "node:os"` for home-directory resolution. What is forbidden is the Node.js *runtime surface*: `fs`, `child_process`, `@types/node`, `ts-node`, and so on. The `node:` protocol prefix is the signal that Bun has explicitly adopted the module.

## Error Handling — `neverthrow`

All functions and methods that can fail **must** return `Result<T, E>` (sync) or `ResultAsync<T, E>` (async) from the `neverthrow` library. Never throw exceptions for expected failure paths.

```ts
import { ok, err, Result } from "neverthrow";

// ✅ — returns Result with explicit error type
function parseConfig(source: string): Result<WeaveConfig, ParseError[]> {
  const tokens = tokenize(source);
  if (tokens.isErr()) return err(tokens.error);
  return parse(tokens.value);
}

// ✅ — composes Results with andThen/map
function loadAndParse(path: string): ResultAsync<WeaveConfig, ConfigError> {
  return readConfigFile(path).andThen(parseConfig).andThen(validateConfig);
}

// ❌ — throws on failure
function parseConfig(source: string): WeaveConfig {
  const tokens = tokenize(source);
  if (!tokens) throw new Error("Tokenization failed");
  return parse(tokens);
}
```

**Exceptions**: Only skip `neverthrow` when a framework boundary requires a different return shape (e.g. test callbacks, constructor constraints). In those cases, keep `neverthrow` for the internal logic and convert at the boundary using `.match()`.

**Error types**: Use discriminated unions with explicit domain error types — never `unknown` or bare strings.

```ts
type ParseError =
  | {
      type: "UnexpectedToken";
      line: number;
      column: number;
      found: string;
      expected: string;
    }
  | { type: "UnterminatedString"; line: number; column: number }
  | { type: "InvalidNumber"; line: number; column: number; value: string };
```

## Coding Rules

### Early returns

Guard at the top and keep the happy path unindented. Never bury logic inside an `if` block.

```ts
// ✅
if (!skill.path) return;
if (disabled.includes(skill.name)) return;
register(skill);

// ❌
if (skill.path) {
  if (!disabled.includes(skill.name)) {
    register(skill);
  }
}
```

### Classes for organisation

Group state and behaviour in a class. No loose functions sharing implicit module-level state.

```ts
// ✅
export class WeaveRunner {
  constructor(private config: WeaveConfig, private adapter: HarnessAdapter) {}
  async run(): Promise<void> { ... }
}

// ❌
let globalAdapter: HarnessAdapter;
export function setAdapter(a: HarnessAdapter) { globalAdapter = a; }
export function run() { /* relies on globalAdapter */ }
```

### No nested ternaries or if/else chains

One ternary level maximum. Use sequential `if` returns or a `switch` for multi-branch logic.

```ts
// ✅
if (raw === "builtin") return "builtin";
if (raw === "user") return "user";
return "project";

// ❌
raw === "builtin" ? "builtin" : raw === "user" ? "user" : "project";
```

### No nested try/catch

Prefer `neverthrow` wrappers over `try/catch`. When `try/catch` is truly necessary (framework boundary, cleanup with `finally`), use one error boundary per block. Extract inner fallible steps into separate functions that return `Result`.

```ts
// ✅ — neverthrow wrapper
const readFile = ResultAsync.fromThrowable(
  Bun.file(path).text,
  (e) => ({ type: "FileReadError" as const, path, cause: e }),
);

// ✅ — try/catch only at framework boundary
async function main(): Promise<void> {
  const result = await loadAndParse(configPath);
  result.match(
    (config) => startRunner(config),
    (errors) => { process.exitCode = 1; reportErrors(errors); },
  );
}

// ❌
try {
  try { ... } catch { ... }
} catch { ... }
```

### Errors must use `neverthrow` result types

Never swallow errors silently. Model failures explicitly in the return type. Use `Result.fromThrowable` to wrap third-party APIs that throw.

```ts
// ✅ — explicit error in return type
function validateAgent(raw: unknown): Result<AgentConfig, ValidationError[]> {
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) return err(toValidationErrors(parsed.error));
  return ok(parsed.data);
}

// ❌ — catches only to log and rethrow
try {
  return await readFile(path);
} catch (err) {
  log.error({ err }, "Failed");
  throw err;
}
```

### Reuse types and constants before creating new ones

Before writing a new type, check whether an existing one in `@weave/core` can be extended. Shared constants live in `constants.ts` within the relevant package — check it exists before adding a new one.

```ts
// ✅
interface ExtendedAgentConfig extends AgentConfig {
  timeout?: number;
}

// ❌ — duplicates every AgentConfig field just to add one
interface MyAgentConfig {
  name: string;
  model?: string;
  /* ... */ timeout?: number;
}
```

### Testable code

Inject all dependencies (adapter, config, logger) through constructors. Keep side effects (file I/O, process spawning) in named private methods so tests can provide mocks without starting a real harness.

## Testing

### Schema evolution and test maintenance

Zod schemas are the source of truth for config validation. Every schema change — adding a field, removing a field, narrowing a type, adding a `.refine()`, or changing a discriminated union variant — **must be reflected in the corresponding test file in the same commit**. Never land a schema change without updating its tests.

**Rule: schema change = test change, always in the same commit.**

| Change type                                 | Required test update                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| New field added                             | Accept valid value; reject invalid value                         |
| Field made required (`.optional()` removed) | Omit field → assert rejection with correct path                  |
| New `.refine()` or cross-field constraint   | Valid case passes; violation case rejected with readable message |
| New enum variant                            | New variant accepted; existing variants still pass               |
| New discriminated union variant             | Valid input for each variant; invalid discriminant rejected      |
| Field removed                               | Remove or update all tests that referenced it                    |

The test files that must be kept in sync with each schema layer:

| Schema layer                              | Test file                                          |
| ----------------------------------------- | -------------------------------------------------- |
| `packages/core/src/schema.ts`             | `packages/core/src/__tests__/schema.test.ts`       |
| Parser behaviour (`parser.ts`)            | `packages/core/src/__tests__/parser.test.ts`       |
| Validator / AST transform (`validate.ts`) | `packages/core/src/__tests__/validate.test.ts`     |
| Full pipeline (`parse-config.ts`)         | `packages/core/src/__tests__/parse_config.test.ts` |

For any change that touches `schema.ts`, add coverage at **all four levels** — unit (schema), transform (validate), and E2E (parse_config) — not just the schema test. The E2E test is the regression guard that catches wiring errors the unit test cannot.

### Module isolation: mocked adapters and dependencies

When building or extending a module that crosses a package or process boundary — a `HarnessAdapter`, file I/O, process spawning, network calls, or any interface defined in another package — **write the tests against a mock, not the real implementation**. Never start a real harness, write real files, or spawn real processes in unit or integration tests.

Mocks live alongside the tests they support. Create a `Mock*` class or inline stub that satisfies the interface's minimum surface for the test at hand.

```ts
// ✅ — mock adapter; no real harness, no file I/O
class MockAdapter implements HarnessAdapter {
  readonly calls: string[] = [];
  async init(): Promise<void> {}
  async spawnSubagent(name: string, config: AgentConfig): Promise<void> {
    this.calls.push(name);
  }
}

it("spawns all agents in config order", async () => {
  const adapter = new MockAdapter();
  const runner = new WeaveRunner(config, adapter);
  await runner.run();
  expect(adapter.calls).toEqual(["loom", "shuttle"]);
});

// ❌ — starts a real harness process
it("spawns agents", async () => {
  const adapter = new OpenCodeAdapter(); // needs a live OpenCode process
  ...
});
```

What to mock at each layer:

| Module under test                  | What to mock                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `WeaveRunner`                      | `HarnessAdapter` — implement the interface with in-memory stubs                                      |
| `HarnessAdapter` implementations   | File system (`Bun.file` → string fixtures), process (`Bun.spawn` → stub returning controlled output) |
| Config loader (`loader.ts`)        | Pass source strings directly; stub `Bun.file()` reads with known content                             |
| Any code calling external services | Replace the client with a minimal in-memory stub                                                     |

**Every critical module must have at least one isolated test file** — with all external dependencies replaced by mocks. "Critical" means any module in `packages/engine/`, any `HarnessAdapter` implementation, and any module that owns state or coordinates multiple components.

The existing `packages/engine/src/__tests__/runner.test.ts` is the canonical example: it exercises `WeaveRunner` fully via `MockAdapter` with no real harness involved.

## Logging

All logging uses the shared pino instance exported from `@weave/engine`. Never use `console.*` anywhere in the codebase.

```ts
import { logger } from "@weave/engine";
const log = logger.child({ module: "adapter-pi" });

// ✅ structured — fields are queryable in log aggregators
log.info({ agent: name, model: config.model }, "Spawning agent");
log.error({ err }, "Unexpected failure");

// ❌ interpolated string — don't do this
log.info(`Spawning agent ${name}`);
```

Log level is controlled at runtime via the `LOG_LEVEL` environment variable (default: `info`).

## Living Documentation

Every non-trivial change or decision **must be reflected in `docs/`** before the task is considered done. Documentation is a first-class deliverable, not an afterthought. AI agents reading these docs should be able to understand the framework well enough to extend or self-modify it without needing additional context.

### When to write docs

Write or update a doc whenever you:

- Add, remove, or rename a DSL keyword, block type, or field
- Change the behaviour of the lexer, parser, AST, validator, or config loader
- Introduce or modify a `HarnessAdapter` interface, method signature, or lifecycle hook
- Add a new package, adapter, or major module
- Make an architectural decision that future agents must respect
- Deprecate or migrate away from a pattern
- Fix a non-obvious bug whose root cause isn't evident from code alone

### Where docs live

```
docs/
├── legacy-architecture.md        # Alpha / OpenCode-era reference (read-only history)
├── specs/                        # Formal specs for DSL features and subsystems
│   └── 01-spec-core-dsl/         # One directory per spec, with index.md entry point
└── *.md                          # Conceptual guides, ADRs, how-tos
```

- **Specs** (`docs/specs/`) — detailed, numbered specs for subsystems. Each spec lives in its own directory with an `index.md`. Use a sequential number prefix (`02-`, `03-`, …) so specs have a stable reading order.
- **Guides** (`docs/*.md`) — conceptual overviews, architecture decision records (ADRs), how-to references. Name files with kebab-case (`harness-adapter.md`, `config-merge.md`).

### How to write docs

- **Link liberally** — every doc should cross-link to related docs, source files, and specs. Use relative Markdown links (`[loader](../engine/src/loader.ts)`, `[DSL spec](specs/01-spec-core-dsl/index.md)`).
- **Write for agents** — be explicit about _why_ a decision was made, not just _what_ was decided. Agents lack the conversation history; the doc is their only context.
- **Keep docs close to the change** — if you change `packages/core/src/lexer.ts`, update or create a doc that describes the lexer's responsibilities and any invariants it enforces.
- **Use ADR format for decisions** — when a choice has meaningful trade-offs, document it as a lightweight ADR: _Context → Decision → Consequences_.
- **One concept per file** — prefer several focused files over one sprawling document.

### Documentation checklist

Before marking any task complete, verify:

- [ ] Affected `docs/` files are updated or a new file is created
- [ ] New docs are linked from at least one existing doc or from this guide
- [ ] DSL changes are reflected in the relevant spec under `docs/specs/`
- [ ] Any deprecated pattern has a migration note in the relevant doc

## Commands

```bash
bun install          # install all workspace deps
bun run build        # bundle + emit declarations for all packages
bun run typecheck    # tsc --noEmit across all source (no build needed)
bun test             # run all tests
bun run clean        # remove all dist/ folders
```
