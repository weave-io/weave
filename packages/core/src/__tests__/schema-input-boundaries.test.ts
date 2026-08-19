import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  AdapterSettingsSchema,
  AgentConfigSchema,
  AgentDelegationConfigSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  DelegationSettingsSchema,
  ExtendBeforePlanSchema,
  ExtensionPointsSchema,
  JsonValueSchema,
  ReconciliationHandlerListSchema,
  RoutingConfigSchema,
  RuntimeJournalSettingsSchema,
  RuntimeLogSettingsSchema,
  RuntimeSettingsSchema,
  RuntimeUsageSettingsSchema,
  SettingsConfigSchema,
  ToolPolicySchema,
  WeaveConfigSchema,
  WorkflowConfigSchema,
  WorkflowStepSchema,
} from "../schema.js";
import { MAX_CONFIG_ARRAY_LENGTH } from "../schema-common.js";

type SchemaFixtureValue =
  | string
  | boolean
  | number
  | string[]
  | SchemaFixtureRecord;
type SchemaFixtureRecord = {
  [key: string]: SchemaFixtureValue;
};
type RecursiveJsonObject = {
  next?: RecursiveJsonObject;
};
function emptySchemaFixtureRecord(): SchemaFixtureRecord {
  return Object.setPrototypeOf({}, null);
}

function ownSchemaFixtureRecord(
  key: string,
  value: SchemaFixtureValue,
): SchemaFixtureRecord {
  const record = emptySchemaFixtureRecord();
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return record;
}

