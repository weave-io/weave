# TypeScript Conventions

House style for every TypeScript file in this repository: runtime, error handling, control flow, and logging.

**Related:** [Testing](testing.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [System Architecture](../architecture/system-overview.md)

---

## Runtime — Bun only

Weave runs on Bun. Never reach for the Node.js runtime surface.

- Runtime, package manager, test runner: `bun`
- Bundler: `bun build --target bun`
- Types: `bun-types` — never `@types/node`, `ts-node`, or `nodemon`
- File I/O: `Bun.file()` · Process: `Bun.spawn()` / `Bun.spawnSync()`

`node:path` and `node:os` are allowed. Bun implements them as built-in compatibility modules, so `import { resolve } from "node:path"` and `import { homedir } from "node:os"` are fine. What is forbidden is the Node.js runtime surface: `fs`, `child_process`, `@types/node`, `ts-node`. The `node:` prefix is the signal that Bun has adopted the module.

---

## Error handling — `neverthrow`

Every function or method that can fail returns `Result<T, E>` (sync) or `ResultAsync<T, E>` (async). Never throw for an expected failure path.

```ts
import { ok, err, Result } from "neverthrow";

// ✅ — explicit error type in the signature
function parseConfig(source: string): Result<WeaveConfig, ParseError[]> {
  const tokens = tokenize(source);
  if (tokens.isErr()) return err(tokens.error);
  return parse(tokens.value);
}

// ✅ — composes with andThen/map
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

Skip `neverthrow` only when a framework boundary demands another return shape (test callbacks, constructor constraints). Keep the internal logic on `Result` and convert at the boundary with `.match()`.

Model errors as discriminated unions with explicit domain types — never `unknown`, never bare strings.

```ts
type ParseError =
  | { type: "UnexpectedToken"; line: number; column: number; found: string; expected: string }
  | { type: "UnterminatedString"; line: number; column: number }
  | { type: "InvalidNumber"; line: number; column: number; value: string };
```

Wrap third-party code that throws with `Result.fromThrowable` / `ResultAsync.fromThrowable` instead of hand-written `try/catch`. Never catch only to log and rethrow.

### No nested try/catch

When `try/catch` is genuinely required (framework boundary, cleanup with `finally`), use one error boundary per block and extract inner fallible steps into functions that return `Result`.

```ts
// ✅ — neverthrow wrapper
const readFile = ResultAsync.fromThrowable(
  Bun.file(path).text,
  (e) => ({ type: "FileReadError" as const, path, cause: e }),
);

// ✅ — try/catch only at the outermost framework boundary
async function main(): Promise<void> {
  const result = await loadAndParse(configPath);
  result.match(
    (config) => startRunner(config),
    (errors) => { process.exitCode = 1; reportErrors(errors); },
  );
}
```

---

## Control flow and structure

### Early returns

Guard at the top and keep the happy path unindented. Never bury logic inside an `if` block.

```ts
// ✅
if (agent.prompt === undefined && agent.prompt_file === undefined) return;
if (disabledAgents.includes(agentName)) return;
registerAgent(agentName, agent);
```

### One ternary level, no if/else chains

Use sequential `if` returns or a `switch` for multi-branch logic.

```ts
// ✅
if (raw === "builtin") return "builtin";
if (raw === "user") return "user";
return "project";

// ❌
raw === "builtin" ? "builtin" : raw === "user" ? "user" : "project";
```

### Classes for organisation

Group state and behaviour in a class. No loose functions sharing implicit module-level state.

```ts
// ✅
export class WeaveRunner {
  constructor(private config: WeaveConfig, private adapter: HarnessAdapter) {}
}

// ❌
let globalAdapter: HarnessAdapter;
export function setAdapter(a: HarnessAdapter) { globalAdapter = a; }
```

### Reuse types and constants first

Before writing a new type, check whether one in `@weaveio/weave-core` can be extended. Shared constants live in the relevant package's `constants.ts` — look there before adding another.

```ts
// ✅
interface ExtendedAgentConfig extends AgentConfig {
  timeout?: number;
}
```

### Keep code testable

Inject dependencies (adapter, config, logger) through constructors. Keep side effects — file I/O, process spawning — in named private methods so tests can supply mocks without starting a real harness. See [Testing](testing.md).

---

## Logging

All logging goes through the shared pino instance exported from `@weaveio/weave-engine`. Never use `console.*` anywhere in the codebase.

```ts
import { logger } from "@weaveio/weave-engine";
const log = logger.child({ module: "adapter-pi" });

// ✅ structured — fields stay queryable
log.info({ agent: name, model: config.models?.[0] }, "Spawning agent");
log.error({ err }, "Unexpected failure");

// ❌ interpolated string
log.info(`Spawning agent ${name}`);
```

`LOG_LEVEL` controls the level at runtime (default `info`).
