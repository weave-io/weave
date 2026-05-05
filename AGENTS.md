# Weave — Agent Guide

## What is Weave?

Weave is a **harness-agnostic multi-agent orchestration framework** built in TypeScript, run exclusively on **Bun**. A single `weave.config.ts` declares a fleet of AI agents (model, tools, skills, persona); the engine drives their full lifecycle through whichever harness adapter is active — OpenCode, Claude Code, Pi, or any future target.

| Layer        | Package            | Responsibility                                         |
| ------------ | ------------------ | ------------------------------------------------------ |
| **Core**     | `@weave/core`      | DSL types, schema, `defineConfig()`                    |
| **Engine**   | `@weave/engine`    | `WeaveRunner`, `HarnessAdapter` interface, pino logger |
| **Adapters** | `@weave/adapter-*` | Harness-specific `HarnessAdapter` implementations      |

## Package Structure

```
packages/
├── core/src/
│   ├── agent.ts        AgentConfig
│   ├── config.ts       WeaveConfig
│   ├── dsl.ts          defineConfig()
│   ├── hook.ts         HookConfig
│   ├── skill.ts        SkillConfig, SkillScope
│   └── index.ts        barrel
├── engine/src/
│   ├── adapter.ts      HarnessAdapter interface
│   ├── logger.ts       shared pino instance
│   ├── runner.ts       WeaveRunner class
│   └── index.ts        barrel
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

One error boundary per `try` block. Extract inner fallible steps into separate functions.

```ts
// ✅
async function readConfig(path: string): Promise<WeaveConfig> {
  try {
    return await loadAndParse(path);
  } catch (err) {
    log.error({ path, err }, "Failed to read config");
    throw err;
  }
}

// ❌
try {
  try { ... } catch { ... }
} catch { ... }
```

### Error boundaries must be logged

Never swallow errors silently. Log with the shared pino logger before re-throwing.

```ts
// ✅
} catch (err) {
  log.error({ err }, "Adapter init failed");
  throw err;
}

// ❌
} catch { /* nothing */ }
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

## Commands

```bash
bun install          # install all workspace deps
bun run build        # bundle + emit declarations for all packages
bun run typecheck    # tsc --noEmit across all source (no build needed)
bun test             # run all tests
bun run clean        # remove all dist/ folders
```