describe("exported schema input boundaries", () => {
  it("preserves the composed schema input type at the public boundary", () => {
    const input: z.input<typeof AgentConfigSchema> = { fast: true };
    expect(input.fast).toBe(true);
  });

  it("preserves ZodObject APIs for public object schemas", () => {
    const publicFieldsKey = "shape";
    expect(ToolPolicySchema).toBeInstanceOf(z.ZodObject);
    expect(RoutingConfigSchema).toBeInstanceOf(z.ZodObject);
    expect(ToolPolicySchema[publicFieldsKey].read).toBeDefined();
    expect(
      RoutingConfigSchema[publicFieldsKey].delegation_exclude,
    ).toBeDefined();

    const extendedPolicy = ToolPolicySchema.extend({
      custom: z.string().optional(),
    });
    const extendedRouting = RoutingConfigSchema.extend({
      custom: z.string().optional(),
    });

    expect(extendedPolicy[publicFieldsKey].custom).toBeDefined();
    expect(extendedRouting[publicFieldsKey].custom).toBeDefined();
    expect(extendedPolicy.safeParse({ custom: "policy" }).success).toBe(true);
    expect(extendedRouting.safeParse({ custom: "routing" }).success).toBe(true);
  });

  it("materializes exported records with null prototypes without invoking setters", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "ordinary",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "ordinary", {
        configurable: true,
        enumerable: true,
        set() {
          setterExecutions += 1;
        },
      });

      const json = JsonValueSchema.safeParse(
        ownSchemaFixtureRecord("ordinary", true),
      );
      const adapter = AdapterSettingsSchema.safeParse(
        ownSchemaFixtureRecord("ordinary", true),
      );
      const weave = WeaveConfigSchema.safeParse({
        agents: ownSchemaFixtureRecord("ordinary", { fast: true }),
        categories: ownSchemaFixtureRecord("ordinary", {
          description: "Ordinary category",
        }),
        workflows: ownSchemaFixtureRecord("ordinary", {
          version: 1,
          extends: "base",
          steps: [],
        }),
      });

      expect(json.success).toBe(true);
      expect(adapter.success).toBe(true);
      expect(weave.success).toBe(true);
      if (json.success) expect(Object.getPrototypeOf(json.data)).toBeNull();
      if (adapter.success)
        expect(Object.getPrototypeOf(adapter.data)).toBeNull();
      if (weave.success) {
        expect(Object.getPrototypeOf(weave.data.agents)).toBeNull();
        expect(Object.getPrototypeOf(weave.data.categories)).toBeNull();
        expect(Object.getPrototypeOf(weave.data.workflows)).toBeNull();
      }
      expect(setterExecutions).toBe(0);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "ordinary");
      else Object.defineProperty(Object.prototype, "ordinary", previous);
    }
  });

  it("fails closed before an inherited setter can observe an accepted key", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      const parsed = WorkflowConfigSchema.safeParse({
        description: "safe",
        version: 1,
        extends: "base",
        steps: [],
      });

      expect(parsed.success).toBe(false);
      expect(setterExecutions).toBe(0);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "description");
      else Object.defineProperty(Object.prototype, "description", previous);
    }
  });

  it("guards defaulted output keys that are absent from settings input", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "log_level",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "log_level", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      let parsed: ReturnType<typeof SettingsConfigSchema.safeParse> | undefined;
      expect(() => {
        parsed = SettingsConfigSchema.safeParse({});
      }).not.toThrow();

      expect(parsed?.success).toBe(false);
      expect(setterExecutions).toBe(0);
      if (parsed?.success === false) {
        expect(parsed.error.issues.length).toBeGreaterThan(0);
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "log_level");
      else Object.defineProperty(Object.prototype, "log_level", previous);
    }
  });

  it("guards top-level defaults before WeaveConfig output materialization", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "agents",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "agents", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      let parsed: ReturnType<typeof WeaveConfigSchema.safeParse> | undefined;
      expect(() => {
        parsed = WeaveConfigSchema.safeParse({});
      }).not.toThrow();

      expect(parsed?.success).toBe(false);
      expect(setterExecutions).toBe(0);
      if (parsed?.success === false) {
        expect(parsed.error.issues.length).toBeGreaterThan(0);
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "agents");
      else Object.defineProperty(Object.prototype, "agents", previous);
    }
  });

  it("guards nested default output keys before materialization", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "strict",
    );
    let setterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "strict", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      const parsed = SettingsConfigSchema.safeParse({});

      expect(parsed.success).toBe(false);
      expect(setterExecutions).toBe(0);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("strict"),
          }),
        );
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "strict");
      else Object.defineProperty(Object.prototype, "strict", previous);
    }
  });

  it("guards nested default output keys with getter-only descriptors", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "strict",
    );
    let getterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "strict", {
        configurable: true,
        get() {
          getterExecutions += 1;
          return true;
        },
      });

      const parsed = SettingsConfigSchema.safeParse({});

      expect(parsed.success).toBe(false);
      expect(getterExecutions).toBe(0);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("strict"),
          }),
        );
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "strict");
      else Object.defineProperty(Object.prototype, "strict", previous);
    }
  });

  it("guards nested default output keys with non-writable data descriptors", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "strict",
    );
    try {
      Object.defineProperty(Object.prototype, "strict", {
        configurable: true,
        value: true,
        writable: false,
      });

      const parsed = SettingsConfigSchema.safeParse({});

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("strict"),
          }),
        );
      }
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "strict");
      else Object.defineProperty(Object.prototype, "strict", previous);
    }
  });

  it("guards nested array output before Zod materialization", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    let parsed: ReturnType<typeof AgentConfigSchema.safeParse> | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });

      parsed = AgentConfigSchema.safeParse({ models: ["model"] });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }

    expect(parsed?.success).toBe(false);
    expect(setterExecutions).toBe(0);
    if (parsed?.success === false) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("0") }),
      );
    }
  });

  it("rejects nested array output before a getter-only numeric descriptor runs", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let getterExecutions = 0;
    let parsed: ReturnType<typeof AgentConfigSchema.safeParse> | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        get() {
          getterExecutions += 1;
          return "inherited";
        },
      });

      expect(() => {
        parsed = AgentConfigSchema.safeParse({ models: ["model"] });
      }).not.toThrow();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }

    expect(parsed?.success).toBe(false);
    expect(getterExecutions).toBe(0);
  });

  it("rejects nested array output before a non-writable numeric descriptor can swallow it", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let parsed: ReturnType<typeof AgentConfigSchema.safeParse> | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        value: "inherited",
        writable: false,
      });

      expect(() => {
        parsed = AgentConfigSchema.safeParse({ models: ["model"] });
      }).not.toThrow();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }

    expect(parsed?.success).toBe(false);
  });

  it("rejects dangerous own keys in exported dynamic records", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(
        JsonValueSchema.safeParse(ownSchemaFixtureRecord(key, true)).success,
      ).toBe(false);
      expect(
        AdapterSettingsSchema.safeParse(ownSchemaFixtureRecord(key, true))
          .success,
      ).toBe(false);

      expect(
        WeaveConfigSchema.safeParse({
          agents: ownSchemaFixtureRecord(key, { fast: true }),
        }).success,
      ).toBe(false);
      expect(
        WeaveConfigSchema.safeParse({
          categories: ownSchemaFixtureRecord(key, {
            description: "Dangerous key",
          }),
        }).success,
      ).toBe(false);
      expect(
        WeaveConfigSchema.safeParse({
          workflows: ownSchemaFixtureRecord(key, {
            version: 1,
            extends: "base",
            steps: [],
          }),
        }).success,
      ).toBe(false);
    }
  });

  it("accepts 512 items and rejects 513 at exported schema boundaries", () => {
    const models = (count: number) =>
      Array.from({ length: count }, (_, index) => `model-${index}`);

    expect(
      AgentConfigSchema.safeParse({ models: models(MAX_CONFIG_ARRAY_LENGTH) })
        .success,
    ).toBe(true);
    const overLimit = AgentConfigSchema.safeParse({
      models: models(MAX_CONFIG_ARRAY_LENGTH + 1),
    });
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      expect(overLimit.error.issues).toContainEqual(
        expect.objectContaining({ path: ["models"] }),
      );
      expect(JSON.stringify(overLimit.error.issues).length).toBeLessThanOrEqual(
        1024,
      );
    }

    expect(
      JsonValueSchema.safeParse(models(MAX_CONFIG_ARRAY_LENGTH)).success,
    ).toBe(true);
    expect(
      JsonValueSchema.safeParse(models(MAX_CONFIG_ARRAY_LENGTH + 1)).success,
    ).toBe(false);
  });

  it("copies input before Zod can read Object.prototype fields", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    let getterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        enumerable: true,
        get() {
          getterExecutions += 1;
          return "inherited description";
        },
      });

      expect(CategoryConfigSchema.safeParse({}).success).toBe(false);
      expect(getterExecutions).toBe(0);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "description");
      else Object.defineProperty(Object.prototype, "description", previous);
    }
  });

  it("rejects an own description when an inherited getter-only descriptor blocks output", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    let getterExecutions = 0;
    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        enumerable: true,
        get() {
          getterExecutions += 1;
          return "inherited description";
        },
      });

      let parsed: ReturnType<typeof CategoryConfigSchema.safeParse> | undefined;
      expect(() => {
        parsed = CategoryConfigSchema.safeParse({ description: "safe" });
      }).not.toThrow();
      expect(parsed?.success).toBe(false);
      expect(getterExecutions).toBe(0);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "description");
      else Object.defineProperty(Object.prototype, "description", previous);
    }
  });

  it("rejects an own description when an inherited non-writable descriptor blocks output", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        enumerable: true,
        value: "inherited description",
        writable: false,
      });

      let parsed: ReturnType<typeof CategoryConfigSchema.safeParse> | undefined;
      expect(() => {
        parsed = CategoryConfigSchema.safeParse({ description: "safe" });
      }).not.toThrow();
      expect(parsed?.success).toBe(false);
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(Object.prototype, "description");
      else Object.defineProperty(Object.prototype, "description", previous);
    }
  });

  it("SettingsConfigSchema rejects nested accessors before Zod reads them", () => {
    let getterExecutions = 0;
    const settings = {};
    Object.defineProperty(settings, "runtime", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        throw new Error("settings runtime getter must not run");
      },
    });

    expect(SettingsConfigSchema.safeParse(settings).success).toBe(false);
    expect(getterExecutions).toBe(0);
  });

  it("protects every exported object schema with the same descriptor boundary", () => {
    const cases = [
      [ToolPolicySchema, "read"],
      [DelegationSettingsSchema, "max_children"],
      [AgentDelegationConfigSchema, "max_children"],
      [RoutingConfigSchema, "delegation_exclude"],
      [CompletionMethodSchema, "method"],
      [WorkflowStepSchema, "name"],
      [ExtensionPointsSchema, "before_plan"],
      [ExtendBeforePlanSchema, "steps"],
      [WorkflowConfigSchema, "version"],
      [AdapterSettingsSchema, "harness"],
      [RuntimeJournalSettingsSchema, "strict"],
      [RuntimeUsageSettingsSchema, "detail_retention_days"],
      [RuntimeLogSettingsSchema, "max_segments"],
      [RuntimeSettingsSchema, "journal"],
      [SettingsConfigSchema, "log_level"],
      [WeaveConfigSchema, "agents"],
    ] as const;

    for (const [schema, key] of cases) {
      let getterExecutions = 0;
      const input = {};
      Object.defineProperty(input, key, {
        configurable: true,
        enumerable: true,
        get() {
          getterExecutions += 1;
          throw new Error("schema getter must not run");
        },
      });

      expect(schema.safeParse(input).success).toBe(false);
      expect(getterExecutions).toBe(0);
    }
  });

  it("protects exported array and recursive schemas before traversal", () => {
    let getterExecutions = 0;
    const handlers: SchemaFixtureValue[] = [];
    Object.defineProperty(handlers, "0", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        throw new Error("handler getter must not run");
      },
    });
    handlers.length = 1;

    expect(ReconciliationHandlerListSchema.safeParse(handlers).success).toBe(
      false,
    );
    expect(getterExecutions).toBe(0);
  });

  it("bounds direct recursive JSON inputs before recursive Zod traversal", () => {
    const root: RecursiveJsonObject = {};
    let current = root;
    for (let index = 0; index <= 80; index += 1) {
      const next: RecursiveJsonObject = {};
      current.next = next;
      current = next;
    }

    expect(JsonValueSchema.safeParse(root).success).toBe(false);
  });

  it.each([
    ["root agents", WeaveConfigSchema, "agents", {}],
    ["agent fast", AgentConfigSchema, "fast", true],
    ["agent triggers", AgentConfigSchema, "triggers", ["owned"]],
    ["category fast", CategoryConfigSchema, "fast", true],
    ["category triggers", CategoryConfigSchema, "triggers", ["owned"]],
    ["category description", CategoryConfigSchema, "description", "inherited"],
  ])("rejects prototype-provided %s", (_case, schema, key, value) => {
    const prototypeFields: SchemaFixtureRecord = {};
    prototypeFields[key] = value;
    const input: SchemaFixtureRecord = Object.create(prototypeFields);
    if (schema === CategoryConfigSchema && key !== "description") {
      input.description = "Owned description";
    }
    expect(schema.safeParse(input).success).toBe(false);
  });

  it.each([
    [AgentConfigSchema, "fast"],
    [AgentConfigSchema, "triggers"],
    [CategoryConfigSchema, "description"],
    [WeaveConfigSchema, "agents"],
  ])("rejects %s accessors without executing getters", (schema, key) => {
    let getterExecutions = 0;
    const input: SchemaFixtureRecord = {};
    if (schema === CategoryConfigSchema && key !== "description") {
      input.description = "Owned description";
    }
    Object.defineProperty(input, key, {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return key === "triggers" ? ["unsafe"] : true;
      },
    });

    expect(schema.safeParse(input).success).toBe(false);
    expect(getterExecutions).toBe(0);
  });

  it("rejects callable values without executing getters", () => {
    let getterExecutions = 0;
    function callable(): void {}
    Object.defineProperty(callable, "type", {
      enumerable: true,
      configurable: true,
      get() {
        getterExecutions += 1;
        return "unsafe";
      },
    });

    expect(AgentConfigSchema.safeParse({ models: [callable] }).success).toBe(
      false,
    );
    expect(getterExecutions).toBe(0);
  });

  it("rejects callable proxies before inspecting proxy properties", () => {
    let ownKeysTrapCalls = 0;
    const callable = (): void => {};
    const callableProxy = new Proxy(callable, {
      getPrototypeOf() {
        return Object.prototype;
      },
      ownKeys() {
        ownKeysTrapCalls += 1;
        return [];
      },
    });

    expect(
      AgentConfigSchema.safeParse({ models: [callableProxy] }).success,
    ).toBe(false);
    expect(ownKeysTrapCalls).toBe(0);
  });

  it("rejects unexpected prototypes and unsafe data descriptors", () => {
    class AgentInput {}
    const classInput = new AgentInput();
    Object.defineProperty(classInput, "fast", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(AgentConfigSchema.safeParse(classInput).success).toBe(false);

    const readonlyInput: SchemaFixtureRecord = {};
    Object.defineProperty(readonlyInput, "fast", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: false,
    });
    expect(AgentConfigSchema.safeParse(readonlyInput).success).toBe(false);
  });

  it("accepts own data properties on plain and null-prototype records", () => {
    expect(
      AgentConfigSchema.safeParse({ fast: true, triggers: ["plain"] }).success,
    ).toBe(true);

    const category = emptySchemaFixtureRecord();
    Object.defineProperty(category, "description", {
      value: "Safe category",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(category, "fast", {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(category, "triggers", {
      value: ["safe trigger"],
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const parsed = CategoryConfigSchema.safeParse(category);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe("Safe category");
      expect(parsed.data.triggers).toEqual(["safe trigger"]);
    }
  });
});
