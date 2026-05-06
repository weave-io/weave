import { describe, expect, it } from "bun:test";
import type {
  ConfigError,
  LexError,
  ParseError,
  ValidationError,
} from "../errors.js";
import { formatError } from "../errors.js";

describe("LexError variants", () => {
  it("UnterminatedString — type discriminant narrows correctly", () => {
    const err: LexError = { type: "UnterminatedString", line: 3, column: 5 };
    expect(err.type).toBe("UnterminatedString");
    if (err.type === "UnterminatedString") {
      expect(err.line).toBe(3);
      expect(err.column).toBe(5);
    }
  });

  it("InvalidNumber — holds value field", () => {
    const err: LexError = {
      type: "InvalidNumber",
      line: 1,
      column: 10,
      value: "1.2.3",
    };
    expect(err.type).toBe("InvalidNumber");
    if (err.type === "InvalidNumber") {
      expect(err.value).toBe("1.2.3");
    }
  });

  it("UnexpectedCharacter — holds char field", () => {
    const err: LexError = {
      type: "UnexpectedCharacter",
      line: 2,
      column: 7,
      char: "@",
    };
    expect(err.type).toBe("UnexpectedCharacter");
    if (err.type === "UnexpectedCharacter") {
      expect(err.char).toBe("@");
    }
  });
});

describe("ParseError variants", () => {
  it("UnexpectedToken — holds found and expected fields", () => {
    const err: ParseError = {
      type: "UnexpectedToken",
      line: 5,
      column: 3,
      found: "}",
      expected: "identifier",
    };
    expect(err.type).toBe("UnexpectedToken");
    if (err.type === "UnexpectedToken") {
      expect(err.found).toBe("}");
      expect(err.expected).toBe("identifier");
    }
  });

  it("MissingBlockName — holds blockType field", () => {
    const err: ParseError = {
      type: "MissingBlockName",
      line: 1,
      column: 1,
      blockType: "agent",
    };
    expect(err.type).toBe("MissingBlockName");
    if (err.type === "MissingBlockName") {
      expect(err.blockType).toBe("agent");
    }
  });

  it("UnclosedBlock — minimal fields", () => {
    const err: ParseError = { type: "UnclosedBlock", line: 10, column: 1 };
    expect(err.type).toBe("UnclosedBlock");
  });
});

describe("ValidationError", () => {
  it("holds path and message", () => {
    const err: ValidationError = {
      type: "ValidationError",
      path: "agents.loom.temperature",
      message: "Number must be less than or equal to 2",
    };
    expect(err.type).toBe("ValidationError");
    expect(err.path).toBe("agents.loom.temperature");
  });

  it("accepts optional line and column", () => {
    const err: ValidationError = {
      type: "ValidationError",
      path: "agents.loom",
      message: "prompt and prompt_file are mutually exclusive",
      line: 3,
      column: 1,
    };
    expect(err.line).toBe(3);
    expect(err.column).toBe(1);
  });
});

describe("ConfigError union type guards", () => {
  it("narrows UnterminatedString variant from ConfigError", () => {
    const err: ConfigError = { type: "UnterminatedString", line: 1, column: 1 };
    if (err.type === "UnterminatedString") {
      expect(err.line).toBe(1);
      expect(err.column).toBe(1);
    } else {
      throw new Error("Should have narrowed to UnterminatedString");
    }
  });

  it("narrows InvalidNumber variant from ConfigError", () => {
    const err: ConfigError = {
      type: "InvalidNumber",
      line: 2,
      column: 4,
      value: "9.9.9",
    };
    if (err.type === "InvalidNumber") {
      expect(err.value).toBe("9.9.9");
    } else {
      throw new Error("Should have narrowed to InvalidNumber");
    }
  });

  it("narrows UnclosedBlock variant from ConfigError", () => {
    const err: ConfigError = { type: "UnclosedBlock", line: 5, column: 1 };
    if (err.type === "UnclosedBlock") {
      expect(err.line).toBe(5);
    } else {
      throw new Error("Should have narrowed to UnclosedBlock");
    }
  });

  it("narrows ValidationError variant from ConfigError", () => {
    const err: ConfigError = {
      type: "ValidationError",
      path: "x",
      message: "bad",
    };
    if (err.type === "ValidationError") {
      expect(err.path).toBe("x");
      expect(err.message).toBe("bad");
    } else {
      throw new Error("Should have narrowed to ValidationError");
    }
  });
});

describe("formatError", () => {
  it("formats UnterminatedString", () => {
    const result = formatError({
      type: "UnterminatedString",
      line: 3,
      column: 5,
    });
    expect(result).toBe("3:5: unterminated string literal");
  });

  it("formats InvalidNumber", () => {
    const result = formatError({
      type: "InvalidNumber",
      line: 1,
      column: 10,
      value: "1.2.3",
    });
    expect(result).toBe("1:10: invalid number literal '1.2.3'");
  });

  it("formats UnexpectedCharacter", () => {
    const result = formatError({
      type: "UnexpectedCharacter",
      line: 2,
      column: 7,
      char: "@",
    });
    expect(result).toBe("2:7: unexpected character '@'");
  });

  it("formats UnexpectedToken", () => {
    const result = formatError({
      type: "UnexpectedToken",
      line: 5,
      column: 3,
      found: "}",
      expected: "identifier",
    });
    expect(result).toBe("5:3: unexpected token '}', expected identifier");
  });

  it("formats MissingBlockName", () => {
    const result = formatError({
      type: "MissingBlockName",
      line: 1,
      column: 1,
      blockType: "agent",
    });
    expect(result).toBe("1:1: missing name for 'agent' block");
  });

  it("formats UnclosedBlock", () => {
    const result = formatError({ type: "UnclosedBlock", line: 10, column: 1 });
    expect(result).toBe("10:1: unclosed block");
  });

  it("formats ValidationError with path and no location", () => {
    const result = formatError({
      type: "ValidationError",
      path: "agents.loom.temperature",
      message: "too high",
    });
    expect(result).toBe("[agents.loom.temperature] too high");
  });

  it("formats ValidationError with location", () => {
    const result = formatError({
      type: "ValidationError",
      path: "agents.loom",
      message: "invalid",
      line: 3,
      column: 1,
    });
    expect(result).toBe("3:1: [agents.loom] invalid");
  });

  it("formats ValidationError with empty path", () => {
    const result = formatError({
      type: "ValidationError",
      path: "",
      message: "global error",
    });
    expect(result).toBe("global error");
  });
});
