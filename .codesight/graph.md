# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/cli/src/theme/colors.ts` — imported by **10** files
- `packages/cli/src/io/terminal.ts` — imported by **8** files
- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/engine/src/compose.ts` — imported by **8** files
- `packages/cli/src/fs/file-system.ts` — imported by **7** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/cli/src/theme/render.ts` — imported by **5** files
- `packages/cli/src/args.ts` — imported by **5** files
- `packages/config/src/discovery.ts` — imported by **5** files
- `packages/config/src/types.ts` — imported by **5** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/engine/src/descriptors.ts` — imported by **5** files
- `packages/engine/src/logger.ts` — imported by **5** files
- `packages/cli/src/cli.ts` — imported by **4** files
- `packages/cli/src/errors.ts` — imported by **4** files
- `packages/config/src/builtins.ts` — imported by **4** files
- `packages/config/src/normalize-path.ts` — imported by **4** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files
- `packages/cli/src/commands/validate.ts` — imported by **3** files

## Import Map (who imports what)

- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/init.ts` +5 more
- `packages/cli/src/io/terminal.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/init.ts` +3 more
- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/engine/src/compose.ts` ← `packages/engine/src/__tests__/compose.test.ts`, `packages/engine/src/__tests__/mock-adapter.ts`, `packages/engine/src/__tests__/template-context.test.ts`, `packages/engine/src/adapter.ts`, `packages/engine/src/index.ts` +3 more
- `packages/cli/src/fs/file-system.ts` ← `packages/cli/src/__tests__/file-system.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/installers/__tests__/installers.test.ts` +2 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/cli/src/theme/render.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index.ts`
- `packages/cli/src/args.ts` ← `packages/cli/src/cli.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index.ts`
- `packages/config/src/discovery.ts` ← `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/index.ts`
- `packages/config/src/types.ts` ← `packages/config/src/__tests__/resolve.test.ts`, `packages/config/src/discovery.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`, `packages/config/src/resolve.ts`
