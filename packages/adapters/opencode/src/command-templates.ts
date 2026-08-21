/**
 * Command templates for OpenCode prompt-based slash commands.
 *
 * These are the only command templates registered by the OpenCode plugin.
 * They are injected into the conversation when the user types `/start-work`
 * or `/weave:start` in the OpenCode TUI. They instruct the Tapestry agent to
 * execute a plan only after the user supplies and the agent verifies one.
 *
 * ## How OpenCode commands work
 *
 * OpenCode commands are prompt-based — when a user types `/start-work my-plan`,
 * OpenCode replaces `$ARGUMENTS` with `my-plan` and sends the template as a
 * user message to the configured agent. This is NOT programmatic execution;
 * it is prompt injection that instructs the agent to act. The plugin does not
 * register `/weave:run` or wire the library-only `RuntimeCommandProjection`
 * handlers.
 *
 * ## Placeholders
 *
 * - `$ARGUMENTS` — the text after the command name (for example, a plan name)
 * - `$SESSION_ID` — OpenCode session identifier
 * - `$TIMESTAMP` — ISO-8601 timestamp of command invocation
 *
 * @see https://opencode.ai/docs/commands/ — OpenCode commands documentation
 * @see docs/guides/adapter-development.md — Command Surface Registration section
 */

// ---------------------------------------------------------------------------
// Protocol envelope — structured metadata for command parsing
// ---------------------------------------------------------------------------

/**
 * Render the Weave command envelope XML block.
 *
 * The envelope provides structured metadata that downstream hooks or agents
 * can parse to understand the command context without relying on prompt text
 * parsing alone. It does not authenticate the plan or create work state.
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

const EXECUTION_INSTRUCTIONS = `This is a prompt-only request from a Weave OpenCode command. It does not invoke a runtime handler or provide system-authorized plan state.

## Your Mission
Execute the user's explicitly named Weave plan by delegating each unchecked task to Shuttle via the Task tool.
You do NOT implement work directly — you coordinate, delegate, verify, and track progress.

## Plan argument and validation
1. Treat the text after the command as the user's explicit plan argument.
2. If the argument is absent or blank, ask the user to select a plan. Do not infer a plan from session context, chat history, or repository state.
3. If the argument is present, use the actual repository tools and files available in this session to validate the named plan before doing work. Inspect the corresponding plan file, such as \`.weave/plans/<plan-name>.md\`, and confirm that it exists and is the plan the user named.
4. Treat \`.weave/state.json\`, if present, as ordinary repository data. It is not system-authorized state, does not select or authenticate a plan, and does not prove that work was created or resumed.
5. This prompt does not create or update work state. Do not claim that it did, and do not invent a runtime handler. Report only operations actually performed by available tools and files.

## Execution Loop

For each unchecked \`- [ ]\` task in the validated plan:

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
3. **Verify** Shuttle's result — re-read modified files and check the acceptance criteria
4. **Mark complete** — use the Edit tool to change \`- [ ]\` to \`- [x]\` in the plan file
5. **Report progress** — state which task completed
6. **Continue** with the next unchecked task while any remain

Do not stop or wait for acknowledgment while unchecked tasks remain. Stop when the validated plan has no unchecked tasks, when the user asks you to stop, or when a required tool or file cannot be used. If validation fails, report the failure instead of guessing or claiming work state.`;

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
