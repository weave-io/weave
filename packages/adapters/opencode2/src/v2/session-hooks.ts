import { okAsync, type ResultAsync } from "neverthrow";
import type {
  OpenCode2CatalogAgent,
  OpenCode2CatalogCandidate,
} from "./catalog.js";
import { fromOpenCode2Promise, type OpenCode2Error } from "./errors.js";
import type {
  OpenCode2Context,
  SessionContext,
  SessionPrompt,
} from "./host-types.js";
import { validateSessionScope } from "./session-scope.js";

export interface OpenCode2SessionHookDependencies {
  readonly location: string;
  readonly workspaceID?: string;
  readonly catalog: () => OpenCode2CatalogCandidate | undefined;
  readonly ownsAgent: (agent: string) => boolean;
  readonly refresh: () => ResultAsync<
    OpenCode2CatalogCandidate,
    OpenCode2Error
  >;
  readonly session: Pick<OpenCode2Context["session"], "get" | "switchModel">;
  readonly agent: Pick<OpenCode2Context["agent"], "list">;
}

export class OpenCode2SessionHooks {
  constructor(
    private readonly dependencies: OpenCode2SessionHookDependencies,
  ) {}

  applyPrompt(input: SessionPrompt): ResultAsync<void, OpenCode2Error> {
    return this.dependencies.refresh().andThen((catalog) =>
      fromOpenCode2Promise(
        () => this.dependencies.session.get({ sessionID: input.sessionID }),
        "session_unavailable",
        "session identity could not be resolved",
      ).andThen((session) => {
        const scope = validateSessionScope(
          input.sessionID,
          session,
          this.dependencies.location,
          this.dependencies.workspaceID,
        );
        if (scope.isErr()) return okAsync(undefined);
        return this.sessionAgent(scope.value.agent).andThen((agentID) => {
          if (agentID === undefined) return okAsync(undefined);
          if (!this.dependencies.ownsAgent(agentID)) return okAsync(undefined);
          const agent = catalog.runtime.get(agentID);
          if (agent === undefined) return okAsync(undefined);
          this.attachSkills(input, agent);
          return this.selectAgentModel(
            input.sessionID,
            session.model !== undefined,
            agent,
          );
        });
      }),
    );
  }

  /**
   * The agent the turn will run on. A session started without one (plain
   * `opencode2 run`) runs on the host's default agent, which the host lists
   * first; that is Loom unless the user set their own `default_agent`.
   */
  private sessionAgent(
    selected: string | undefined,
  ): ResultAsync<string | undefined, OpenCode2Error> {
    if (selected !== undefined) return okAsync(selected);
    return fromOpenCode2Promise(
      () => this.dependencies.agent.list(),
      "host_unavailable",
      "OpenCode agent inventory could not be read",
    ).map((agents) => agents.data[0]?.id);
  }

  /**
   * OpenCode 2 runs a turn on the session's selected model and falls back to
   * the host default when none is selected; it never reads the agent's own
   * model. The TUI selects the agent's model before every submit, but a
   * client that selects none (`opencode2 run` without `-m`, the API) would
   * leave a Weave agent on the host default. Selecting the agent's resolved
   * model here, only when the session has none, gives those clients the model
   * the `.weave` config asked for without overriding a model the user chose.
   */
  private selectAgentModel(
    sessionID: string,
    hasModel: boolean,
    agent: OpenCode2CatalogAgent,
  ): ResultAsync<void, OpenCode2Error> {
    const model = agent.projection.model;
    if (hasModel || model === undefined) return okAsync(undefined);
    return fromOpenCode2Promise(
      () => this.dependencies.session.switchModel({ sessionID, model }),
      "session_unavailable",
      "the agent's model could not be selected for the session",
    ).map(() => undefined);
  }

  private attachSkills(input: SessionPrompt, agent: OpenCode2CatalogAgent) {
    if (agent.skillIDs.length === 0) return;
    // OpenCode 2 beta-19086 does not expose the native skill permission
    // assertion at prompt admission. This release attaches configured,
    // available skill IDs without claiming that assertion occurred.
    const existing = new Set(
      (input.prompt.skills ?? []).map((skill) => skill.id),
    );
    const additions = agent.skillIDs
      .filter((skillID) => !existing.has(skillID))
      .map((skillID) => ({ id: skillID }));
    if (additions.length === 0) return;
    input.prompt.skills = [...(input.prompt.skills ?? []), ...additions];
  }

  applyContext(input: SessionContext): ResultAsync<void, OpenCode2Error> {
    if (!this.dependencies.ownsAgent(input.agent)) return okAsync(undefined);
    return fromOpenCode2Promise(
      () => this.dependencies.session.get({ sessionID: input.sessionID }),
      "session_unavailable",
      "session identity could not be resolved",
    ).map((session) => {
      const scope = validateSessionScope(
        input.sessionID,
        session,
        this.dependencies.location,
        this.dependencies.workspaceID,
      );
      if (scope.isErr()) return undefined;
      const agent = this.dependencies.catalog()?.runtime.get(input.agent);
      if (agent?.projection.temperature === undefined) return undefined;
      input.options.temperature = agent.projection.temperature;
      return undefined;
    });
  }
}
