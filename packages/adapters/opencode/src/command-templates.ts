/**
 * Command templates for OpenCode slash commands.
 *
 * These templates remain available to legacy library consumers. The OpenCode
 * 2 server plugin registers only `/weave:start` through its native command
 * callback and does not use these prompt templates.
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

const EXECUTION_INSTRUCTIONS = `You are being activated to execute one explicitly selected Weave plan in the foreground.

## Your Mission
Read the selected plan and follow its tasks. Use the harness's native subagent
tool when delegation is appropriate. Follow the Tapestry role instructions for
coordination, verification, and progress reporting.

## Startup Procedure

1. Require one explicit plan name from the command invocation.
2. Read only \`.weave/plans/<plan-name>.md\` for that selection.
3. Start from the first task that is in progress, or the first pending task.
4. Treat the selected-plan record as display metadata, not workflow state or automatic-resume authority.

## Execution Loop

For each executable task, read its description, files, dependencies, pitfalls,
and acceptance criteria. Delegate or implement it according to the Tapestry
role. Verify the result before moving to the next task.

## Rules

- Work through tasks **top to bottom** unless dependencies require a different order
- Do not read or create \`.weave/state.json\`.
- Do not claim that selecting a plan created, resumed, or advanced a durable workflow.
- Do not infer exactly-once execution from a command retry.
- Keep foreground work in the invoking session and leave background result delivery to the native harness.
- Stop when the role instructions, user direction, or a real blocker require it.`;

// ---------------------------------------------------------------------------
// Exported command templates
// ---------------------------------------------------------------------------

/**
 * Template for the `/start-work` slash command (legacy name).
 *
 * This is a legacy library template. The V2 plugin does not register the alias.
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
 * This is a legacy library template. The V2 plugin uses a native callback.
 */
export const WEAVE_START_COMMAND_TEMPLATE = `<command-instruction>
${EXECUTION_INSTRUCTIONS}
</command-instruction>
${renderCommandEnvelope("weave:start")}
<session-context>Session ID: $SESSION_ID  Timestamp: $TIMESTAMP</session-context>
<user-request>$ARGUMENTS</user-request>`;
