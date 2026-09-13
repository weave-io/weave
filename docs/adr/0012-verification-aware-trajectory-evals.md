# ADR 0012: Verification-Aware Trajectory Evals

**Status**: Proposed (2026-09-12)
**Date**: 2026-09-12
**Related**: [ADR 0008: Harness Trajectory Evals](0008-harness-trajectory-evals.md) · [Spec 33: Harness Trajectory Evals](../specs/33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md) · [Spec 35: Verification Trajectory Evals](../specs/35-spec-verification-trajectory-evals/35-spec-verification-trajectory-evals.md) · [Spike: tool detail, starting agent, and local plugin](../artifacts/verification-trajectory-spike.md) · [Adapter Boundary](../adapter-boundary.md) · [Agent Evals](../agent-evals.md)

---

## Context

The builtin prompts are being changed so that agents build feedback loops: Pattern says how each acceptance criterion will be verified, Shuttle runs the check after editing, and Tapestry re-checks instead of trusting a report. Whether that works has to be measured by what the agent *did*, not by what its report says. The text-only suites cannot see actions, and the Phase 1 trajectory track (ADR 0008) cannot see enough of them:

- Tool events carry only a tool name. There is no command text and no exit status, so "ran `bun test` after the last edit, and it passed" is unobservable.
- The Channel-A log parser emits `tool-call-before` from permission checks and never emits `tool-call-after`. As a result the published `observedToolCalls` (a count of `tool-call-after` events) is always 0 on today's runs.
- The workspace contains only `prompt.txt`, so there is no project for an agent to test.
- The sandbox mounts this repository's `.weave/` config and loads the Weave plugin from npm (pinned at `0.1.2`), so working-tree prompt changes never reach a trajectory run.
- ADR 0008 deferred checking the produced code: "Case-shipped verifier scripts run against the sandbox are a plausible next ADR, not this one."

The [spike](../artifacts/verification-trajectory-spike.md) (OpenCode 1.18.27, 2026-09-12) found:

1. OpenCode's `tool.execute.before` / `tool.execute.after` plugin hooks fire for every session, sub-agents included, and carry the command and `metadata.exit`. A plugin file placed in `/workspace/.opencode/plugin/` is auto-loaded. The DEBUG log carries the command (`permission=bash pattern="bun test"`) but no exit status. `opencode run --format json` carries both, but only for the primary session.
2. `opencode run --agent <name>` starts a session on a named agent.
3. The working-tree plugin, bundled with `bun build` into one file and placed in `/workspace/.opencode/plugin/`, loads without any npm plugin entry. Builtin prompts are embedded at bundle time.
4. Sub-agent delegation fails in the sandbox: builtin agents declare `models ["claude-sonnet-4-5"]`, which OpenCode cannot resolve under OpenRouter (`Model not found: claude-sonnet-4-5/.`). The existing trajectory case still scores a spawn, because the child session is created before the failure. Pinning sub-agents to an OpenRouter model id fixes delegation.

---

## Decision

### (a) Tool detail through an adapter-owned observer plugin (hybrid channel)

The OpenCode trajectory runner writes a small observer plugin into `/workspace/.opencode/plugin/` for every run. The plugin appends one JSON line per `tool.execute.after` hook to a file under `/artifacts`, recording the tool, session id, call id, the shell command (for shell tools), and the exit code. The runner keeps the Channel-A log parser for sessions and spawns, which it already maps to agent names. It then joins observer lines to sessions by id and emits `tool-call-before` / `tool-call-after` events with an optional `detail: { command?, exitCode? }`.

- `detail` is **local-only**. It lives in the internal event stream and raw artifacts, never in `TrajectorySummary` or any publishable schema. Command text passes through `redactSecrets` and is truncated to a bounded length before it enters an event.
- The observer is independent of the Weave plugin, so it works with both the npm-pinned and the working-tree plugin.
- `tool-call-after` events now exist, so `observedToolCalls` reports real counts. Its definition is unchanged.

*Rejected: `--format json` alone.* It omits sub-agent tool calls, which is where Shuttle runs its checks. *Rejected: log parsing alone.* It has no exit status. *Rejected: emitting events from the Weave plugin itself.* That would put eval observation inside the product plugin and tie observation to whichever plugin version is loaded.

