# Spike: tool detail, starting agent, and local plugin in the OpenCode sandbox

**Plan**: `.weave/plans/verification-feedback-loops.md`, task 7 · **Date**: 2026-09-12 · **Image**: `weave-sandbox-opencode-default` (OpenCode 1.18.27, Bun 1.4.2)

This spike answers three questions the verification-aware trajectory evals depend on, plus one problem it found along the way. Every run used the existing sandbox image directly with `podman run --entrypoint opencode`, a scratch workspace outside the repository, and `OPENROUTER_API_KEY` forwarded by name only.

## Summary

| Question | Answer | Evidence |
| --- | --- | --- |
| 1. Can we see a bash call's command and exit status? | **Yes, via OpenCode plugin hooks (Channel B).** The Channel A DEBUG log carries the command but no exit status. `--format json` carries both, but only for the primary session. | Captures 1, 4, 5 |
| 2. Can a session start on a named agent? | **Yes**: `opencode run --agent <name>`. | `opencode run --help` |
| 3. Can the sandbox load the working-tree Weave plugin? | **Yes, without a new image**: bundle `packages/adapters/opencode/src/plugin.ts` with `bun build` and place it in `/workspace/.opencode/plugin/`, with no npm plugin in `opencode.jsonc`. | Capture 6 |
| Found: sub-agent delegation fails in the sandbox | Builtin agents declare `models ["claude-sonnet-4-5"]`, which OpenCode cannot resolve under OpenRouter, so the `task` tool errors. A config override that pins sub-agents to an OpenRouter id fixes it. | Captures 3, 4 |

## Question 1: command text and exit status

**Channel A (DEBUG log).** The permission check logs the command in `pattern=`, for every session including sub-agents, but no line reports completion or exit status (capture 4):

```text
message=evaluated permission=bash pattern="bun test"
```

**`--format json` (stdout).** Each tool call is one structured event with the command and exit status (capture 1, a deliberately failing test):

```json
{"type":"tool_use","sessionID":"ses_f684…","part":{"tool":"bash","state":{"status":"completed","input":{"command":"bun test"},"metadata":{"exit":1,"output":"bun test v1.4.2 (744846f84)\n\nsum.test.ts:\n1 | import { expec…"}}}}
```

However, the stream carries only the **primary** session's parts. In capture 4, Loom delegated to Shuttle, and `events.jsonl` held 7 lines: Loom's text and a single `task` tool call. Shuttle's `glob`, `read`, `edit`, and `bash` calls appeared only in the DEBUG log. That rules it out for Loom → Shuttle and Tapestry → Shuttle cases.

**Channel B (plugin hooks).** A project-local plugin file at `/workspace/.opencode/plugin/observer.ts` is auto-loaded, and its `tool.execute.before` / `tool.execute.after` hooks fire for **every** session, including sub-agents. The pair shares a `callID`. `before` carries the arguments, and `after` carries `metadata.exit` (capture 5, Shuttle's child session):

```json
{"hook":"before","input":{"tool":"bash","sessionID":"ses_f684…","callID":"toolu_bd…"},"args":{"command":"bun test sum.test.ts","workdir":"/workspace"}}
{"hook":"after","input":{"tool":"bash","sessionID":"ses_f684…","callID":"toolu_bd…"},"exit":0,"metadataKeys":["output","exit","truncated"]}
```

**Recommendation: hybrid.** Keep the Channel A log parser for sessions and spawns (it already maps sessions to agent names). Add an adapter-owned observer plugin, written into the workspace by the runner, that appends one JSON line per `tool.execute.after` to `/artifacts`, including the tool, `sessionID`, `callID`, the shell command, and the exit code. The runner joins the two on `sessionID` to emit `tool-call-before` / `tool-call-after` events with `detail`. The observer is independent of the Weave plugin, so it works with both the npm-pinned and the working-tree plugin.

## Question 2: starting agent

`opencode run --help` in the image lists `--agent  agent to use [string]`. The entrypoint can pass `--agent <name>` when the case sets a starting agent. That's how a case starts on Tapestry instead of Loom.

Only **primary** agents work. With `--agent shuttle`, OpenCode printed `agent "shuttle" is a subagent, not a primary agent. Falling back to default agent`, and the session ran on Loom (capture 7). A case that exercises Shuttle therefore starts on Loom and asks for delegation explicitly; capture 4 showed Loom follows "Delegate this to the shuttle agent: …".

## Question 3: working-tree plugin

The entrypoint writes `/workspace/opencode.jsonc` only if it is absent, and the npm pin (`WEAVE_ADAPTER_OPENCODE_VERSION=0.1.2`) only applies to the config it writes. Builtin prompts are imported as text and embedded at bundle time (`packages/config/src/builtins.ts`), so a bundle carries the working tree's prompts.

```sh
bun build packages/adapters/opencode/src/plugin.ts --target=bun --format=esm --outfile <workspace>/.opencode/plugin/weave.js
# <workspace>/opencode.jsonc: { "permission": "allow" }   (no "plugin" entry)
```

In capture 6 the bundle (0.45 MB, exports `WeavePlugin`, `createWeavePlugin`, `server`, `default`) loaded from `.opencode/plugin/weave.js`. The log shows `agent=loom mode=primary`, then a child session with `agent=shuttle mode=subagent`. Without any Weave plugin there is no Loom agent, so the bundle is what loaded. No new image is needed: the `opencode-local` profile can use the existing image, with the runner writing the bundle and a plugin-less `opencode.jsonc`.

## Found: sub-agent model resolution breaks delegation in the sandbox

With builtin agents and the npm plugin, Loom's `task` call to Shuttle failed (capture 3):

```text
Model not found: claude-sonnet-4-5/.
```

The builtin DSL declares `models ["claude-sonnet-4-5"]`. OpenCode reads that as provider `claude-sonnet-4-5` with an empty model id. The existing trajectory case still counts a spawn, because the log parser treats the child session's `message=created` line as `subagent-spawned`, and that line is logged before the failure. So a passing routing case does not mean the sub-agent ran.

Adding this to the fixture's `.weave/config.weave` made delegation succeed (capture 4):

```text
agent shuttle {
  models ["openrouter/anthropic/claude-sonnet-4.5"]
}
```

For eval fixtures, the runner should write a per-run override that pins every builtin sub-agent to `openrouter/<model under test>`, so sub-agents run the same model as the primary agent. Whether the adapter should resolve bare model ids itself is a product question for a separate change.

## Observations for the baseline (anecdotal, one run each)

- Capture 2: Loom fixed `sum.ts` itself (single-step work) and **did not run the tests** afterwards.
- Captures 4-6: Shuttle on Claude Sonnet 4.5, with both the npm and working-tree prompts, looked for tests after its edit and ran `bun test` (exit 0).

## Reproducing

The scripts and workspaces are session scratch, not committed. To reproduce: create a Bun project with a failing test, add `opencode.jsonc` with `"permission": "allow"`, and run:

```sh
podman run --rm -e OPENROUTER_API_KEY -v "$ws":/workspace:Z -v "$out":/artifacts:Z \
  --entrypoint opencode weave-sandbox-opencode-default \
  run --format json --print-logs --log-level DEBUG --model openrouter/<model> "<prompt>" \
  >"$out/events.jsonl" 2>"$out/stderr.log"
```

For captures 5-6, add `.opencode/plugin/observer.ts` exporting a plugin whose `tool.execute.before` / `tool.execute.after` hooks append their `input` and `output` to `/artifacts/hooks.jsonl`.
