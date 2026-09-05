/**
 * Command Templates — declarative V2 slash-command definitions.
 *
 * Declares the built-in `/weave:*` commands for the `opencode2` V2 adapter as
 * plain data: `{ name, description, promptTemplate }`. This module has no
 * dependency on `@opencode-ai/*` or the V2 plugin `Context` — it is pure data
 * consumed by `./runtime-command-projection.ts`, which projects each template
 * into a `V2Command.Info` and registers it via `facade.command.transform`.
 *
 * Implemented independently from the V1 OpenCode adapter's
 * `command-templates.ts` (`packages/adapters/opencode/src/command-templates.ts`).
 * V2 commands are handler-driven (`execute()` callback invoking
 * `facade.session.prompt(...)`) rather than OpenCode V1's static
 * placeholder-substitution config (`$ARGUMENTS`, `$SESSION_ID`). Overlap in
 * command names is intentional (same product surface); the mechanism is
 * V2-native and unrelated to V1's config-driven templates.
 *
 * ## Canonical command set (Spec 33 §7)
 *
 * | Command          | Purpose                                          |
 * |------------------|---------------------------------------------------|
 * | `/weave:start`   | Start execution of a named plan                   |
 * | `/weave:run`     | Explicitly run a named workflow                    |
 * | `/weave:status`  | Read-only inspection of execution state            |
 * | `/weave:abort`   | Cancel or pause an active execution                |
 * | `/weave:advance` | Advance or complete a blocked step                 |
 * | `/weave:health`  | Report adapter/runtime readiness                   |
 *
 * `promptTemplate` supports `{{key}}` placeholders rendered via
 * `./projection-helpers`'s `renderPrompt`. `{{arguments}}` is always
 * populated with the raw text following the command invocation.
 */

/**
 * A single declarative V2 command definition.
 *
 * `name` is the bare command name registered via
 * `facade.command.transform(editor => editor.add({ name, description, execute }))`
 * — the adapter is responsible for prefixing/namespacing per the concrete V2
 * `CommandEditor.add()` contract.
 */
export interface CommandTemplate {
  /** Bare command name, e.g. `"weave:start"` (no leading slash). */
  readonly name: string;
  /** Human-readable description shown in command pickers/help surfaces. */
  readonly description: string;
  /**
   * Prompt template rendered (via `renderPrompt`) and delivered through
   * `facade.session.prompt(...)` when the command executes.
   */
  readonly promptTemplate: string;
}

// ---------------------------------------------------------------------------
// Shared envelope fragment
// ---------------------------------------------------------------------------

function commandEnvelope(commandName: string): string {
  return `<weave-command-envelope>
<protocol-version>2</protocol-version>
<command-name>${commandName}</command-name>
<arguments>{{arguments}}</arguments>
</weave-command-envelope>`;
}

// ---------------------------------------------------------------------------
// Built-in command templates
// ---------------------------------------------------------------------------

/**
 * `/weave:start` — start execution of a named plan.
 *
 * Delivered via `start-plan-execution.ts`'s `startPlanExecution`, which
 * composes the loom-activation prompt and calls `facade.session.prompt(...)`.
 */
export const WEAVE_START_TEMPLATE: CommandTemplate = {
  name: "weave:start",
  description: "Start execution of a named Weave plan",
  promptTemplate: `<command-instruction>
You are being activated by /weave:start to execute a Weave plan.
Read the plan and execute it by delegating each unchecked task to Shuttle.
</command-instruction>
${commandEnvelope("weave:start")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * `/weave:run` — explicitly run a named workflow.
 */
export const WEAVE_RUN_TEMPLATE: CommandTemplate = {
  name: "weave:run",
  description: "Explicitly run a named Weave workflow",
  promptTemplate: `<command-instruction>
You are being activated by /weave:run to execute a named workflow end-to-end.
</command-instruction>
${commandEnvelope("weave:run")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * `/weave:status` — read-only inspection of execution state.
 */
export const WEAVE_STATUS_TEMPLATE: CommandTemplate = {
  name: "weave:status",
  description: "Inspect the status of a Weave workflow execution",
  promptTemplate: `<command-instruction>
Report the current status of the referenced Weave workflow execution.
</command-instruction>
${commandEnvelope("weave:status")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * `/weave:abort` — cancel or pause an active execution.
 */
export const WEAVE_ABORT_TEMPLATE: CommandTemplate = {
  name: "weave:abort",
  description: "Cancel or pause an active Weave workflow execution",
  promptTemplate: `<command-instruction>
Abort or pause the referenced Weave workflow execution as requested.
</command-instruction>
${commandEnvelope("weave:abort")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * `/weave:advance` — advance or complete a blocked step.
 */
export const WEAVE_ADVANCE_TEMPLATE: CommandTemplate = {
  name: "weave:advance",
  description: "Advance or complete a blocked Weave workflow step",
  promptTemplate: `<command-instruction>
Advance the blocked step of the referenced Weave workflow execution.
</command-instruction>
${commandEnvelope("weave:advance")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * `/weave:health` — report adapter/runtime readiness.
 */
export const WEAVE_HEALTH_TEMPLATE: CommandTemplate = {
  name: "weave:health",
  description: "Report Weave V2 adapter and runtime readiness",
  promptTemplate: `<command-instruction>
Report Weave V2 adapter and runtime health/readiness.
</command-instruction>
${commandEnvelope("weave:health")}
<user-request>{{arguments}}</user-request>`,
};

/**
 * The full built-in command set for the `opencode2` V2 adapter, in
 * registration order.
 */
export const BUILTIN_COMMANDS: readonly CommandTemplate[] = [
  WEAVE_START_TEMPLATE,
  WEAVE_RUN_TEMPLATE,
  WEAVE_STATUS_TEMPLATE,
  WEAVE_ABORT_TEMPLATE,
  WEAVE_ADVANCE_TEMPLATE,
  WEAVE_HEALTH_TEMPLATE,
];
