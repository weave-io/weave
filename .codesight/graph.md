# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/config/src/discovery.ts` — imported by **5** files
- `packages/config/src/types.ts` — imported by **5** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/descriptors.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files
- `packages/config/src/builtins.ts` — imported by **3** files
- `packages/config/src/merge.ts` — imported by **3** files
- `packages/config/src/resolve.ts` — imported by **3** files
- `packages/config/src/errors.ts` — imported by **3** files
- `packages/core/src/validate.ts` — imported by **3** files
- `packages/engine/src/adapter.ts` — imported by **3** files
- `packages/config/src/loader.ts` — imported by **2** files
- `packages/config/src/logger.ts` — imported by **2** files
- `packages/core/src/parse-config.ts` — imported by **2** files
- `packages/core/src/schema.ts` — imported by **2** files
- `packages/engine/src/runner.ts` — imported by **2** files
- `packages/engine/src/logger.ts` — imported by **2** files

## Import Map (who imports what)

- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/config/src/discovery.ts` ← `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/index.ts`
- `packages/config/src/types.ts` ← `packages/config/src/__tests__/resolve.test.ts`, `packages/config/src/discovery.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`, `packages/config/src/resolve.ts`
- `packages/core/src/lexer.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/core/src/parser.ts` ← `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`
- `packages/engine/src/descriptors.ts` ← `packages/engine/src/__tests__/descriptors.test.ts`, `packages/engine/src/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/runner.ts`
- `packages/engine/src/env.ts` ← `packages/engine/src/__tests__/env.test.ts`, `packages/engine/src/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/logger.ts`
- `packages/config/src/builtins.ts` ← `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`
- `packages/config/src/merge.ts` ← `packages/config/src/__tests__/merge.test.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`
