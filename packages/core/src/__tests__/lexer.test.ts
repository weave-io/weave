import { describe, expect, it } from "bun:test";
import {
  CONFIG_ERRORS_TRUNCATED,
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
} from "../config-error-policy.js";
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

  it("tokenizes agent and category fast intent with string triggers", () => {
    const result = tokenize(`agent loom {
  fast true
  triggers ["Plan work", "Review work"]
}
category mini {
  fast true
  triggers ["Bounded changes"]
}`);
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens.filter((token) => token.value === "fast")).toHaveLength(2);
    expect(tokens.filter((token) => token.value === "true")).toHaveLength(2);
    expect(tokens.filter((token) => token.value === "triggers")).toHaveLength(
      2,
    );
    expect(
      tokens
        .filter((token) => token.type === TokenType.String)
        .map((token) => token.value),
    ).toEqual(["Plan work", "Review work", "Bounded changes"]);
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

  it("bounds adversarial lexer diagnostics at the direct boundary", () => {
    const errors = tokenize(
      `1.${"x".repeat(20_000)} ${"@".repeat(100)}`,
    )._unsafeUnwrapErr();
    const size = errors.reduce((total, error) => {
      if (error.type === "InvalidNumber") return total + error.value.length;
      if (error.type === "UnexpectedCharacter")
        return total + error.char.length;
      return total;
    }, 0);

    expect(errors.length).toBeLessThanOrEqual(MAX_CONFIG_ERROR_ISSUES);
    expect(size).toBeLessThanOrEqual(MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE);
    expect(errors).toContainEqual(
      expect.objectContaining({
        type: "InvalidNumber",
        value: expect.stringContaining("[truncated]"),
      }),
    );
    expect(
      errors.every(
        (error) =>
          error.type !== "InvalidNumber" ||
          error.value.length <= MAX_CONFIG_ERROR_FIELD_LENGTH,
      ),
    ).toBe(true);
    expect(JSON.stringify(errors)).toContain(CONFIG_ERRORS_TRUNCATED);
  });

  it("reports correct line for error on second line", () => {
    const result = tokenize("foo\n@");
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]?.line).toBe(2);
  });
});

