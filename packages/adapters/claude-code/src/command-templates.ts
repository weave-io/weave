/**
 * Command templates for Claude Code commands.
 *
 * These templates are the full content of `.md` command files that Claude Code
 * loads when the user types `/weave:start` or `/weave:start-work`. They instruct
 * the Tapestry agent to execute a Weave plan.
 *
 * ## How Claude Code commands work
 *
 * Claude Code commands are file-based. Each command is a `.md` file with YAML
 * frontmatter that declares the agent, context, and behavior. When a user types
 * `/weave:start my-plan`, Claude Code replaces `$ARGUMENTS` with `my-plan` and
 * sends the command body as a user message to the configured agent.
 *
 * ## Placeholders
 *
 * - `$ARGUMENTS` - the text after the command name (e.g. plan name)
 *
 * @see docs/adapter-bootstrap.md - Command Surface Registration section
 */

// ---------------------------------------------------------------------------
// Shared execution instructions (Tapestry agent prompt)
// ---------------------------------------------------------------------------

const EXECUTION_INSTRUCTIONS = `You are being activated by the /weave:start command to execute a Weave plan.

## Your Mission
Read the plan and execute it by delegating each unchecked task to weave:shuttle via the Agent tool.
You do NOT implement work directly - you coordinate, delegate, verify, and track progress.

Execution is non-terminal while any \`- [ ]\` task remains.
Do not stop, ask what to do next, or wait for acknowledgment while unchecked tasks remain.

## Startup Procedure

1. **Resolve plan path**: The plan name is \`$ARGUMENTS\`. Read \`.weave/plans/$ARGUMENTS.md\`.
2. **Check for active work state**: Read \`.weave/state.json\` to see if there's a plan already in progress.
3. **If resuming**: Find the first unchecked \`- [ ]\` task and continue from there.
4. **If starting fresh**: Begin from the first unchecked task.

## Execution Loop

For each unchecked \`- [ ]\` task in the plan:

1. **Read** the task description, acceptance criteria, and any references
2. **Delegate** the task to weave:shuttle via the Agent tool using this prompt format:
   \`\`\`
   Task [N/M]: [Task Title]
   **What**: [full task description from plan]
   **Files**: [file paths from plan]
   **Acceptance**: [acceptance criteria from plan]
   **Context from completed tasks**: [any output or decisions from prior tasks that affect this one]
   **Learnings**: [relevant entries from .weave/learnings/{plan-name}.md if the file exists]
   \`\`\`
3. **Verify** weave:shuttle's result - re-read modified files, check acceptance criteria are met
4. **Mark complete** - use the Edit tool to change \`- [ ]\` to \`- [x]\` in the plan file
5. **Report progress** - "Completed task N/M: [title]"
6. **Continue immediately** - find the next unchecked task and delegate it without waiting for user acknowledgment

## Rules

- Work through tasks **top to bottom** unless dependencies require a different order
- **Delegate every task to weave:shuttle** - do not implement work directly yourself
- **Verify every task** before marking it complete; if verification fails, re-delegate to weave:shuttle with the failure details
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
 * Template for the `/weave:start` command.
 *
 * This is the full content of the `weave-start.md` command file including
 * YAML frontmatter. Claude Code will replace `$ARGUMENTS` with the plan name
 * when the user invokes the command.
 */
export const CC_WEAVE_START_COMMAND = `---
context: fork
agent: weave:tapestry
disable-model-invocation: true
description: "Execute a Weave plan by delegating tasks to weave:shuttle"
argument-hint: "[plan-name]"
---

${EXECUTION_INSTRUCTIONS}`;

/**
 * Template for the `/weave:start-work` command (legacy alias).
 *
 * This is the full content of the `weave-start-work.md` command file including
 * YAML frontmatter. Claude Code will replace `$ARGUMENTS` with the plan name
 * when the user invokes the command.
 */
export const CC_START_WORK_COMMAND = `---
context: fork
agent: weave:tapestry
disable-model-invocation: true
description: "Execute a Weave plan (legacy alias for weave:start)"
argument-hint: "[plan-name]"
---

${EXECUTION_INSTRUCTIONS}`;
