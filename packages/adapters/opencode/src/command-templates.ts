/**
 * Command templates for OpenCode slash commands.
 *
 * These templates are injected into the conversation when the user types
 * `/start-work` or `/weave:start` in the OpenCode TUI. They instruct the
 * Tapestry agent to execute a Weave plan.
 *
 * ## How OpenCode commands work
 *
 * OpenCode commands are prompt-based — when a user types `/start-work my-plan`,
 * OpenCode replaces `$ARGUMENTS` with `my-plan` and sends the template as a
 * user message to the configured agent. This is NOT programmatic execution;
 * it's prompt injection that instructs the agent to act.
 *
 * ## Placeholders
 *
 * - `$ARGUMENTS` — the text after the command name (e.g. plan name)
 * - `$SESSION_ID` — OpenCode session identifier
 * - `$TIMESTAMP` — ISO-8601 timestamp of command invocation
 *
 * @see https://opencode.ai/docs/commands/ — OpenCode commands documentation
 * @see docs/adapter-bootstrap.md — Command Surface Registration section
 */

import { logger } from "@weave/engine";

const log = logger.child({ module: "command-templates" });

// ---------------------------------------------------------------------------
// Protocol envelope — structured metadata for command parsing
// ---------------------------------------------------------------------------

/**
 * Render the Weave command envelope XML block.
 *
 * The envelope provides structured metadata that downstream hooks or agents
 * can parse to understand the command context without relying on prompt text
 * parsing alone.
 */
function renderCommandEnvelope(commandName: string): string {
  return `<weave-command-envelope>
<protocol-version>1</protocol-version>
<command-name>${commandName}</command-name>
<arguments>$ARGUMENTS</arguments>
<session-id>$SESSION_ID</session-id>
<timestamp>$TIMESTAMP</timestamp>
</weave-command-envelope>`;
}

// ---------------------------------------------------------------------------
// Shared execution instructions (Tapestry agent prompt)
// ---------------------------------------------------------------------------

const EXECUTION_INSTRUCTIONS = `You are being activated by the /start-work command to execute a Weave plan.

## Your Mission
Read the plan and execute it by delegating each unchecked task to Shuttle via the Task tool.
You do NOT implement work directly — you coordinate, delegate, verify, and track progress.

Execution is non-terminal while any \`- [ ]\` task remains.
Do not stop, ask what to do next, or wait for acknowledgment while unchecked tasks remain.

## Startup Procedure

1. **Check for active work state**: Read \`.weave/state.json\` to see if there's a plan already in progress.
2. **If resuming**: The system has injected context below with the active plan path and progress. Read the plan file, find the first unchecked \`- [ ]\` task, and continue from there.
3. **If starting fresh**: The system has selected a plan and created work state. Read the plan file and begin from the first unchecked task.

## Execution Loop

For each unchecked \`- [ ]\` task in the plan:

1. **Read** the task description, acceptance criteria, and any references
2. **Delegate** the task to Shuttle via the Task tool using this prompt format:
   \`\`\`
   Task [N/M]: [Task Title]
   **What**: [full task description from plan]
   **Files**: [file paths from plan]
   **Acceptance**: [acceptance criteria from plan]
   **Context from completed tasks**: [any output or decisions from prior tasks that affect this one]
   **Learnings**: [relevant entries from .weave/learnings/{plan-name}.md if the file exists]
   \`\`\`
3. **Verify** Shuttle's result — re-read modified files, check acceptance criteria are met
4. **Mark complete** — use the Edit tool to change \`- [ ]\` to \`- [x]\` in the plan file
5. **Report progress** — "Completed task N/M: [title]"
6. **Continue immediately** — find the next unchecked task and delegate it without waiting for user acknowledgment

## Rules

- Work through tasks **top to bottom** unless dependencies require a different order
- **Delegate every task to Shuttle** — do not implement work directly yourself
- **Verify every task** before marking it complete; if verification fails, re-delegate to Shuttle with the failure details
- A progress update is **not** a stopping point
- Do **not** ask the user what to do next while unchecked tasks remain
- Do **not** mention terminal validation, review, reviewers, final summary, completion, or post-execution steps while unchecked tasks remain
- If asked what to do now while unchecked tasks remain, answer with only the immediate next delegation action
- Keep mid-plan responses to one sentence or one short bullet
- If the current task is blocked, document the reason and move to the next unchecked task that is not blocked
- Stop only when:
  1. all checkboxes are checked, or
  2. the user explicitly tells you to stop, or
  3. every remaining unchecked task is truly blocked
- When all tasks are complete, switch to terminal-state behavior`;

// ---------------------------------------------------------------------------
// Exported command templates
// ---------------------------------------------------------------------------

/**
 * Template for the `/start-work` slash command (legacy name).
 *
 * Registered as `cfg.command["start-work"]` in the plugin config hook.
 * When invoked, OpenCode sends this template to the Tapestry agent.
 */
export const START_WORK_COMMAND_TEMPLATE = `<command-instruction>
${EXECUTION_INSTRUCTIONS}
</command-instruction>
${renderCommandEnvelope("start-work")}
<session-context>Session ID: $SESSION_ID  Timestamp: $TIMESTAMP</session-context>
<user-request>$ARGUMENTS</user-request>`;

/**
 * Template for the `/weave:start` slash command (preferred name).
 *
 * Registered as `cfg.command["weave:start"]` in the plugin config hook.
 * When invoked, OpenCode sends this template to the Tapestry agent.
 */
export const WEAVE_START_COMMAND_TEMPLATE = `<command-instruction>
${EXECUTION_INSTRUCTIONS}
</command-instruction>
${renderCommandEnvelope("weave:start")}
<session-context>Session ID: $SESSION_ID  Timestamp: $TIMESTAMP</session-context>
<user-request>$ARGUMENTS</user-request>`;
