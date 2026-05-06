# Libraries

- `packages/core/src/dsl.ts` — function defineConfig: (config) => WeaveConfig
- `packages/core/src/errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages/engine/src/env.ts`
  - function parseEnv: (raw) => Env
  - type Env
  - const envSchema
  - const env: Env
- `packages/engine/src/runner.ts` — class WeaveRunner
