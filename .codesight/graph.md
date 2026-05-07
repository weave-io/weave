# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files
- `packages/core/src/validate.ts` — imported by **3** files
- `packages/engine/src/adapter.ts` — imported by **3** files
- `packages/core/src/parse-config.ts` — imported by **2** files
- `packages/core/src/schema.ts` — imported by **2** files
- `packages/engine/src/runner.ts` — imported by **2** files
- `packages/engine/src/logger.ts` — imported by **2** files
- `packages/engine/src/__tests__/mock-adapter.ts` — imported by **1** files
- `scripts/validate-config.ts` — imported by **1** files

## Import Map (who imports what)

- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/core/src/lexer.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/core/src/parser.ts` ← `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/engine/src/env.ts` ← `packages/engine/src/__tests__/env.test.ts`, `packages/engine/src/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/logger.ts`
- `packages/core/src/validate.ts` ← `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/engine/src/adapter.ts` ← `packages/engine/src/__tests__/mock-adapter.ts`, `packages/engine/src/index.ts`, `packages/engine/src/runner.ts`
- `packages/core/src/parse-config.ts` ← `packages/core/src/__tests__/parse_config.test.ts`, `packages/core/src/index.ts`
- `packages/core/src/schema.ts` ← `packages/core/src/parse-config.ts`, `packages/core/src/validate.ts`
- `packages/engine/src/runner.ts` ← `packages/engine/src/__tests__/runner.test.ts`, `packages/engine/src/index.ts`
