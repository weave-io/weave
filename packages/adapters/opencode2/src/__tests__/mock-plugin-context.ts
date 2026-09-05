/**
 * `MockPluginContext` — an in-memory, V2-only test double for
 * `PluginContextFacade`.
 *
 * Built independently from Phase A feasibility findings
 * (`.weave/learnings/opencode2-adapter.md`) and the pinned V2 package types
 * re-exported by `../sdk-types`. This file must never import from, alias,
 * or resemble any mock in `packages/adapters/opencode/` — the V1 and V2
 * adapters are independent, parallel implementations (see
 * `docs/specs/33-spec-opencode2-adapter/33-spec-opencode2-adapter.md`).
 *
 * Every facade method call is recorded in `calls` so tests can assert on
 * call order and arguments without a live `opencode2` process.
 *
 * Brand-only casts: the real V2 SDK uses `effect`-branded IDs
 * (`Agent.ID`, `Skill.ID`, ...) inside editor/schema types, while this mock
 * only needs structurally-equivalent plain-string fixtures for testing. Casts
 * via `as unknown as <T>` are used at fixture-construction sites for the same
 * reason documented in `../plugin-context.ts` (nominal brand mismatch is a
 * compile-time-only concern; runtime shape is identical).
 */

import type {
  PluginContextAgentFacade,
  PluginContextCatalogFacade,
  PluginContextCommandFacade,
  PluginContextEventFacade,
  PluginContextFacade,
  PluginContextSessionFacade,
  PluginContextSkillFacade,
  PluginContextToolFacade,
} from "../plugin-context.js";
import type {
  V2AgentEditor,
  V2AgentInfo,
  V2CatalogEditor,
  V2CatalogModelInfo,
  V2CatalogProviderInfo,
  V2CatalogProviderRecord,
  V2CommandEditor,
  V2Event,
  V2Registration,
  V2SessionInfo,
  V2SkillEditor,
  V2SkillInfo,
} from "../sdk-types.js";

/** A single recorded facade call, `{ method, args }`. */
export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function makeRegistration(dispose: () => void): V2Registration {
  return {
    dispose: async () => {
      dispose();
    },
  };
}

/**
 * Builds a minimal fixture `V2AgentInfo`. Only fields the adapter reads are
 * populated meaningfully; the branded `id`/`name` are plain strings cast at
 * the boundary (see header).
 */
function makeAgentFixture(id: string): V2AgentInfo {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "subagent",
    hidden: false,
    permissions: [],
  } as unknown as V2AgentInfo;
}

function makeSkillFixture(id: string): V2SkillInfo {
  return {
    id,
    name: id,
    location: "",
    content: "",
  } as unknown as V2SkillInfo;
}

function makeProviderRecord(providerID: string): V2CatalogProviderRecord {
  return {
    provider: {
      id: providerID,
      name: providerID,
      activation: "auto",
      package: providerID,
    },
    models: new Map(),
  } as unknown as V2CatalogProviderRecord;
}

/**
 * In-memory `MockPluginContext` implementing every `PluginContextFacade`
 * method. Suitable for injecting into adapter modules under test in place of
 * `fromLiveContext(ctx)`.
 */
export class MockPluginContext implements PluginContextFacade {
  readonly calls: RecordedCall[] = [];

