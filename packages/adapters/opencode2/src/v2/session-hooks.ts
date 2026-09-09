import { okAsync, type ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "./catalog.js";
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
  readonly session: Pick<OpenCode2Context["session"], "get">;
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
      ).map((session) => {
        const scope = validateSessionScope(
          input.sessionID,
          session,
          this.dependencies.location,
          this.dependencies.workspaceID,
        );
        if (scope.isErr() || scope.value.agent === undefined) return undefined;
        if (!this.dependencies.ownsAgent(scope.value.agent)) return undefined;
        const agent = catalog.runtime.get(scope.value.agent);
        if (agent === undefined || agent.skillIDs.length === 0)
          return undefined;

        // OpenCode 2 beta-19086 does not expose the native skill permission
        // assertion at prompt admission. This release attaches configured,
        // available skill IDs without claiming that assertion occurred.
        const existing = new Set(
          (input.prompt.skills ?? []).map((skill) => skill.id),
        );
        const additions = agent.skillIDs
          .filter((skillID) => !existing.has(skillID))
          .map((skillID) => ({ id: skillID }));
        if (additions.length === 0) return undefined;
        input.prompt.skills = [...(input.prompt.skills ?? []), ...additions];
        return undefined;
      }),
    );
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
      input.generation.temperature = agent.projection.temperature;
      return undefined;
    });
  }
}
