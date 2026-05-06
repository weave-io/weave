import { describe, it, expect } from "bun:test";
import { tokenize } from "../lexer.js";
import { TokenType } from "../tokens.js";

describe("Lexer — valid tokenization", () => {
  it("tokenizes a simple agent block", () => {
    const result = tokenize("agent loom { temperature 0.1 }");
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    const types = tokens.map((t) => t.type);
    expect(types).toContain(TokenType.Identifier); // "agent"
    expect(tokens[0]).toMatchObject({
      type: TokenType.Identifier,
      value: "agent",
    });
    expect(tokens[1]).toMatchObject({
      type: TokenType.Identifier,
      value: "loom",
    });
    expect(tokens[2]).toMatchObject({ type: TokenType.LBrace });
    expect(tokens[3]).toMatchObject({
      type: TokenType.Identifier,
      value: "temperature",
    });
    expect(tokens[4]).toMatchObject({ type: TokenType.Number, value: "0.1" });
    expect(tokens[5]).toMatchObject({ type: TokenType.RBrace });
  });

  it("tokenizes double-quoted strings", () => {
    const result = tokenize('"hello world"');
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[0]).toMatchObject({
      type: TokenType.String,
      value: "hello world",
    });
  });

  it("tokenizes triple-quoted strings and strips indentation", () => {
    const src = `"""
      hello
      world
    """`;
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const token = result._unsafeUnwrap()[0];
    expect(token?.type).toBe(TokenType.String);
    // trimIndent strips the 6-space common indent → "hello\nworld"
    expect(token?.value).toBe("hello\nworld");
    // Also verify it's multi-line and not indented
    expect(token?.value).toContain("hello");
    expect(token?.value).toContain("world");
    expect(token?.value.startsWith(" ")).toBe(false);
  });

  it("tokenizes integer numbers", () => {
    const result = tokenize("42");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0]).toMatchObject({
      type: TokenType.Number,
      value: "42",
    });
  });

  it("tokenizes float numbers", () => {
    const result = tokenize("0.1");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0]).toMatchObject({
      type: TokenType.Number,
      value: "0.1",
    });
  });

  it("tokenizes zero", () => {
    const result = tokenize("0");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()[0]).toMatchObject({
      type: TokenType.Number,
      value: "0",
    });
  });

  it("tokenizes boolean identifiers as Identifier tokens", () => {
    for (const kw of ["true", "false", "allow", "deny", "ask", "primary"]) {
      const result = tokenize(kw);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()[0]).toMatchObject({
        type: TokenType.Identifier,
        value: kw,
      });
    }
  });

  it("skips line comments and tokenizes the next line", () => {
    const src = `# this is a comment\nfoo`;
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    // Should have Newline, Identifier("foo"), EOF — no comment token
    expect(tokens.some((t) => t.value === "foo")).toBe(true);
    expect(tokens.every((t) => t.value !== "# this is a comment")).toBe(true);
  });

  it("tokenizes an array", () => {
    const result = tokenize('["a", "b"]');
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[0]).toMatchObject({ type: TokenType.LBracket });
    expect(tokens[1]).toMatchObject({ type: TokenType.String, value: "a" });
    expect(tokens[2]).toMatchObject({ type: TokenType.Comma });
    expect(tokens[3]).toMatchObject({ type: TokenType.String, value: "b" });
    expect(tokens[4]).toMatchObject({ type: TokenType.RBracket });
  });

  it("tokenizes nested braces", () => {
    const src = `tool_policy { read allow }`;
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[1]).toMatchObject({ type: TokenType.LBrace });
    expect(tokens[4]).toMatchObject({ type: TokenType.RBrace });
  });

  it("collapses multiple blank lines into a single Newline token", () => {
    const src = "a\n\n\n\nb";
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    const newlines = tokens.filter((t) => t.type === TokenType.Newline);
    expect(newlines.length).toBe(1);
  });

  it("records correct line and column for tokens", () => {
    const src = `agent loom`;
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[0]).toMatchObject({ line: 1, column: 1 });
    expect(tokens[1]).toMatchObject({ line: 1, column: 7 });
  });

  it("handles trailing commas in arrays naturally", () => {
    const result = tokenize('["a", "b",]');
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    // LBracket, String, Comma, String, Comma, RBracket, EOF
    expect(tokens[0]).toMatchObject({ type: TokenType.LBracket });
    expect(tokens[4]).toMatchObject({ type: TokenType.Comma });
    expect(tokens[5]).toMatchObject({ type: TokenType.RBracket });
  });

  it("emits EOF as last token", () => {
    const result = tokenize("foo");
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[tokens.length - 1]).toMatchObject({ type: TokenType.EOF });
  });
});

describe("Lexer — errors", () => {
  it("reports UnterminatedString for unclosed double-quoted string", () => {
    const result = tokenize('"hello');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.type).toBe("UnterminatedString");
    expect(errors[0]?.line).toBe(1);
    expect(errors[0]?.column).toBe(1);
  });

  it("reports UnexpectedCharacter for @", () => {
    const result = tokenize("@");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]?.type).toBe("UnexpectedCharacter");
    if (errors[0]?.type === "UnexpectedCharacter") {
      expect(errors[0].char).toBe("@");
    }
  });

  it("collects multiple errors — does not stop at first", () => {
    const result = tokenize('@\n"unterminated');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const types = errors.map((e) => e.type);
    expect(types).toContain("UnexpectedCharacter");
    expect(types).toContain("UnterminatedString");
  });

  it("reports correct line for error on second line", () => {
    const result = tokenize("foo\n@");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]?.line).toBe(2);
  });
});
