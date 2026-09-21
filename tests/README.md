# Weave scenario tests

These are Weave's **black-box tests**. Each one describes something a user can
observe from outside Weave, and reaches Weave only through a seam a real caller
has. If a test here fails, a user-visible promise broke.

Tests that verify internal helpers, error unions, or the shape of a private
function belong next to their module in `packages/*/src/__tests__/`, not here.

## The three buckets

| Bucket | Directory | The black box | Input | Output asserted |
| --- | --- | --- | --- | --- |
| **DSL** | [`dsl/`](dsl/) | The `.weave` language | Config source text | The agents, categories and errors Weave resolves |
| **CLI** | [`cli/`](cli/) | The `weave` command | `argv` + a virtual filesystem | Exit code, stdout, stderr |
| **Adapters** | [`adapters/`](adapters/) | Weave end to end | Config source text | The harness files a user would find on disk |

The adapter bucket is the widest box: it starts at `.weave` source and ends at
generated harness configuration, so it covers the DSL, composition and
translation in one pass. Use it for promises that span the whole product; use
the narrower buckets when the promise belongs to one surface.

[`evals/`](evals/) is a fourth directory rather than a fourth surface: the
black box there is the **published eval bundle** — the run directory, the
dashboard index files, the rendered `public-report.md`, and the HTTP requests a
publish would make over an injected `fetch`. Eval results go in and the files a
reader or tryweave.io would receive come out. Its shared harness is
[`support/evals.ts`](support/evals.ts), and unlike the other buckets it writes
to a real temporary directory, because the bundle writer owns its own I/O.

## How a scenario is written

A scenario names a **situation**, and each `it` names **one promise Weave makes
in that situation**:

```ts
describe("a user turns off the shuttle agent entirely", () => {
  it("removes every category shuttle with it, so no orphaned routes remain", async () => {
```

Rules that keep this bucket honest:

- **Name the user, not the function.** `describe("…")` states the
  situation; `it(…)` states the guarantee and, where it is not obvious, why it
  matters. A name that only repeats the function under test belongs in a unit
  test.
- **Enter through a public seam.** `parseConfig`, `materializeAgents`, `run()`,
  an adapter constructor. Never import a module that a user could not reach.
- **Assert what the user sees.** Generated file contents, printed output, exit
  codes — not intermediate descriptors. A refactor that preserves behaviour must
  not touch these tests.
- **Stay hermetic.** No real filesystem, `$HOME`, network or spawned process.
  Inject `MemoryFileSystem` or the adapter's I/O hooks. A scenario must give the
  same result on every machine, whatever the developer's own `~/.weave` holds.
- **One config per scenario, reused across its assertions.** The config is the
  scenario; splitting it across `it` blocks hides what is being tested.

Shared `Given/When/Then` helpers live in [`support/scenario.ts`](support/scenario.ts).

## Running them

```bash
bun test ./tests           # all scenarios
bun test ./tests/dsl       # one bucket
bun run test               # full suite, scenarios included
```
