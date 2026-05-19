# Task 1 Proof Artifacts — Safe Mustache Renderer Wrapper

## 1. Diff: `mustache` added to `packages/engine/package.json`

```diff
   "dependencies": {
     "@weave/core": "workspace:*",
+    "mustache": "^4.2.0",
     "neverthrow": "^8.2.0",
     "pino": "^9.6.0",
     "zod": "^4.4.3"
   },
   "devDependencies": {
+    "@types/mustache": "^4.2.6",
     "typescript": "^5.4.5"
   }
```

`@types/mustache` is added as a devDependency because the `mustache` package does not bundle TypeScript types.

## 2. Test Output: `bun run --filter '@weave/engine' test`

```
@weave/engine test:  396 pass
@weave/engine test:  0 fail
@weave/engine test:  1221 expect() calls
@weave/engine test: Ran 396 tests across 12 files. [123.00ms]
@weave/engine test: Exited with code 0
```

All 396 tests pass, including the 44 new tests in `template-renderer.test.ts`.

## 3. Code Review Notes: `packages/engine/src/template-renderer.ts`

### No filesystem, environment, process, helper, lambda, or partial-loading behavior

- ✅ No `Bun.file()`, `Bun.spawn()`, `fs.*`, or any file I/O
- ✅ No `process.env`, `Bun.env`, or environment variable access
- ✅ No `process.spawn()` or subprocess execution
- ✅ No Mustache helpers (lambdas) — explicitly rejected via `validateNoFunctionValues()`
- ✅ No partial loading — partials rejected with `UnsupportedFeature` error
- ✅ No delimiter changes — rejected with `UnsupportedFeature` error

### neverthrow Result types used throughout

- ✅ `renderTemplate()` returns `Result<string, RendererError>`
- ✅ `extractTemplatePaths()` returns `Result<string[], RendererError>`
- ✅ All internal helpers (`parseTemplate`, `validateTokens`, `validatePath`, `checkUnsafePath`, `rejectFunctionValues`, `checkUnresolvedTags`) return `Result<void, RendererError>`
- ✅ No `throw` for expected failures — only `try/catch` at the Mustache library boundary (framework boundary exception per AGENTS.md)

### Escaped literal preprocessing and restoration

- ✅ `\{{path}}` → placeholder → rendered → `{{path}}` (literal in output)
- ✅ `\{{{path}}}` → placeholder → rendered → `{{{path}}}` (literal in output)
- ✅ Preprocessing happens before parse/render; restoration happens after render but before unresolved-tag check
- ✅ Escaped literals do not trigger unknown-path errors

### Unsafe path rejection

- ✅ `__proto__`, `prototype`, `constructor`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toString`, `toLocaleString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` all rejected
- ✅ Rejection applies to any segment in a dotted path (e.g., `agent.__proto__`)
- ✅ Rejection happens before allowed-path check (unsafe paths are rejected even if in allowedPaths)

### Function/callable value rejection

- ✅ `validateNoFunctionValues()` recursively scans the entire context tree
- ✅ Functions at top level, nested in objects, and inside arrays are all rejected
- ✅ Rejection happens before rendering — Mustache lambdas never execute

### Post-render unresolved-tag check

- ✅ Checks rendered output (before placeholder restoration) for remaining `{{...}}` or `{{{...}}}` patterns
- ✅ Placeholders (`\x00WEAVE_ESCAPED_*\x00`) do not contain `{{` so they don't match
- ✅ Escaped literals restored after the check — they appear as `{{` in final output but were not present during the check

### Section-relative path validation

- ✅ Top-level tokens validated against `allowedPaths`
- ✅ Child tokens inside sections (`{{#agent}}{{name}}{{/agent}}`) validated only for unsafe paths (they are context-relative)
- ✅ `{{.}}` (current-item reference) always allowed in list contexts

### Unsupported feature rejection

- ✅ `{{> partial}}` → `UnsupportedFeature { feature: "partial" }`
- ✅ `{{= <% %> =}}` → `UnsupportedFeature { feature: "delimiter-change" }`

## 4. Test Coverage Summary

| Category | Tests |
|---|---|
| Supported tags (variable, section, inverted, comment, triple-brace, &) | 12 |
| Nested sections | 3 |
| `{{.}}` current-item reference | 2 |
| Escaped literals | 5 |
| Unknown paths | 5 |
| Unsafe paths | 6 |
| Function/callable values | 3 |
| Unsupported tags | 2 |
| Malformed syntax | 2 |
| Unresolved tags | 3 |
| `extractTemplatePaths` utility | 5 |
| Integration (complex template) | 2 |
| **Total new tests** | **50** |

(Note: 396 total tests across 12 files; 50 new renderer tests added.)