### (b) Case-shipped verifier scripts, run in a second container

A case may ship a verifier, a fixture directory plus a command, whose result is compared with an expected `pass` or `fail`. It runs after the agent session ends, in a **second** `podman run` against the same workspace, with the verifier fixture mounted read-only at a path the agent's container never had. That makes the verifier independent ground truth: the agent cannot read or edit it, and its result does not depend on the agent's report. This lifts ADR 0008's deferred non-goal for cases that opt in.

*Rejected: running the verifier inside the agent's container after `opencode` exits.* The verifier would have to be present in the image or workspace during the session, so the agent could read it.

### (c) Seeded fixture workspaces that own their config

A case may name a fixture directory under `evals/fixtures/`. The runner copies it into the workspace before the session. When a fixture is used, the repository's `.weave/config.weave` and `.weave/prompts/` are **not** mounted; the fixture's own `.weave/` is the project config. This way the eval measures builtin behaviour, not this repository's local overrides and category policies. When no fixture is set, today's behaviour is unchanged.

For fixture runs, the runner also mounts a generated **global** config at `/root/.weave/config.weave` that pins every builtin sub-agent to the model under test as an OpenRouter id. Sub-agents then run the same model as the primary agent and delegation resolves. It is global rather than appended to the fixture's config because a second `agent` block in one `.weave` file replaces the first. Project config deep-merges over global, so a fixture can still override a sub-agent deliberately.

### (d) Per-case starting agent

A case may name a starting agent. The entrypoint passes it as `opencode run --agent <name>`, so a case can start on Tapestry with a plan instead of going through Loom.

### (e) `opencode-local` sandbox profile

A new profile, `opencode-local`, uses the **same image** as `opencode-default`. For this profile the CLI builds the working-tree plugin once per run (`bun build packages/adapters/opencode/src/plugin.ts --target=bun`) and passes the bundle path to the adapter runner. The runner writes the bundle to `/workspace/.opencode/plugin/weave.js` and writes an `opencode.jsonc` with no npm plugin entry. `opencode-default` keeps the npm pin, for measuring what users actually install. The profile fails closed when no bundle path is supplied.

### (f) The publishable surface does not change

`TrajectorySummary` keeps exactly the four fields ADR 0008 approved. Command matching and verifier results feed `executionCompleteness` in the internal score record only. The resulting pass/fail and dimension scores are publishable exactly as they are today.

---

## Consequences

### Positive

- "Shuttle ran the tests after its edit and they passed" becomes an observed fact with a pass/fail signal, and the hidden verifier checks the code itself.
- Prompt changes can be measured before release, because `opencode-local` runs the working tree's prompts.
- Evals measure builtin agents in a clean project rather than this repository's local configuration.
- `observedToolCalls` becomes meaningful.

### Negative

- Two observation sources (log and observer) must be joined, and a change to OpenCode's hook payload could break the observer. The spike's capture of the payload shape is the reference; a unit fixture pins it.
- Each case with a verifier costs a second container start (seconds, no model calls).
- Fixture projects are more to maintain than one-line prompts.
- A bundle built from the working tree is not byte-identical to the published package. `opencode-local` measures prompts and behaviour, not packaging.

### Deferred

- Other adapters (Claude Code, opencode2, Copilot). Their trajectory runners can adopt the same case fields later.
- Whether the product adapter should resolve bare model ids such as `claude-sonnet-4-5` for OpenRouter users. That is a product change, not an eval change.
- Publishing verifier outcomes as their own public field. That needs a further ADR extending the closed field set.

---

## Alternatives considered

**Keep trajectory cases routing-only and rely on text-only cases for verification.** Rejected: text-only cases can only score what the agent *says* it verified, which is the self-grading problem this work exists to remove.

**Build a new sandbox image for local plugins.** Rejected after the spike: the existing image loads a bundled plugin from the workspace, so a second image would add maintenance for no capability.

**Score verification from the agent's final report.** Rejected: an agent that claims a pass it never observed would score as well as one that ran the check.
