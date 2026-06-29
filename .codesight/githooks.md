# Git Hooks

> **Note for agents:** These hooks fire automatically on git operations and will block the operation if they fail.

## `pre-commit` — husky

- **set**: `set -euo pipefail`
- **echo**: `echo "▶ codesight..."`
- **npx**: `npx codesight`
- **git**: `git add .codesight/`
- **echo**: `echo "▶ lint-staged..."`
- **bunx**: `bunx lint-staged`
- **echo**: `echo "▶ typecheck..."`
- **bun**: `bun run typecheck`
- **echo**: `echo "▶ validate-config..."`
- **bun**: `bun run validate-config`
- **echo**: `echo "▶ test..."`
- **bun**: `bun test --recursive`
- **echo**: `echo "✔ all checks passed"`

_Source: .husky/pre-commit_
