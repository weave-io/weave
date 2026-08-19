import { describe, expect, it } from "bun:test";
import { MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE } from "../config-error-policy.js";
import { tokenize } from "../lexer.js";
import { MAX_PARSER_TOKEN_COUNT, parse } from "../parser.js";
import { MAX_CONFIG_ARRAY_LENGTH } from "../schema-common.js";
import { type Token, TokenType } from "../tokens.js";

type ParseResult = ReturnType<typeof parse>;

function parseSource(source: string): ParseResult {
  const lexed = tokenize(source);
  if (lexed.isErr()) {
    throw new Error(`Lex errors: ${JSON.stringify(lexed.error)}`);
  }
  return parse(lexed.value);
}

function parseFailure(result: ParseResult) {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error(`Expected parse failure: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

function withObjectPrototypeSetter<T>(
  key: string,
  onSet: () => void,
  body: () => T,
): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  try {
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      set() {
        onSet();
      },
    });
    return body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(Object.prototype, key);
    else Object.defineProperty(Object.prototype, key, previous);
  }
}

describe("Parser — hostile token boundary", () => {
  it("rejects token accessors without executing throwing getters", () => {
    let getterExecutions = 0;
    const identifier: Token = {
      type: TokenType.Identifier,
      value: "agent",
      line: 1,
      column: 1,
    };
    Object.defineProperty(identifier, "value", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        throw new Error("token getter must not run");
      },
    });

    const eof: Token = {
      type: TokenType.EOF,
      value: "",
      line: 1,
      column: 2,
    };
    const result = parse([identifier, eof]);

    expect(result.isErr()).toBe(true);
    expect(getterExecutions).toBe(0);
    if (result.isErr()) {
      expect(result.error).toEqual([
        {
          type: "UnexpectedToken",
          line: 0,
          column: 0,
          found: "[invalid token stream]",
          expected: "valid token stream",
        },
      ]);
    }
  });

  it("returns a bounded typed error for malformed token shapes", () => {
    const malformed: Token[] = [
      {
        type: TokenType.Identifier,
        value: "",
        line: -1,
        column: Number.NaN,
      },
      {
        type: TokenType.EOF,
        value: "",
        line: 1,
        column: 1,
      },
    ];

    const result = parse(malformed);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toHaveLength(1);
      expect(result.error[0]?.type).toBe("UnexpectedToken");
      expect(JSON.stringify(result.error).length).toBeLessThan(512);
    }
  });

  it("rejects sparse, cyclic, callable, and unexpected token graphs", () => {
    const eof: Token = {
      type: TokenType.EOF,
      value: "",
      line: 1,
      column: 1,
    };

    const sparse: Token[] = [];
    sparse.length = 1;
    const cycle: Token[] = [];
    Object.defineProperty(cycle, "0", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cycle,
    });
    Object.defineProperty(cycle, "1", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: eof,
    });
    cycle.length = 2;
    const callable = (): void => {};
    const callableTokens: Token[] = [];
    Object.defineProperty(callableTokens, "0", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: callable,
    });
    Object.defineProperty(callableTokens, "1", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: eof,
    });
    callableTokens.length = 2;
    class UnexpectedTokenGraph {
      type = TokenType.EOF;
      value = "";
      line = 1;
      column = 1;
    }
    const unexpected = new UnexpectedTokenGraph();

    for (const tokens of [sparse, cycle, callableTokens, [unexpected]]) {
      const result = parse(tokens);
      expect(result.isErr()).toBe(true);
    }
  });
});

describe("Parser — output setter boundary", () => {
  it("preserves workflow extends without invoking an inherited setter", () => {
    let setterExecutions = 0;
    const parsed = withObjectPrototypeSetter(
      "extends",
      () => {
        setterExecutions += 1;
      },
      () => parseSource('workflow flow { version 1 extends "base" }'),
    );

    expect(setterExecutions).toBe(0);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      const workflow = parsed.value[0];
      expect(workflow?.type).toBe("workflow");
      if (workflow?.type === "workflow") {
        expect(workflow.extends).toBe("base");
        expect(Object.hasOwn(workflow, "extends")).toBe(true);
      }
    }
  });

  it("preserves step insertion fields without invoking inherited setters", () => {
    let setterExecutions = 0;
    const parsed = withObjectPrototypeSetter(
      "insert_before",
      () => {
        setterExecutions += 1;
      },
      () => parseSource('workflow flow { step run { insert_before "base" } }'),
    );

    expect(setterExecutions).toBe(0);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      const workflow = parsed.value[0];
      expect(workflow?.type).toBe("workflow");
      if (workflow?.type === "workflow") {
        expect(workflow.steps[0]?.insert_before).toBe("base");
      }
    }
  });

  it("parses valid tokens without invoking inherited numeric setters", () => {
    const validTokens: Token[] = [
      { type: TokenType.Identifier, value: "agent", line: 1, column: 1 },
      {
        type: TokenType.Identifier,
        value: "helper",
        line: 1,
        column: 7,
      },
      { type: TokenType.LBrace, value: "{", line: 1, column: 14 },
      { type: TokenType.RBrace, value: "}", line: 1, column: 15 },
      { type: TokenType.EOF, value: "", line: 1, column: 16 },
    ];
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    let parsed: ParseResult | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set() {
          setterExecutions += 1;
        },
      });
      parsed = parse(validTokens);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }

    expect(setterExecutions).toBe(0);
    expect(parsed?.isOk()).toBe(true);
    if (parsed?.isOk()) {
      expect(parsed.value).toHaveLength(1);
      expect(parsed.value[0]?.type).toBe("agent");
    }
  });

  it("bounds parser diagnostics without invoking a throwing numeric setter", () => {
    const hostileTokens: Token[] = [];
    for (let index = 0; index < 100; index += 1) {
      hostileTokens.push({
        type: TokenType.RBrace,
        value: "}",
        line: 1,
        column: index + 1,
      });
    }
    hostileTokens.push({
      type: TokenType.EOF,
      value: "",
      line: 1,
      column: 101,
    });

    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    let parsed: ParseResult | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set() {
          setterExecutions += 1;
          throw new Error("parser diagnostic setter must not run");
        },
      });
      expect(() => {
        parsed = parse(hostileTokens);
      }).not.toThrow();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", previous);
    }

    expect(setterExecutions).toBe(0);
    expect(parsed?.isErr()).toBe(true);
    if (parsed?.isErr()) {
      expect(parsed.error.length).toBeLessThanOrEqual(32);
      expect(
        parsed.error.every((error) => error.type === "UnexpectedToken"),
      ).toBe(true);
    }
  });
});

describe("Parser — token snapshot budget", () => {
  it("parses 120 minimal agent blocks through the lexer boundary", () => {
    const source = Array.from(
      { length: 120 },
      (_, index) => `agent agent_${index} {}`,
    ).join("\n");
    const lexed = tokenize(source);

    expect(lexed.isOk()).toBe(true);
    if (lexed.isErr()) return;

    const parsed = parse(lexed.value);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) expect(parsed.value).toHaveLength(120);
  });

  it("accepts a valid token stream below the owner snapshot limit", () => {
    const source = Array.from(
      { length: 120 },
      (_, index) => `agent agent_${index} {}`,
    ).join("\n");
    const lexed = tokenize(source);

    expect(lexed.isOk()).toBe(true);
    if (lexed.isErr()) return;
    expect(lexed.value.length).toBeLessThan(MAX_PARSER_TOKEN_COUNT);

    const parsed = parse(lexed.value);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) expect(parsed.value).toHaveLength(120);
  });

  it("returns a typed bounded error above the parser snapshot limit", () => {
    // The count check runs before graph copying, so a sparse length-only
    // fixture proves the limit without allocating millions of token objects.
    const overLimit: Token[] = [];
    overLimit.length = MAX_PARSER_TOKEN_COUNT + 1;

    const parsed = parse(overLimit);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error).toEqual([
        {
          type: "UnexpectedToken",
          line: 0,
          column: 0,
          found: "[token stream exceeds parser limit]",
          expected: `at most ${MAX_PARSER_TOKEN_COUNT} tokens`,
        },
      ]);
      expect(JSON.stringify(parsed.error).length).toBeLessThan(512);
    }
  });
});

describe("Parser — bounded configuration arrays", () => {
  const sourceWithModels = (count: number): string => {
    const models = Array.from({ length: count }, (_, index) =>
      JSON.stringify(`model-${index}`),
    ).join(", ");
    return `agent helper { models [${models}] }`;
  };

  it("accepts 512 model items at the parser boundary", () => {
    const parsed = parseSource(sourceWithModels(MAX_CONFIG_ARRAY_LENGTH));
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      const agent = parsed.value[0];
      expect(agent?.type).toBe("agent");
      if (agent?.type === "agent") {
        const models = agent.properties.find(
          (property) => property.key === "models",
        );
        expect(models?.value.kind).toBe("array");
        if (models?.value.kind === "array") {
          expect(models.value.elements).toHaveLength(MAX_CONFIG_ARRAY_LENGTH);
        }
      }
    }
  });

  it("rejects 513 model items with a bounded typed diagnostic", () => {
    const errors = parseFailure(
      parseSource(sourceWithModels(MAX_CONFIG_ARRAY_LENGTH + 1)),
    );

    expect(errors).toContainEqual({
      type: "UnexpectedToken",
      line: expect.any(Number),
      column: expect.any(Number),
      found: "[array item limit exceeded]",
      expected: `at most ${MAX_CONFIG_ARRAY_LENGTH} array items`,
    });
    expect(JSON.stringify(errors).length).toBeLessThanOrEqual(
      MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
    );
  });
});
