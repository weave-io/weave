/**
 * Runtime Command Projection — projects declarative `CommandTemplate` values
 * (from `./command-templates`) into registered V2 commands via
 * `facade.command.transform(editor => editor.add(...))`.
 *
 * ## Registration mechanics (A4 finding)
 *
 * `command.transform` is the one domain observed to apply its effect
 * immediately and visibly (unlike `agent.transform` / `catalog.transform`,
 * which apply lazily). `CommandEditor` exposes only `add()` — there is no
 * `update`/`remove` on the V2 command editor, so each `CommandTemplate` is
 * registered via its own `transform` call and its own `V2Registration` is
 * captured for later disposal.
 *
 * ## Execute callback
 *
 * Each registered command's `execute(input: V2CommandInvocation)` callback:
 * 1. Renders the template's `promptTemplate` via `renderPrompt`, supplying
 *    `{{arguments}}` = the raw prompt text delivered by the invocation.
 * 2. Calls `facade.session.prompt({ sessionID, text, delivery })`.
 *
 * `delivery` defaults to `"queue"` (append behind any in-flight work) unless
 * overridden per-template via `deliveryMode`.
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see `./errors.ts` header for the independent V2 error union
 * rationale.
 */

import { ResultAsync } from "neverthrow";
import type { CommandTemplate } from "./command-templates.js";
import {
  commandRegistrationError,
  type OpenCode2AdapterError,
} from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";
import { renderPrompt } from "./projection-helpers.js";
import type { V2CommandInvocation, V2Registration } from "./sdk-types.js";

// ---------------------------------------------------------------------------
// § 1 — Delivery mode
// ---------------------------------------------------------------------------

/** Delivery mode used when a registered command's prompt is sent to a session. */
export type CommandDeliveryMode = "steer" | "queue";

/** Default delivery mode for built-in Weave commands: append behind any in-flight work. */
export const DEFAULT_COMMAND_DELIVERY: CommandDeliveryMode = "queue";

// ---------------------------------------------------------------------------
// § 2 — buildExecuteCallback — CommandTemplate → V2CommandDefinition.execute
// ---------------------------------------------------------------------------

/**
 * Build the `execute` callback for a single `CommandTemplate`.
 *
 * The callback renders the template against `{{arguments}}` (the invocation's
 * raw prompt text) and delivers it via `facade.session.prompt(...)`.
 */
export function buildExecuteCallback(
  facade: PluginContextFacade,
  template: CommandTemplate,
  deliveryMode: CommandDeliveryMode = DEFAULT_COMMAND_DELIVERY,
): (input: V2CommandInvocation) => Promise<void> {
  return async (input: V2CommandInvocation): Promise<void> => {
    const rawArguments =
      (input.prompt as unknown as { text?: string }).text ?? "";
    const text = renderPrompt(template.promptTemplate, {
      arguments: rawArguments,
    });

    await facade.session.prompt({
      sessionID: input.sessionID,
      text,
      delivery: deliveryMode,
    } as Parameters<PluginContextFacade["session"]["prompt"]>[0]);
  };
}

// ---------------------------------------------------------------------------
// § 3 — registerCommands — register every built-in command template
// ---------------------------------------------------------------------------

/**
 * Register every `CommandTemplate` in `templates` via
 * `facade.command.transform(editor => editor.add(...))`, one transform call
 * per command (the V2 `CommandEditor` exposes only `add()`).
 *
 * Every returned `V2Registration` is captured and returned in registration
 * order so the caller can dispose them all on adapter teardown.
 *
 * @param facade - Narrow facade over the V2 plugin context.
 * @param templates - Declarative command templates to register (in order).
 * @param deliveryMode - Delivery mode used by every registered command's
 *   `execute` callback. Defaults to `DEFAULT_COMMAND_DELIVERY` (`"queue"`).
 * @returns `ok(V2Registration[])` — one registration per template, in
 *   registration order — or `err(OpenCode2AdapterError)` on the first
 *   `command.transform` rejection.
 */
export function registerCommands(
  facade: PluginContextFacade,
  templates: readonly CommandTemplate[],
  deliveryMode: CommandDeliveryMode = DEFAULT_COMMAND_DELIVERY,
): ResultAsync<readonly V2Registration[], OpenCode2AdapterError> {
  const registrations: V2Registration[] = [];

  const chain = templates.reduce<ResultAsync<void, OpenCode2AdapterError>>(
    (acc, template) =>
      acc.andThen(() =>
        ResultAsync.fromPromise(
          facade.command.transform((editor) => {
            editor.add({
              name: template.name,
              description: template.description,
              execute: buildExecuteCallback(facade, template, deliveryMode),
            });
          }),
          (cause) => commandRegistrationError(template.name, cause),
        ).andThen((registration) => {
          registrations.push(registration);
          return ResultAsync.fromSafePromise(Promise.resolve(undefined));
        }),
      ),
    ResultAsync.fromSafePromise(Promise.resolve(undefined)),
  );

  return chain.map(() => registrations);
}
