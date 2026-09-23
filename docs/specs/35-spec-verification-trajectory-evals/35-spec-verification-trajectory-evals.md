# 35-spec-verification-trajectory-evals.md

**Related**: [Specs Index](../README.md) · [ADR 0012: Verification-Aware Trajectory Evals](../../adr/0012-verification-aware-trajectory-evals.md) · [ADR 0008: Harness Trajectory Evals](../../adr/0008-harness-trajectory-evals.md) · [Spec 33: Harness Trajectory Evals](../33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md) · [Adapter Boundary](../../adapter-boundary.md) · [Agent Evals](../../agent-evals.md) · [Spike](../../artifacts/verification-trajectory-spike.md)

---

## Overview

Spec 33 defines trajectory evals that observe which agents spawned and which tools were called. This spec extends that contract so a trajectory case can check that an agent **verified its work**: it ran a named command after its last edit, the command succeeded, and an independent verifier confirms the result. Every addition is optional. A case that uses none of it behaves exactly as under Spec 33.

The decisions behind this spec are recorded in ADR 0012. This document is the normative contract.

---

## Case schema additions (`expected_outcome.kind: "harness_trajectory"`)

All fields are optional. They are added to the `harness_trajectory` member of `ExpectedOutcomeSchema` in `packages/cli/src/evals/types.ts`.

```ts
z.object({
  kind: z.literal("harness_trajectory"),
  expected_spawns: z.array(z.string()),
  expected_tools: z.array(z.string()),
  max_duration_seconds: z.number().positive().max(600),
  sandbox_profile: z.string(),

  /** Directory name under evals/fixtures/ copied into /workspace before the
   *  session. A single path segment: no "/", no "..". */
  fixture: FixtureNameSchema.optional(),

  /** Agent the session starts on (`opencode run --agent <name>`). */
  start_agent: IdentifierSchema.optional(),

  /** Commands the agent must run. Each entry is satisfied by one observed
   *  shell tool call whose command contains `contains`. */
  expected_commands: z
    .array(
      z.object({
        contains: z.string().min(1).max(200),
        after_last_edit: z.boolean().default(false),
        expect_success: z.boolean().default(false),
      }).strict(),
    )
    .optional(),

  /** Independent check run after the session in a second container. */
  verifier: z
    .object({
      fixture: FixtureNameSchema,
      command: z.string().min(1).max(500),
      expect: z.enum(["pass", "fail"]),
    })
    .strict()
    .optional(),
})
```

Rules:

- `fixture` and `verifier.fixture` name directories under `evals/fixtures/`. The CLI resolves them to absolute paths and fails the case before execution if either directory is missing.
- A `verifier` requires a `fixture`: there is nothing to verify in an empty workspace.
- `start_agent` must be a known agent name (`KNOWN_AGENTS` in `case-loader.ts`) that runs in primary mode (`loom` or `tapestry` for the builtins). OpenCode silently falls back to its default agent when `--agent` names a sub-agent (see the spike), so the loader rejects `start_agent` values for builtin sub-agents rather than letting a case measure the wrong agent.
- Fixture directories contain only synthetic project files. They must never contain secrets, and the same raw-artifact and sanitizer rules apply to anything a run produces from them.

### Runtime behaviour checks (Spec 37, task 20.1)

[Spec 37](../37-spec-repository-foundation/37-spec-repository-foundation.md) (G11) adds trajectory cases for runtime problems found in the [September 2026 session audit](../../artifacts/session-audit-2026-09.md). The checks they need are added here, one optional field at a time, and only when the existing fields could not express them. They follow this spec's rules: deterministic, computed from the local-only event stream, and not published.

```ts
  /** Sub-agents the session may delegate to. */
  allowed_delegates: z.array(IdentifierSchema).min(1).optional(),

  /** Fewest sub-agents that must run at the same time. */
  min_parallel_delegations: z.number().int().min(2).max(10).optional(),
```

- `allowed_delegates` (delegation accuracy). `expected_spawns` checks an exact ordered sequence, but under the Spec 33 pass rule a matching sequence passes the case even when the spawned agent then failed, and a case with a verifier passes when the primary agent did the work itself. This field states the actual promise: the session delegated, it delegated only to these agents (so not to a harness built-in such as `explore` or `general`, and not to an agent that does not exist), and the delegated agent did the work.
- `min_parallel_delegations` (parallel execution). Nothing in the Spec 33 or Spec 35 fields says *when* a sub-agent ran, so "dispatched in the same step" could not be checked. The events already carry it: a sub-agent session starts at its `subagent-spawned` event and ends at its `session-completed` event. A parent that dispatches tasks one after another waits for each to return before its next step, so its sub-agents never overlap; tasks dispatched in one step do. Overlap is therefore the observable form of "two task calls in one step", and it needs no adapter change.

