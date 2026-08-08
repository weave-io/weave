# Testing

How tests are structured in Weave: what must change when a schema changes, and what must be mocked when a module crosses a boundary.

**Related:** [TypeScript Conventions](typescript.md) · [Adapter Boundary](../architecture/adapter-boundary.md) · [DSL Reference](../reference/dsl.md)

Run the suite with `bun test` from the repo root.

---

## Schema evolution: schema change = test change, same commit

Zod schemas are the source of truth for config validation. Every schema change — adding a field, removing a field, narrowing a type, adding a `.refine()`, changing a discriminated-union variant — must land with its test updates in the same commit.

| Change type | Required test update |
| --- | --- |
| New field added | Accept valid value; reject invalid value |
| Field made required (`.optional()` removed) | Omit field → assert rejection with correct path |
| New `.refine()` or cross-field constraint | Valid case passes; violation rejected with a readable message |
| New enum variant | New variant accepted; existing variants still pass |
| New discriminated union variant | Valid input for each variant; invalid discriminant rejected |
| Field removed | Remove or update every test that referenced it |

A DSL change touches four layers, and each has its own test file in `packages/core/src/__tests__/`:

| Layer | Test file |
| --- | --- |
| Zod schemas (`schema.ts`) | `schema.test.ts` |
| Parser behaviour (`parser.ts`) | `parser.test.ts` |
| Validator / AST transform (`validate.ts`) | `validate.test.ts` |
| Full pipeline | `parse_config.test.ts` |

Add coverage at **all four levels**, not just the schema test. The end-to-end pipeline test is the regression guard that catches wiring errors a unit test cannot see.

---

## Module isolation: mock every boundary

When a module crosses a package or process boundary — a `HarnessAdapter`, file I/O, process spawning, network calls, or any interface owned by another package — test it against a mock. Never start a real harness, write real files, or spawn real processes in unit or integration tests.

Mocks live alongside the tests they support. Write a `Mock*` class or inline stub that satisfies the minimum interface surface for the test at hand. A mock adapter should demonstrate the adapter boundary, not imply that engine code discovers harness resources itself.

```ts
// ✅ — mock adapter; no real harness, no file I/O
class MockAdapter implements HarnessAdapter {
  readonly calls: string[] = [];
  async init(): Promise<void> {}
  async spawnSubagent(name: string, config: AgentConfig): Promise<void> {
    this.calls.push(name);
  }
}

// ❌ — needs a live OpenCode process
const adapter = new OpenCodeAdapter();
```

What to mock at each layer:

| Module under test | What to mock |
| --- | --- |
| Engine composition APIs | `HarnessAdapter` and harness-supplied context — pass fixture data, prefer pure-function tests |
| `HarnessAdapter` implementations | File system (`Bun.file` → string fixtures), process (`Bun.spawn` → stub with controlled output) |
| Config loader (`@weaveio/weave-config`) | Pass source strings directly; stub `Bun.file()` reads with known content |
| Any code calling external services | Replace the client with a minimal in-memory stub |

`packages/engine/src/__tests__/mock-adapter.ts` is the shared engine-side mock adapter — reuse it rather than hand-rolling another one.

**Every critical module needs at least one isolated test file** with all external dependencies replaced by mocks. Critical means: anything in `packages/engine/`, any `HarnessAdapter` implementation, and any module that owns state or coordinates multiple components.