describe("Lexer — triple-quoted multiline strings", () => {
  const stringValue = (src: string): string => {
    const result = tokenize(src);
    expect(result.isOk()).toBe(true);
    const token = result._unsafeUnwrap()[0];
    expect(token?.type).toBe(TokenType.String);
    return token?.value ?? "";
  };

  it("normalizes CRLF content and dedents on LF boundaries", () => {
    const value = stringValue('"""\r\n  hello\r\n  world\r\n"""');
    expect(value).toBe("hello\nworld");
    expect(value).not.toContain("\r");
  });

  it("normalizes lone CR line endings to LF", () => {
    const value = stringValue('"""\r  hello\r  world\r"""');
    expect(value).toBe("hello\nworld");
    expect(value).not.toContain("\r");
  });

  it("skips exactly one CRLF line break after the opening delimiter", () => {
    expect(stringValue('"""\r\nhello"""')).toBe("hello");
    // A second CRLF becomes a leading blank line, which the blank-line trim
    // removes — the same shape LF sources produce.
    expect(stringValue('"""\r\n\r\nhello"""')).toBe("hello");
  });

  it("skips exactly one LF line break after the opening delimiter", () => {
    expect(stringValue('"""\nhello"""')).toBe("hello");
  });

  it("preserves interior blank lines and trims leading/trailing blank lines", () => {
    expect(stringValue('"""\n\n  first\n\n  second\n\n"""')).toBe(
      "first\n\nsecond",
    );
  });

  it("preserves a blank line that is whitespace-only inside content", () => {
    expect(stringValue('"""\n  first\n   \n  second\n"""')).toBe(
      "first\n \nsecond",
    );
  });

  it("returns an empty value for whitespace-only content", () => {
    expect(stringValue('"""\n   \n\n"""')).toBe("");
  });

  it("dedents tab-indented content by leading whitespace character count", () => {
    expect(stringValue('"""\n\t\thello\n\t\tworld\n"""')).toBe("hello\nworld");
  });

  it("dedents mixed tab/space indentation per character, not per column", () => {
    // "\thello" has 1 leading whitespace character, "  world" has 2, so the
    // common indent is 1 character — a tab counts exactly like a space and is
    // never expanded to a tab stop.
    expect(stringValue('"""\n\thello\n  world\n"""')).toBe("hello\n world");
    expect(stringValue('"""\n    hello\n\tworld\n"""')).toBe("   hello\nworld");
  });

  it("preserves trailing whitespace inside a line", () => {
    expect(stringValue('"""\n  hello  \n  world\n"""')).toBe("hello  \nworld");
  });

  it("reads same-line content verbatim", () => {
    expect(stringValue('"""hello world"""')).toBe("hello world");
  });

  it("treats punctuation, comment markers, and DSL keywords as literal text", () => {
    const src = [
      '"""',
      "# not a comment",
      "agent x {",
      "}",
      'workflow ["a", "b"]',
      'quotes " and "" stay',
      '"""',
    ].join("\n");
    expect(stringValue(src)).toBe(
      [
        "# not a comment",
        "agent x {",
        "}",
        'workflow ["a", "b"]',
        'quotes " and "" stay',
      ].join("\n"),
    );
  });

  it("keeps backslash sequences raw with no escape processing", () => {
    const value = stringValue('"""a\\"b\\\\c\\n\\t\\#"""');
    expect(value).toBe('a\\"b\\\\c\\n\\t\\#');
    // No escape was interpreted: no real newline or tab is present.
    expect(value).not.toContain("\n");
    expect(value).not.toContain("\t");
    expect(value.length).toBe('a\\"b\\\\c\\n\\t\\#'.length);
  });

  it('closes at the first """ even when a backslash precedes it', () => {
    // `"""a\"""` closes at the first """ after the backslash, so the value is
    // the two characters `a\` — the backslash does not extend the string.
    const result = tokenize('"""a\\"""');
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens[0]).toMatchObject({ type: TokenType.String, value: "a\\" });
    expect(tokens[1]).toMatchObject({ type: TokenType.EOF });
  });

  it("closes early when content abuts the delimiter with a trailing quote", () => {
    // `"""abc""""` closes after `abc`; the fourth quote opens a single-line
    // string that never terminates.
    const result = tokenize('"""abc""""');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors[0]).toMatchObject({
      type: "UnterminatedString",
      line: 1,
      column: 10,
    });
  });

  it("reports UnterminatedString at the opening delimiter position", () => {
    const result = tokenize('foo\n  """abc\ndef');
    expect(result.isErr()).toBe(true);
    const errors = result._unsafeUnwrapErr();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "UnterminatedString",
      line: 2,
      column: 3,
    });
  });

  it("keeps line/column correct for the token after a multiline string (LF)", () => {
    const result = tokenize(
      'agent x {\n  prompt """\n  hi\n  """\n  model "m"\n}',
    );
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens.find((t) => t.value === "prompt")).toMatchObject({
      line: 2,
      column: 3,
    });
    expect(tokens.find((t) => t.value === "hi")).toMatchObject({
      type: TokenType.String,
      line: 2,
      column: 10,
    });
    expect(tokens.find((t) => t.value === "model")).toMatchObject({
      line: 5,
      column: 3,
    });
    expect(tokens.find((t) => t.value === "}")).toMatchObject({
      line: 6,
      column: 1,
    });
  });

  it("keeps line/column correct for the token after a multiline string (CRLF)", () => {
    const result = tokenize(
      'agent x {\r\n  prompt """\r\n  hi\r\n  """\r\n  model "m"\r\n}',
    );
    expect(result.isOk()).toBe(true);
    const tokens = result._unsafeUnwrap();
    expect(tokens.find((t) => t.value === "hi")).toMatchObject({
      type: TokenType.String,
      line: 2,
      column: 10,
    });
    expect(tokens.find((t) => t.value === "model")).toMatchObject({
      line: 5,
      column: 3,
    });
    expect(tokens.find((t) => t.value === "}")).toMatchObject({
      line: 6,
      column: 1,
    });
  });

  it("produces identical values for LF and CRLF encodings of the same source", () => {
    const lf = 'agent x {\n  prompt """\n  first\n\n  second\n  """\n}';
    const crlf = lf.replace(/\n/g, "\r\n");
    const values = (src: string): string[] => {
      const result = tokenize(src);
      expect(result.isOk()).toBe(true);
      return result
        ._unsafeUnwrap()
        .filter((t) => t.type === TokenType.String)
        .map((t) => t.value);
    };
    expect(values(lf)).toEqual(["first\n\nsecond"]);
    expect(values(crlf)).toEqual(values(lf));
  });
});
