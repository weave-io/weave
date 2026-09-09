import { ConfigPlanTaskReader } from "@weaveio/weave-config";
import type { PlanTaskSnapshotReader } from "@weaveio/weave-engine";
import type { ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "./catalog.js";
import { fromOpenCode2Promise, type OpenCode2Error } from "./errors.js";
import type {
  CommandEditor,
  CommandInvocation,
  OpenCode2Context,
} from "./host-types.js";
import {
  type OpenCode2PlanSessionState,
  selectionFromSnapshot,
} from "./plan-session-state.js";
import { validateSessionScope } from "./session-scope.js";

export const WEAVE_START_COMMAND = "weave:start";

export interface OpenCode2CommandDependencies {
  readonly location: string;
  readonly workspaceID?: string;
  readonly context: Pick<OpenCode2Context, "session">;
  readonly refresh: () => ResultAsync<
    OpenCode2CatalogCandidate,
    OpenCode2Error
  >;
  readonly ownsAgent: (agent: string) => boolean;
  readonly plans: OpenCode2PlanSessionState;
  readonly reader?: PlanTaskSnapshotReader;
  readonly planChanged: (
    sessionID: string,
    scopeToken: string,
  ) => Promise<void>;
}

function planNameFromPrompt(text: string): string | undefined {
  const withoutCommand = text
    .trim()
    .replace(/^\/?weave:start(?:\s+|$)/, "")
    .trim();
  const parts = withoutCommand.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) return undefined;
  return parts[0];
}

function scopeToken(
  sessionID: string,
  directory: string,
  workspaceID: string | undefined,
): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${sessionID}\0${directory}\0${workspaceID ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

async function showMessage(
  context: Pick<OpenCode2Context, "session">,
  input: CommandInvocation,
  text: string,
): Promise<void> {
  await fromOpenCode2Promise(
    () =>
      context.session.synthetic({
        sessionID: input.sessionID,
        text,
        description: "Weave plan",
        resume: false,
      }),
    "session_unavailable",
    "Weave could not report the command result",
  );
}

export class OpenCode2Commands {
  private readonly reader: PlanTaskSnapshotReader;

  constructor(private readonly dependencies: OpenCode2CommandDependencies) {
    this.reader =
      dependencies.reader ?? new ConfigPlanTaskReader(dependencies.location);
  }

  register(editor: CommandEditor): void {
    if (!this.dependencies.ownsAgent("tapestry")) return;
    editor.add({
      name: WEAVE_START_COMMAND,
      description: "Start explicit foreground work from a Weave plan",
      execute: (input) => this.execute(input),
    });
  }

  private async execute(input: CommandInvocation): Promise<void> {
    const planName = planNameFromPrompt(input.prompt.text);
    if (planName === undefined) {
      await showMessage(
        this.dependencies.context,
        input,
        "Choose one plan explicitly: /weave:start <plan-name>",
      );
      return;
    }

    const sessionResult = await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.get({ sessionID: input.sessionID }),
      "session_unavailable",
      "the current session could not be read",
    );
    if (sessionResult.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "Weave could not read the current session.",
      );
      return;
    }
    const scope = validateSessionScope(
      input.sessionID,
      sessionResult.value,
      this.dependencies.location,
      this.dependencies.workspaceID,
    );
    if (scope.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "This Weave plugin instance does not own the session Location.",
      );
      return;
    }

    const refreshed = await this.dependencies.refresh();
    if (refreshed.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "The current Weave catalog is unavailable.",
      );
      return;
    }

    const token = scopeToken(
      input.sessionID,
      scope.value.directory,
      scope.value.workspaceID,
    );
    const cleared = await this.dependencies.plans.clear(input.sessionID);
    if (cleared.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "Weave could not replace the selected plan display state.",
      );
      return;
    }
    await this.dependencies.planChanged(input.sessionID, token);

    const snapshot = await this.reader.readSnapshot(planName);
    if (snapshot.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "The selected plan is missing, invalid, or unavailable.",
      );
      return;
    }
    const tapestry = refreshed.value.agents.get("tapestry");
    if (tapestry === undefined || !this.dependencies.ownsAgent("tapestry")) {
      await showMessage(
        this.dependencies.context,
        input,
        "Tapestry is not available in the current Weave catalog.",
      );
      return;
    }

    const switchedAgent = await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.switchAgent({
          sessionID: input.sessionID,
          agent: "tapestry",
        }),
      "session_unavailable",
      "Tapestry could not be selected",
    );
    if (switchedAgent.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "Weave could not select Tapestry.",
      );
      return;
    }
    const tapestryModel = tapestry.model;
    if (tapestryModel !== undefined) {
      const switchedModel = await fromOpenCode2Promise(
        () =>
          this.dependencies.context.session.switchModel({
            sessionID: input.sessionID,
            model: tapestryModel,
          }),
        "model_unavailable",
        "Tapestry's configured model could not be selected",
      );
      if (switchedModel.isErr()) {
        await this.restoreSession(input, sessionResult.value);
        await showMessage(
          this.dependencies.context,
          input,
          "Weave could not select Tapestry's configured model.",
        );
        return;
      }
    }

    const submitted = await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.prompt({
          sessionID: input.sessionID,
          files: input.prompt.files ?? [],
          agents: input.prompt.agents ?? [],
          skills: input.prompt.skills ?? [],
          text: `Execute the selected foreground plan at .weave/plans/${planName}.md. Read it now and follow its tasks.\n\n${input.prompt.text}`,
          delivery: input.delivery,
        }),
      "session_unavailable",
      "the plan prompt could not be submitted",
    );
    if (submitted.isErr()) {
      await this.restoreSession(input, sessionResult.value);
      await showMessage(
        this.dependencies.context,
        input,
        "Weave could not submit the selected plan.",
      );
      return;
    }

    const stored = await this.dependencies.plans.set(
      selectionFromSnapshot(
        input.sessionID,
        scope.value.directory,
        scope.value.workspaceID,
        snapshot.value,
      ),
    );
    if (stored.isErr()) {
      await showMessage(
        this.dependencies.context,
        input,
        "Plan work was submitted, but Weave could not store its display state.",
      );
      return;
    }
    await fromOpenCode2Promise(
      () => this.dependencies.planChanged(input.sessionID, token),
      "host_unavailable",
      "the plan display event could not be published",
    );
  }

  private async restoreSession(
    input: CommandInvocation,
    previous: Awaited<ReturnType<OpenCode2Context["session"]["get"]>>,
  ): Promise<void> {
    const previousAgent = previous.agent;
    if (previousAgent !== undefined) {
      await fromOpenCode2Promise(
        () =>
          this.dependencies.context.session.switchAgent({
            sessionID: input.sessionID,
            agent: previousAgent,
          }),
        "session_unavailable",
        "the previous agent could not be restored",
      );
    }
    const previousModel = previous.model;
    if (previousModel === undefined) return;
    await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.switchModel({
          sessionID: input.sessionID,
          model: previousModel,
        }),
      "session_unavailable",
      "the previous model could not be restored",
    );
  }
}
