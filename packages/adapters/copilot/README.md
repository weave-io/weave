# @weaveio/weave-adapter-copilot

The Weave adapter that materializes normalized `.weave` configuration as a
GitHub Copilot Agent Plugin bundle (Agent Plugins 1.0). It translates each
Weave `AgentDescriptor` into a `.agent.md` file (frontmatter + composed
prompt) and writes a schema-conformant `plugin.json` under
`<projectRoot>/.weave/plugins/copilot/`.

See [`docs/copilot-adapter.md`](../../../docs/copilot-adapter.md) for the
full status/context/decision/consequences writeup — including what is
supported natively, what is prompt-only (tool restriction is advisory, not
sandboxed), and what is unsupported in v1 (workflow persistence, event
logging, idle continuation, recovery, context monitoring, analytics) — and
[`docs/adapters/copilot.md`](../../../docs/adapters/copilot.md) for the
practical install guide (`--add-dir` trusted-directory activation).

## Install

```bash
bun add @weaveio/weave-adapter-copilot@latest
```

## Status

This adapter is scaffolded and under active development. It implements the
`HarnessAdapter` interface (`init()` → `spawnSubagent()` → `flush()`) with a
flush-based accumulate-then-write pattern. `weave compose --adapter copilot`
CLI wiring is not yet available — construct and drive `CopilotAdapter`
directly as a library until that follow-up lands.

Background research: [`docs/artifacts/copilot-adapter-research.md`](../../../docs/artifacts/copilot-adapter-research.md)
documents the CLI-verified evidence (GitHub Copilot CLI 1.0.83) this adapter
is built against.

## License

MIT