---

## `TrajectoryCase` projection additions

`TrajectoryCase` (`packages/core/src/trajectory-events.ts`) is the engine/adapter-owned projection the CLI hands to an adapter's `TrajectoryRunner`. It gains:

```ts
interface TrajectoryCase {
  // ...Spec 33 fields...
  /** Absolute path of the fixture to copy into the workspace. */
  fixturePath?: string;
  /** Agent to start the session on. */
  startAgent?: string;
  /** Verifier to run after the session. */
  verifier?: { fixturePath: string; command: string };
}
```

`expected_commands` and `verifier.expect` stay in the CLI; adapters do not score.

---

## Event and result additions

`ToolCallBeforeEventSchema` and `ToolCallAfterEventSchema` gain one optional field:

```ts
detail: z
  .object({
    /** Shell command text, secret-redacted, at most 500 characters. */
    command: z.string().max(500).optional(),
    /** Process exit code of a shell tool call (after events only). */
    exitCode: z.number().int().optional(),
    /** Workspace path a file tool changed, at most 500 characters. */
    path: z.string().max(500).optional(),
  })
  .strict()
  .optional(),
```

`TrajectoryResultSchema` gains one optional internal field:

```ts
verifier: z.object({ passed: z.boolean() }).strict().optional(),
```

Both are **local-only**. `detail` and `verifier` never appear in `TrajectorySummary`, `CaseResultSummary`, or any public schema (Spec 31). A publishable schema that receives either is rejected, not stripped.

---

## Runner behaviour (OpenCode adapter)

For each run the OpenCode `TrajectoryRunner`:

