# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/engine/src/env.ts` — imported by **4** files
- `packages/core/src/errors.ts` — imported by **2** files
- `packages/core/src/agent.ts` — imported by **2** files
- `packages/core/src/hook.ts` — imported by **2** files
- `packages/core/src/skill.ts` — imported by **2** files
- `packages/core/src/config.ts` — imported by **2** files
- `packages/engine/src/adapter.ts` — imported by **2** files
- `packages/engine/src/logger.ts` — imported by **2** files
- `packages/core/src/dsl.ts` — imported by **1** files
- `packages/engine/src/runner.ts` — imported by **1** files

## Import Map (who imports what)

- `packages/engine/src/env.ts` ← `packages/engine/src/__tests__/env.test.ts`, `packages/engine/src/index.ts`, `packages/engine/src/index.ts`, `packages/engine/src/logger.ts`
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/__tests__/errors.test.ts`
- `packages/core/src/agent.ts` ← `packages/core/src/config.ts`, `packages/core/src/index.ts`
- `packages/core/src/hook.ts` ← `packages/core/src/config.ts`, `packages/core/src/index.ts`
- `packages/core/src/skill.ts` ← `packages/core/src/config.ts`, `packages/core/src/index.ts`
- `packages/core/src/config.ts` ← `packages/core/src/dsl.ts`, `packages/core/src/index.ts`
- `packages/engine/src/adapter.ts` ← `packages/engine/src/index.ts`, `packages/engine/src/runner.ts`
- `packages/engine/src/logger.ts` ← `packages/engine/src/index.ts`, `packages/engine/src/runner.ts`
- `packages/core/src/dsl.ts` ← `packages/core/src/index.ts`
- `packages/engine/src/runner.ts` ← `packages/engine/src/index.ts`