  private readonly agents = new Map<string, V2AgentInfo>();
  private readonly skills = new Map<string, V2SkillInfo>();
  private readonly providers = new Map<string, V2CatalogProviderRecord>();
  private catalogDefault: { providerID: string; modelID: string } | undefined;
  private readonly sessions = new Map<string, V2SessionInfo>();
  private sessionSeq = 0;
  private readonly eventQueue: V2Event[] = [];

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }

  /** Seed a fixture agent directly into the in-memory registry. */
  seedAgent(id: string): V2AgentInfo {
    const fixture = makeAgentFixture(id);
    this.agents.set(id, fixture);
    return fixture;
  }

  /** Seed a fixture skill directly into the in-memory registry. */
  seedSkill(id: string): V2SkillInfo {
    const fixture = makeSkillFixture(id);
    this.skills.set(id, fixture);
    return fixture;
  }

  /** Queue an event to be yielded by the next `event.subscribe()` iterator. */
  queueEvent(event: V2Event): void {
    this.eventQueue.push(event);
  }

  private buildAgentEditor(): V2AgentEditor {
    const agents = this.agents;
    return {
      list: () => Array.from(agents.values()) as never,
      get: (id) => agents.get(id) as never,
      default: () => {},
      update: (id, update) => {
        const existing = (agents.get(id) ??
          makeAgentFixture(id)) as unknown as Parameters<typeof update>[0];
        update(existing);
        agents.set(id, existing as unknown as V2AgentInfo);
      },
      remove: (id) => {
        agents.delete(id);
      },
    } satisfies V2AgentEditor;
  }

  private buildSkillEditor(): V2SkillEditor {
    const skills = this.skills;
    return {
      list: () => Array.from(skills.values()) as never,
      get: (id) => skills.get(id) as never,
      add: (skill) => {
        skills.set((skill as unknown as { id: string }).id, skill);
      },
      update: (id, update) => {
        const existing = (skills.get(id) ??
          makeSkillFixture(id)) as unknown as Parameters<typeof update>[0];
        update(existing);
        skills.set(id, existing as unknown as V2SkillInfo);
      },
      remove: (id) => {
        skills.delete(id);
      },
    } satisfies V2SkillEditor;
  }

  private buildCatalogEditor(): V2CatalogEditor {
    const providers = this.providers;
    return {
      provider: {
        list: () => Array.from(providers.values()),
        get: (providerID) => providers.get(providerID),
        update: (providerID, update) => {
          const existing =
            providers.get(providerID) ?? makeProviderRecord(providerID);
          update(existing.provider as Parameters<typeof update>[0]);
          providers.set(providerID, existing);
        },
        remove: (providerID) => {
          providers.delete(providerID);
        },
      },
      model: {
        get: (providerID, modelID) =>
          providers.get(providerID)?.models.get(modelID) as never,
        update: (providerID, modelID, update) => {
          const record =
            providers.get(providerID) ?? makeProviderRecord(providerID);
          const existing = (record.models.get(modelID) ?? {
            id: modelID,
            modelID,
            providerID,
          }) as unknown as Parameters<typeof update>[0];
          update(existing);
          (record.models as Map<string, unknown>).set(modelID, existing);
          providers.set(providerID, record);
        },
        remove: (providerID, modelID) => {
          (
            providers.get(providerID)?.models as
              | Map<string, unknown>
              | undefined
          )?.delete(modelID);
        },
        default: {
          get: () => this.catalogDefault,
          set: (providerID, modelID) => {
            this.catalogDefault = { providerID, modelID };
          },
        },
      },
    } satisfies V2CatalogEditor;
  }

  private buildCommandEditor(): V2CommandEditor {
    return {
      add: () => {
        // No-op store; command listing is intentionally not part of the
        // facade surface (see plugin-context.ts header).
      },
    } satisfies V2CommandEditor;
  }

  readonly agent: PluginContextAgentFacade = {
    transform: async (callback) => {
      this.record("agent.transform", [callback]);
      const editor = this.buildAgentEditor();
      const before = new Set(this.agents.keys());
      callback(editor);
      const dispose = (): void => {
        for (const id of this.agents.keys()) {
          if (!before.has(id)) this.agents.delete(id);
        }
      };
      return makeRegistration(dispose);
    },
    reload: async () => {
      this.record("agent.reload", []);
    },
    list: async () => {
      this.record("agent.list", []);
      return Array.from(this.agents.values());
    },
  };

  readonly catalog: PluginContextCatalogFacade = {
    provider: {
      list: async () => {
        this.record("catalog.provider.list", []);
        return Array.from(this.providers.values()).map(
          (record) => record.provider,
        ) as unknown as V2CatalogProviderInfo[];
      },
    },
    model: {
      list: async () => {
        this.record("catalog.model.list", []);
        const models: V2CatalogModelInfo[] = [];
        for (const record of this.providers.values()) {
          for (const model of record.models.values()) {
            models.push(model as unknown as V2CatalogModelInfo);
          }
        }
        return models;
      },
      default: async () => {
        this.record("catalog.model.default", []);
        if (!this.catalogDefault) return null;
        const record = this.providers.get(this.catalogDefault.providerID);
        const model = record?.models.get(this.catalogDefault.modelID);
        return (model as unknown as V2CatalogModelInfo) ?? null;
      },
    },
    transform: async (callback) => {
      this.record("catalog.transform", [callback]);
      const editor = this.buildCatalogEditor();
      callback(editor);
      return makeRegistration(() => {});
    },
  };

  readonly skill: PluginContextSkillFacade = {
    list: async () => {
      this.record("skill.list", []);
      return Array.from(this.skills.values());
    },
    transform: async (callback) => {
      this.record("skill.transform", [callback]);
      const editor = this.buildSkillEditor();
      const before = new Set(this.skills.keys());
      callback(editor);
      const dispose = (): void => {
        for (const id of this.skills.keys()) {
          if (!before.has(id)) this.skills.delete(id);
        }
      };
      return makeRegistration(dispose);
    },
  };

  readonly command: PluginContextCommandFacade = {
    transform: async (callback) => {
      this.record("command.transform", [callback]);
      const editor = this.buildCommandEditor();
      callback(editor);
      return makeRegistration(() => {});
    },
  };

  readonly session: PluginContextSessionFacade = {
    create: (async (input?: { title?: string | null }) => {
      this.record("session.create", [input]);
      this.sessionSeq += 1;
      const id = `session-${this.sessionSeq}`;
      const info = {
        id,
        projectID: "mock-project",
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        time: { created: Date.now(), updated: Date.now() },
        location: { directory: "/mock" },
        title: input?.title ?? undefined,
      } as unknown as V2SessionInfo;
      this.sessions.set(id, info);
      return info;
    }) as PluginContextSessionFacade["create"],
    get: (async (input: { sessionID: string }) => {
      this.record("session.get", [input]);
      const info = this.sessions.get(input.sessionID);
      if (!info) throw new Error(`Unknown mock session: ${input.sessionID}`);
      return info;
    }) as PluginContextSessionFacade["get"],
    prompt: (async (input: unknown) => {
      this.record("session.prompt", [input]);
      return {
        id: "inbox-item",
        sessionID:
          (input as { sessionID?: string }).sessionID ?? "unknown-session",
        timeCreated: Date.now(),
        type: "user",
        payload: {},
        delivery: "steer",
      } as unknown as ReturnType<
        PluginContextSessionFacade["prompt"]
      > extends Promise<infer R>
        ? R
        : never;
    }) as PluginContextSessionFacade["prompt"],
    wait: (async (input: { sessionID: string }) => {
      this.record("session.wait", [input]);
    }) as PluginContextSessionFacade["wait"],
    generate: (async (input: unknown) => {
      this.record("session.generate", [input]);
      return { text: "" } as unknown as ReturnType<
        PluginContextSessionFacade["generate"]
      > extends Promise<infer R>
        ? R
        : never;
    }) as PluginContextSessionFacade["generate"],
    switchAgent: (async (input: { sessionID: string; agent: string }) => {
      this.record("session.switchAgent", [input]);
      const info = this.sessions.get(input.sessionID);
      if (info) (info as unknown as { agent: string }).agent = input.agent;
    }) as PluginContextSessionFacade["switchAgent"],
    switchModel: (async (input: unknown) => {
      this.record("session.switchModel", [input]);
    }) as PluginContextSessionFacade["switchModel"],
    interrupt: (async (input: { sessionID: string }) => {
      this.record("session.interrupt", [input]);
      return { interrupted: true };
    }) as PluginContextSessionFacade["interrupt"],
    rename: (async (input: { sessionID: string; title: string }) => {
      this.record("session.rename", [input]);
      const info = this.sessions.get(input.sessionID);
      if (info) (info as unknown as { title: string }).title = input.title;
    }) as PluginContextSessionFacade["rename"],
  };

  readonly event: PluginContextEventFacade = {
    subscribe: ((options?: { signal?: AbortSignal }) => {
      this.record("event.subscribe", [options]);
      const queue = this.eventQueue;
      const signal = options?.signal;
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next(): Promise<IteratorResult<V2Event>> {
              while (!signal?.aborted && index >= queue.length) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (index < queue.length) break;
                if (signal?.aborted) break;
                // Avoid a tight spin loop in tests with no queued events.
                await new Promise((resolve) => setTimeout(resolve, 1));
                break;
              }
              if (signal?.aborted || index >= queue.length) {
                return { done: true, value: undefined };
              }
              const value = queue[index];
              index += 1;
              return { done: false, value: value as V2Event };
            },
          };
        },
      };
    }) as PluginContextEventFacade["subscribe"],
  };

  readonly tool: PluginContextToolFacade = {};
}