1. **Prepares the workspace.** Writes `prompt.txt`. If `fixturePath` is set, copies the fixture into the workspace root.
2. **Installs the observer.** Writes the adapter-owned observer plugin to `/workspace/.opencode/plugin/weave-trajectory-observer.ts`. For every `tool.execute.after` hook it appends one line to `/artifacts/tool-calls.jsonl`:
   ```json
   {"sessionID":"ses_…","callID":"toolu_…","tool":"bash","command":"bun test","exitCode":0,"timestamp":"2026-09-12T22:21:44.000Z"}
   ```
   `command` and `exitCode` are present only for shell tools (`bash`); other tools can carry a `command` argument (the `task` tool's is a delegation prompt), which must never read as a command that ran. File tools (`edit`, `write`, `patch`, `multiedit`, `apply_patch`) record the changed `path`; `apply_patch` carries it in the patch text's `*** Update File:` header.
3. **Chooses the config source.** Without a fixture: mounts the repository's `.weave/config.weave` and `.weave/prompts/` read-only, exactly as today, and nothing else. With a fixture: mounts neither, because the fixture's `.weave/` is the project config, and instead mounts a generated global config at `/root/.weave/config.weave` (read-only) that pins every builtin sub-agent's `models` to `["openrouter/<model under test>"]`. Config merge puts these entries ahead of the builtin `claude-sonnet-4-5`, and the fixture's project config can still override them. (An override appended to the project file would not work: a second `agent` block in one file replaces the first.)
4. **Chooses the plugin.** `opencode-default`: the entrypoint writes `opencode.jsonc` with the pinned npm plugin, as today. `opencode-local`: the runner writes the working-tree bundle to `/workspace/.opencode/plugin/weave.js` and an `opencode.jsonc` with `"permission": "allow"` and no `plugin` entry. `opencode-local` without a bundle path fails with `SandboxStartFailed`.
5. **Runs the session.** Passes `WEAVE_TRAJECTORY_START_AGENT` to the entrypoint when `startAgent` is set; the entrypoint adds `--agent <name>`.
6. **Builds events.** Parses the DEBUG log as today (sessions, spawns, `tool-call-before`). Joins `tool-calls.jsonl` lines to sessions by `sessionID` and emits a `tool-call-after` per line, with `agentName` from the session map and `detail` from the line. When the observer file is missing or unreadable, the runner emits no `tool-call-after` events and logs a warning; the run is not failed.
7. **Runs the verifier.** If `verifier` is set, runs a second `podman run` with the same workspace mounted at `/workspace`, the verifier fixture mounted read-only at `/verifier`, no model API key, and `sh -c "<command>"` with `cwd=/workspace`. Exit 0 means `passed: true`. The agent's container never mounts `/verifier`. The verifier gets the time left in `max_duration_seconds`, but never less than 30 seconds; a verifier timeout or a failure to start yields `passed: false`.

The engine never sees the observer file, the fixture, or the verifier. It consumes only the normalized `TrajectoryEvent[]` and the optional `verifier` result (adapter boundary rules unchanged).

---

## Scoring

`scoreTrajectoryCase` (`packages/cli/src/evals/trajectory-scoring.ts`) computes `executionCompleteness` as the fraction of satisfied checks:

- each `expected_tools` entry: at least one `tool-call-before` or `tool-call-after` with that `toolName` (unchanged);
- each `expected_commands` entry: at least one `tool-call-after` whose `detail.command` contains `contains`, and
  - if `after_last_edit`, whose timestamp is later than the last code edit (vacuously true when there is none). Code edits are completed `edit`, `write`, `patch`, `multiedit`, or `apply_patch` calls whose `detail.path` is not under `.weave/`; edits there are plan and learnings bookkeeping (Tapestry ticking a plan's checkboxes), not code. A stream with no completed edit events falls back to the permission-check `tool-call-before` events, and
  - if `expect_success`, whose `detail.exitCode` is `0`.

  One event must satisfy every condition of its entry;
- `verifier`: `result.verifier.passed` matches `expect === "pass"`. A missing verifier result counts as unsatisfied.
- `allowed_delegates`: one check. It is satisfied when at least one `subagent-spawned` event was observed, every one names an agent in the list, and at least one code edit (defined as for `after_last_edit`) has an `agentName` that is both in the list and among the spawned sub-agents. An agent's name on an edit comes from the observer record's session, joined to the session's spawn event.
- `min_parallel_delegations`: one check. Each `subagent-spawned` event whose child is named in `expected_spawns` (every child, when `expected_spawns` is empty) opens an interval that the first later `session-completed` or `session-errored` event with the same `sessionId` closes; an interval with no such event stays open to the end of the stream. Counting only the expected delegates keeps two unrelated sub-agents (two `explore` sessions, say) from satisfying it. At equal times a close counts before an open. The check is satisfied when the most intervals open at once is at least the given number.

A case with none of the new fields scores exactly as under Spec 33. The weighted total and the other dimensions are unchanged.

**Verification gates the pass.** Under Spec 33 a case passes when *any* primary dimension scores at least 0.95, so correct routing alone can pass a case whose required tool never ran. A case that declares `expected_commands`, a `verifier`, `allowed_delegates` or `min_parallel_delegations` additionally requires `executionCompleteness` of at least 0.95. Cases without these fields keep the Spec 33 rule.

---

## Suite registry

`shuttle-execution` and `tapestry-execution` add `"harness_trajectory"` to `allowedExpectedOutcomeKinds`. Other suites are unchanged. Trajectory execution is shared by the loom, shuttle, and tapestry runners through one module instead of living in `loom-routing-runner.ts`.

---

## Acceptance criteria

1. The case schema accepts every field above, rejects unknown keys, rejects a `verifier` without a `fixture`, and rejects fixture names containing `/` or `..`.
2. The existing `loom-route-shuttle-implement-utility-trajectory` case loads and scores unchanged.
3. `TrajectorySummarySchema` is unchanged, and a public schema receiving `detail` or `verifier` rejects it.
4. A fixture run mounts no repository `.weave/` path and mounts the sub-agent model overlay; a non-fixture run's mounts are unchanged.
5. The first container never mounts `/verifier`; the second always does.
6. Command text in `detail` is redacted and bounded.
7. Scoring covers: command before the last edit, a failing command, a verifier mismatch, a case with no new fields, and a case whose routing passes but whose verification fails (it must fail).

---

## Related files

| File | Role |
| --- | --- |
| `packages/core/src/trajectory-events.ts` | `detail` on tool events, `verifier` on `TrajectoryResult`, `TrajectoryCase` additions |
| `packages/cli/src/evals/types.ts` | Case schema fields and registry opt-in |
| `packages/cli/src/evals/case-loader.ts` | Fixture resolution and validation |
| `packages/cli/src/evals/trajectory-scoring.ts` | Command and verifier scoring |
| `packages/cli/src/evals/trajectory-case-executor.ts` | Shared trajectory execution for the loom, shuttle, and tapestry runners |
| `packages/adapters/opencode/src/trajectory/opencode-trajectory-runner.ts` | Workspace, observer, mounts, plugin profile, verifier |
| `packages/adapters/opencode/src/trajectory/log-parser.ts` | Channel-A parsing and the observer join |
| `sandboxes/opencode/entrypoint.ts` | `--agent` and plugin-less config for `opencode-local` |
| `evals/fixtures/` | Fixture projects and verifiers |
