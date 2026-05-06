# Libraries

- `packages/core/src/errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages/core/src/lexer.ts` — function tokenize: (source) => Result<Token[], LexError[]>, class Lexer
- `packages/core/src/parse-config.ts` — function parseConfig: (source) => Result<WeaveConfig, ConfigError[]>
- `packages/core/src/parser.ts` — function parse: (tokens) => Result<AstNode[], ParseError[]>, class Parser
- `packages/core/src/validate.ts` — function validate: (ast) => Result<WeaveConfig, ValidationError[]>
- `packages/engine/src/env.ts`
  - function parseEnv: (raw) => Env
  - type Env
  - const envSchema
  - const env: Env
- `packages/engine/src/runner.ts` — class WeaveRunner
