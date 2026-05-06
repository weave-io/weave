---
description: "Use when building, testing, or deploying JavaScript/TypeScript applications. Reach for Bun when you need to run scripts, manage packages, bundle code, or test applications with a single unified toolkit that replaces Node.js, npm, and other build tools."
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product summary

Bun is an all-in-one JavaScript/TypeScript toolkit that replaces Node.js, npm, and other build tools. It ships as a single executable and includes a runtime, package manager, test runner, and bundler. Use `bun run` to execute scripts, `bun install` to manage dependencies, `bun test` for testing, and `bun build` for bundling. The primary documentation is at https://bun.com/docs. Key files: `bunfig.toml` (configuration), `bun.lock` (lockfile), `package.json` (project metadata).

## When to use

- **Running scripts & servers**: Use `bun run` to execute TypeScript/JSX files directly without compilation overhead, or `Bun.serve()` to build HTTP servers
- **Package management**: Use `bun install`, `bun add`, `bun remove` to manage dependencies 25x faster than npm
- **Testing**: Use `bun test` for Jest-compatible testing with TypeScript support, snapshots, and watch mode
- **Bundling**: Use `bun build` to bundle JavaScript/TypeScript for browsers or servers, including full-stack applications with HTML imports
- **Replacing Node.js**: Use Bun as a drop-in replacement for Node.js in existing projects with minimal changes
- **Building CLIs**: Use `bun build --compile` to create standalone executables

## Quick reference

### Core commands

| Command | Purpose |
|---------|---------|
| `bun run <script>` | Execute a script from package.json or a file |
| `bun install` | Install all dependencies (creates bun.lock) |
| `bun add <pkg>` | Add a package to dependencies |
| `bun add -d <pkg>` | Add a package to devDependencies |
| `bun remove <pkg>` | Remove a package |
| `bun test` | Run tests matching `*.test.ts`, `*.spec.ts` patterns |
| `bun build <entry>` | Bundle code for browser or server |
| `bunx <pkg>` | Execute a package without installing |

### Configuration files

| File | Purpose |
|------|---------|
| `bunfig.toml` | Bun-specific configuration (runtime, test, install, bundler) |
| `package.json` | Project metadata, scripts, dependencies |
| `tsconfig.json` | TypeScript configuration (Bun respects this) |
| `bun.lock` | Lockfile (text format by default since v1.2) |

### Common bunfig.toml sections

```toml
# Runtime behavior
preload = ["./setup.ts"]
jsx = "react"
logLevel = "debug"

# Package manager
[install]
optional = true
dev = true
production = false
linker = "hoisted"  # or "isolated"

# Test runner
[test]
root = "./__tests__"
coverage = false
timeout = 5000

# Server defaults
[serve]
port = 3000
```

## Decision guidance

| Scenario | Use | Why |
|----------|-----|-----|
| Need to run a TypeScript file | `bun run file.ts` | No compilation step needed; Bun transpiles on the fly |
| Need to install packages | `bun install` | 25x faster than npm; creates bun.lock automatically |
| Need to add a single package | `bun add pkg` | Faster than `npm install pkg` |
| Need to test code | `bun test` | Jest-compatible, built-in, no extra setup |
| Need to bundle for browser | `bun build --target browser` | Optimized for client-side code |
| Need to bundle for server | `bun build --target bun` | Optimized for Bun runtime; can create executables |
| Need to create a CLI tool | `bun build --compile` | Creates standalone executable with Bun embedded |
| Hoisted vs isolated installs | Use `hoisted` for single packages, `isolated` for monorepos | Isolated prevents phantom dependencies; hoisted is traditional npm behavior |

## Workflow

### 1. Initialize a new project
```bash
bun init my-app
# Choose template: Blank, React, or Library
cd my-app
```

### 2. Install dependencies
```bash
bun install
# Or add specific packages
bun add react
bun add -d @types/react
```

### 3. Create and run scripts
Add to `package.json`:
```json
{
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "build": "bun build src/index.ts --outdir dist",
    "test": "bun test"
  }
}
```

Run with:
```bash
bun run dev
bun run build
bun test
```

### 4. Build an HTTP server
```typescript
const server = Bun.serve({
  port: 3000,
  routes: {
    "/": () => new Response("Hello!"),
    "/api/users/:id": req => new Response(`User ${req.params.id}`),
  },
});
console.log(`Server at ${server.url}`);
```

Run with: `bun run server.ts`

### 5. Write and run tests
```typescript
import { test, expect } from "bun:test";

test("addition", () => {
  expect(2 + 2).toBe(4);
});
```

Run with: `bun test` or `bun test --watch`

### 6. Bundle for production
```bash
bun build src/index.ts --outdir dist --minify
# Or create a standalone executable
bun build src/cli.ts --outfile mycli --compile
```

## Common gotchas

- **TypeScript without types**: Install `@types/bun` as a dev dependency and add `"lib": ["ESNext"]` to `tsconfig.json` to avoid type errors on the `Bun` global
- **Lifecycle scripts disabled by default**: Bun doesn't run `postinstall` scripts for security. Add packages to `trustedDependencies` in `package.json` if needed
- **Auto-install can mask issues**: By default, Bun auto-installs missing packages. Disable with `[install] auto = "disable"` in `bunfig.toml` for stricter dependency management
- **Lockfile format changed**: Bun v1.2+ uses text-based `bun.lock` instead of binary `bun.lockb`. Old projects can migrate with `bun install --save-text-lockfile`
- **Node.js compatibility incomplete**: Not all Node.js APIs are implemented. Check the [compatibility page](/runtime/nodejs-compat) before migrating large projects
- **Peer dependencies installed by default**: Unlike npm, Bun installs peer dependencies automatically. Use `[install] peer = false` to disable
- **Watch mode requires `--hot` flag**: Use `bun run --hot` for hot module reloading, not just `--watch`
- **Bundler doesn't replace tsc**: Use `bun build` for bundling, but still use `tsc` or another tool for type checking and `.d.ts` generation
- **Environment variables in bundles**: By default, `process.env.*` is inlined at build time. Use `env: "disable"` to prevent this
- **Test discovery is automatic**: Tests must match `*.test.ts`, `*.spec.ts` patterns. Custom patterns require `--test-name-pattern` flag

## Verification checklist

Before submitting work with Bun:

- [ ] Run `bun install` to verify dependencies resolve without errors
- [ ] Run `bun test` to ensure all tests pass
- [ ] Run `bun run build` (or your build script) to verify bundling succeeds
- [ ] Check `bun.lock` is committed to version control (for reproducible installs)
- [ ] Verify `bunfig.toml` contains necessary configuration (if using custom settings)
- [ ] Test with `bun run <script>` to ensure scripts execute correctly
- [ ] For HTTP servers, verify `Bun.serve()` starts without errors and responds to requests
- [ ] For bundled code, verify output files exist in the correct directory
- [ ] Check that TypeScript files transpile without errors (Bun will report transpilation issues)
- [ ] For production builds, verify minification and sourcemaps are generated if needed

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt — Full page-by-page listing for agent navigation
- **Runtime documentation**: https://bun.com/docs/runtime — Core APIs, file I/O, networking, HTTP server
- **Package manager**: https://bun.com/docs/pm/cli/install — Install, add, remove, workspaces, configuration
- **Bundler**: https://bun.com/docs/bundler — Build options, plugins, code splitting, executables

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt
