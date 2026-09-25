# Session audit (L5)

`opencode-sessions.ts` reads an OpenCode session store and prints the WS1
delegation scorecard from [Spec 38](../../docs/specs/38-spec-delegation-accuracy/38-spec-delegation-accuracy.md#metrics):
how often Loom and Tapestry delegate, how often a delegation fails for a
configuration reason, whether category shuttles are used and succeed, whether
harness built-in agents are used, whether failures are recovered, and whether
Loom takes plan tasks during an active plan.

It is layer L5 of Spec 38's test layers: the check on real sessions for
anything the contract tests, eval cases and live proof miss.

## Usage

```bash
# OpenCode V1, the last 7 days, Markdown
bun scripts/audit/opencode-sessions.ts

# The September 2026 audit window, as JSON
bun scripts/audit/opencode-sessions.ts --since 2026-09-04 --until 2026-09-18 --format json

# OpenCode V2, one project
bun scripts/audit/opencode-sessions.ts --harness opencode2 --project ~/source/weave
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--harness opencode\|opencode2` | `opencode` | Which store schema to read. |
| `--db <path>` | V1: `~/.local/share/opencode/opencode.db`; V2: `~/.weave/harnesses/opencode2/data/opencode.db` | The SQLite store. The V2 default is where the V2 host managed by Weave Fleet keeps it; a V2 host started elsewhere keeps it in its own data directory. |
| `--since <date>` | 7 days before `--until` | Sessions created at or after this time. `YYYY-MM-DD` is midnight UTC. |
| `--until <date>` | now | Sessions created before this time. A date-only value includes that whole day. |
| `--project <dir>` | all | Only sessions whose directory is `<dir>` or below it. |
| `--format md\|json` | `md` | Markdown table or JSON. |

Sessions under `/tmp/` (automated test runs) are always excluded. Logs go to
stderr; set `LOG_LEVEL=info` to see the config loader's messages.

## Metrics

The definitions are Spec 37's
[metric definitions](../../docs/specs/37-spec-repository-foundation/37-tasks-repository-foundation.md#metric-definitions-for-the-session-audit-script)
plus Spec 38's category-shuttle share and recovered failures. Each metric is
one function in [`delegation-metrics.ts`](delegation-metrics.ts). The script
header in [`opencode-sessions.ts`](opencode-sessions.ts) lists where the
script narrows a definition and why (user aborts are not configuration
failures; recovery needs a completed resend in the same user turn or the
next, and recovered failures are divided by every failed delegation with
transient and configuration failures also shown on their own; plan-task
delegation counts Loom only after the plan command).

| Store | Schema | A delegation is |
| --- | --- | --- |
| OpenCode V1 | `session`, `message`, `part` | a `part` with `type = 'tool'`, `tool = 'task'`; target `state.input.subagent_type` |
| OpenCode V2 (`@opencode/cli`) | `session_v2`, `session_message` | an item in an assistant message's `content` with `type = 'tool'`, `name = 'subagent'`; target `state.input.agent` |

The V2 reader follows the V2 message types (`SessionMessageAssistant`,
`SessionMessageAssistantTool` in `@opencode-ai/client`) and the `subagent`
call the adapter's live proof makes. When it was written (25 Sep 2026) the
only local V2 store held one session without delegations, so its delegation
path is proven by fixtures, not yet by real V2 sessions; the first week of V2
dogfooding (Spec 38 group 10) is its first real run.

Reading the stores is in [`session-store.ts`](session-store.ts); the tests in
`__tests__/` build tiny in-memory databases with each schema and run under
`bun run test:scripts`.

## Privacy

- The store is opened with `readonly: true` and never written. Do not copy it
  into the repository.
- Message text is only examined inside SQLite, to find the plan command. The
  readers return identifiers, directories, agent names and delegation error
  strings, and the scorecard prints aggregate counts only: no message text,
  prompts, titles, directories or error strings.
- Scorecards may go into PRs and `docs/artifacts/`; session content may not.
