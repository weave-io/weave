import { ConfigPlanTaskReader } from "@weaveio/weave-config";
import { logger, type PlanTaskSnapshotReader } from "@weaveio/weave-engine";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "./catalog.js";
import { fromOpenCode2Promise, type OpenCode2Error } from "./errors.js";
import type {
  CommandEditor,
  CommandInvocation,
  OpenCode2Context,
} from "./host-types.js";
import { choosePlanMessage, listPlanNames } from "./plan-catalog.js";
import {
  INVALID_PLAN_NAME_MESSAGE,
  parsePlanName,
  PLAN_CATALOG_UNREADABLE_MESSAGE,
} from "./plan-name.js";
import {
  type OpenCode2PlanSessionState,
  selectionFromSnapshot,
} from "./plan-session-state.js";
import { validateSessionScope } from "./session-scope.js";

export const WEAVE_START_COMMAND = "weave:start";

type PlanStartInput = Omit<CommandInvocation, "sessionID"> & {
  readonly sessionID: string;
};
type Session = Awaited<ReturnType<OpenCode2Context["session"]["get"]>>;

export type StartPlanError = {
  readonly type: "InvalidPlan" | "WrongLocation" | "StartUnavailable";
  readonly message: string;
};

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

function unavailable(message: string): StartPlanError {
  return { type: "StartUnavailable", message };
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
      execute: async (input) => {
        const parsed = parsePlanName(input.prompt.text);
        if (parsed.type === "missing") {
          if ((await this.readSession(input)).isErr()) return;
          const listed = await listPlanNames(this.dependencies.location);
          const text =
            listed.isErr() && listed.error.type === "Unreadable"
              ? PLAN_CATALOG_UNREADABLE_MESSAGE
              : choosePlanMessage(listed.isOk() ? listed.value : []);
          await this.report(input, text);
          return;
        }
        const result = await this.execute(input);
        if (result.isErr() && result.error.type !== "WrongLocation") {
          await this.report(input, result.error.message);
        }
      },
    });
  }

  /** Admission returns a failure value; only the native command renders it. */
  execute(input: PlanStartInput): ResultAsync<void, StartPlanError> {
    return ResultAsync.fromThrowable(
      () => this.admit(input),
      () => unavailable("Weave could not start the selected plan."),
    )().andThen((result) => result);
  }

  private async admit(
    input: PlanStartInput,
  ): Promise<Result<void, StartPlanError>> {
    const parsed = parsePlanName(input.prompt.text);
    if (parsed.type !== "valid")
      return err({ type: "InvalidPlan", message: INVALID_PLAN_NAME_MESSAGE });
    const planName = parsed.name;
    const session = await this.readSession(input);
    if (session.isErr()) return err(session.error);
    const refreshed = await this.dependencies.refresh();
    if (refreshed.isErr())
      return err(unavailable("The current Weave catalog is unavailable."));
    if ((await this.readSession(input)).isErr())
      return err(this.wrongLocation());

    const token = new Bun.CryptoHasher("sha256")
      .update(
        `${input.sessionID}\0${this.dependencies.location}\0${this.dependencies.workspaceID ?? ""}`,
      )
      .digest("hex")
      .slice(0, 32);
    const cleared = await this.dependencies.plans.clear(input.sessionID);
    if (cleared.isErr())
      return err(
        unavailable("Weave could not replace the selected plan display state."),
      );
    // Display notifications do not control admission.
    await this.notify(input.sessionID, token);
    const snapshot = await this.reader.readSnapshot(planName);
    if (snapshot.isErr())
      return err({
        type: "InvalidPlan",
        message: "The selected plan is missing, invalid, or unavailable.",
      });
    const tapestry = refreshed.value.agents.get("tapestry");
    if (tapestry === undefined || !this.dependencies.ownsAgent("tapestry")) {
      return err(
        unavailable("Tapestry is not available in the current Weave catalog."),
      );
    }
    if ((await this.readSession(input)).isErr())
      return err(this.wrongLocation());
    const switched = await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.switchAgent({
          sessionID: input.sessionID,
          agent: "tapestry",
        }),
      "session_unavailable",
      "Weave could not select Tapestry.",
    );
    if (switched.isErr()) return err(unavailable(switched.error.message));

    const tapestryModel = tapestry.model;
    if (tapestryModel !== undefined) {
      if ((await this.readSession(input)).isErr())
        return err(this.wrongLocation());
      const switchedModel = await fromOpenCode2Promise(
        () =>
          this.dependencies.context.session.switchModel({
            sessionID: input.sessionID,
            model: tapestryModel,
          }),
        "model_unavailable",
        "Weave could not select Tapestry's configured model.",
      );
      if (switchedModel.isErr()) {
        await this.restore(input, session.value);
        return err(unavailable(switchedModel.error.message));
      }
    }
    if ((await this.readSession(input)).isErr())
      return err(this.wrongLocation());
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
      "Weave could not submit the selected plan.",
    );
    if (submitted.isErr()) {
      await this.restore(input, session.value);
      return err(unavailable(submitted.error.message));
    }

    // Work is admitted. A display failure must not look like a retryable start failure.
    if ((await this.readSession(input)).isErr()) return ok(undefined);
    const stored = await this.dependencies.plans.set(
      selectionFromSnapshot(
        input.sessionID,
        session.value.location.directory,
        session.value.location.workspaceID,
        snapshot.value,
      ),
    );
    if (stored.isErr()) {
      logger.warn(
        { code: stored.error.code },
        "Plan started, but its display state could not be saved",
      );
      return ok(undefined);
    }
    await this.notify(input.sessionID, token);
    return ok(undefined);
  }

  private wrongLocation(): StartPlanError {
    return {
      type: "WrongLocation",
      message: "The session is unavailable or its Location changed.",
    };
  }

  private readSession(
    input: PlanStartInput,
  ): ResultAsync<Session, StartPlanError> {
    return fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.get({ sessionID: input.sessionID }),
      "session_unavailable",
      "Session unavailable",
    )
      .mapErr(() => this.wrongLocation())
      .andThen((session) => {
        const scope = validateSessionScope(
          input.sessionID,
          session,
          this.dependencies.location,
          this.dependencies.workspaceID,
        );
        if (scope.isErr()) return err(this.wrongLocation());
        return ok(session);
      });
  }

  private report(
    input: PlanStartInput,
    text: string,
  ): ResultAsync<void, StartPlanError> {
    return this.readSession(input).andThen(() =>
      fromOpenCode2Promise(
        () =>
          this.dependencies.context.session.synthetic({
            sessionID: input.sessionID,
            text,
            description: text.split("\n")[0],
            resume: false,
          }),
        "session_unavailable",
        "Weave could not report the command result",
      )
        .map(() => undefined)
        .mapErr((error) => unavailable(error.message)),
    );
  }

  private async notify(sessionID: string, token: string): Promise<void> {
    const result = await fromOpenCode2Promise(
      () => this.dependencies.planChanged(sessionID, token),
      "host_unavailable",
      "The plan display event could not be published",
    );
    if (result.isErr())
      logger.warn({ code: result.error.code }, result.error.message);
  }

  private async restore(
    input: PlanStartInput,
    previous: Session,
  ): Promise<void> {
    if ((await this.readSession(input)).isErr()) return;
    const agent = previous.agent;
    if (agent !== undefined) {
      const restored = await fromOpenCode2Promise(
        () =>
          this.dependencies.context.session.switchAgent({
            sessionID: input.sessionID,
            agent,
          }),
        "session_unavailable",
        "The previous agent could not be restored",
      );
      if (restored.isErr())
        logger.warn({ code: restored.error.code }, restored.error.message);
    }
    const model = previous.model;
    if (model === undefined || (await this.readSession(input)).isErr()) return;
    const restored = await fromOpenCode2Promise(
      () =>
        this.dependencies.context.session.switchModel({
          sessionID: input.sessionID,
          model,
        }),
      "session_unavailable",
      "The previous model could not be restored",
    );
    if (restored.isErr())
      logger.warn({ code: restored.error.code }, restored.error.message);
  }
}
