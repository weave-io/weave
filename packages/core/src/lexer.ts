/**
 * Lexer for `.weave` source files.
 *
 * Converts raw source text into a flat `Token[]` stream.
 * All errors are collected and returned together — the lexer never throws.
 */

import { err, ok, type Result } from "neverthrow";
import type { LexError } from "./errors.js";
import { type Token, TokenType } from "./tokens.js";

export class Lexer {
  readonly #source: string;
  #pos = 0;
  #line = 1;
  #col = 1;

  constructor(source: string) {
    this.#source = source;
  }

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  #peek(offset = 0): string {
    return this.#source[this.#pos + offset] ?? "";
  }

  #advance(): string {
    const ch = this.#source[this.#pos] ?? "";
    this.#pos++;
    if (ch === "\n") {
      this.#line++;
      this.#col = 1;
    } else {
      this.#col++;
    }
    return ch;
  }

  /** Skip spaces and tabs only. Newlines are significant tokens. */
  #skipWhitespace(): void {
    while (this.#pos < this.#source.length) {
      const ch = this.#peek();
      if (ch !== " " && ch !== "\t" && ch !== "\r") break;
      this.#advance();
    }
  }

  /** Read a double-quoted string. Returns the inner value or an error. */
  #readString(startLine: number, startCol: number): Result<string, LexError> {
    // consume opening "
    this.#advance();
    let value = "";
    while (this.#pos < this.#source.length) {
      const ch = this.#peek();
      if (ch === "\n" || ch === "") break;
      if (ch === "\\") {
        this.#advance(); // consume backslash
        const escaped = this.#advance();
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          default:
            value += escaped;
        }
        continue;
      }
      if (ch === '"') {
        this.#advance(); // consume closing "
        return ok(value);
      }
      value += ch;
      this.#advance();
    }
    return err({
      type: "UnterminatedString",
      line: startLine,
      column: startCol,
    });
  }

  /**
   * Read a triple-quoted string `""" ... """`.
   * Strips common leading whitespace from all non-empty lines (trimIndent semantics).
   */
  #readTripleQuotedString(
    startLine: number,
    startCol: number,
  ): Result<string, LexError> {
    // consume the three opening quotes
    this.#advance();
    this.#advance();
    this.#advance();

    // skip optional leading newline immediately after opening """
    if (this.#peek() === "\n") this.#advance();

    let raw = "";
    while (this.#pos < this.#source.length) {
      if (
        this.#peek(0) === '"' &&
        this.#peek(1) === '"' &&
        this.#peek(2) === '"'
      ) {
        // consume closing """
        this.#advance();
        this.#advance();
        this.#advance();
        return ok(trimIndent(raw));
      }
      raw += this.#advance();
    }
    return err({
      type: "UnterminatedString",
      line: startLine,
      column: startCol,
    });
  }

  /** Read a numeric literal (integer or float). */
  #readNumber(startLine: number, startCol: number): Result<string, LexError> {
    let value = "";
    let dotCount = 0;
    while (this.#pos < this.#source.length) {
      const ch = this.#peek();
      if (ch === ".") {
        dotCount++;
        if (dotCount > 1) {
          // consume the rest of the bad token
          while (/[\d.]/.test(this.#peek())) this.#advance();
          return err({
            type: "InvalidNumber",
            line: startLine,
            column: startCol,
            value: `${value}.`,
          });
        }
        value += ch;
        this.#advance();
        continue;
      }
      if (!/\d/.test(ch)) break;
      value += ch;
      this.#advance();
    }
    return ok(value);
  }

  /** Read an identifier (keyword, bare enum value, boolean, etc.) */
  #readIdentifier(): string {
    let value = "";
    while (this.#pos < this.#source.length) {
      const ch = this.#peek();
      if (/[a-zA-Z0-9_-]/.test(ch)) {
        value += ch;
        this.#advance();
      } else {
        break;
      }
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  tokenize(): Result<Token[], LexError[]> {
    const tokens: Token[] = [];
    const errors: LexError[] = [];
    let lastWasNewline = false;

    while (this.#pos < this.#source.length) {
      this.#skipWhitespace();

      if (this.#pos >= this.#source.length) break;

      const ch = this.#peek();
      const line = this.#line;
      const col = this.#col;

      // --- comment ---
      if (ch === "#") {
        while (this.#pos < this.#source.length && this.#peek() !== "\n") {
          this.#advance();
        }
        continue;
      }

      // --- newline ---
      if (ch === "\n") {
        this.#advance();
        if (!lastWasNewline) {
          tokens.push({
            type: TokenType.Newline,
            value: "\n",
            line,
            column: col,
          });
          lastWasNewline = true;
        }
        continue;
      }

      lastWasNewline = false;

      // --- triple-quoted string ---
      if (ch === '"' && this.#peek(1) === '"' && this.#peek(2) === '"') {
        const result = this.#readTripleQuotedString(line, col);
        if (result.isErr()) {
          errors.push(result.error);
        } else {
          tokens.push({
            type: TokenType.String,
            value: result.value,
            line,
            column: col,
          });
        }
        continue;
      }

      // --- double-quoted string ---
      if (ch === '"') {
        const result = this.#readString(line, col);
        if (result.isErr()) {
          errors.push(result.error);
        } else {
          tokens.push({
            type: TokenType.String,
            value: result.value,
            line,
            column: col,
          });
        }
        continue;
      }

      // --- number ---
      if (/\d/.test(ch)) {
        const result = this.#readNumber(line, col);
        if (result.isErr()) {
          errors.push(result.error);
        } else {
          tokens.push({
            type: TokenType.Number,
            value: result.value,
            line,
            column: col,
          });
        }
        continue;
      }

      // --- single-char punctuation ---
      if (ch === "{") {
        this.#advance();
        tokens.push({ type: TokenType.LBrace, value: "{", line, column: col });
        continue;
      }
      if (ch === "}") {
        this.#advance();
        tokens.push({ type: TokenType.RBrace, value: "}", line, column: col });
        continue;
      }
      if (ch === "[") {
        this.#advance();
        tokens.push({
          type: TokenType.LBracket,
          value: "[",
          line,
          column: col,
        });
        continue;
      }
      if (ch === "]") {
        this.#advance();
        tokens.push({
          type: TokenType.RBracket,
          value: "]",
          line,
          column: col,
        });
        continue;
      }
      if (ch === ",") {
        this.#advance();
        tokens.push({ type: TokenType.Comma, value: ",", line, column: col });
        continue;
      }

      // --- identifier ---
      if (/[a-zA-Z_]/.test(ch)) {
        const value = this.#readIdentifier();
        tokens.push({ type: TokenType.Identifier, value, line, column: col });
        continue;
      }

      // --- unknown ---
      this.#advance();
      errors.push({ type: "UnexpectedCharacter", line, column: col, char: ch });
    }

    tokens.push({
      type: TokenType.EOF,
      value: "",
      line: this.#line,
      column: this.#col,
    });

    if (errors.length > 0) return err(errors);
    return ok(tokens);
  }
}

// ---------------------------------------------------------------------------
// Standalone function
// ---------------------------------------------------------------------------

/**
 * Tokenizes a `.weave` source string into a `Token[]` stream.
 * Collects all lex errors and returns them together.
 */
export function tokenize(source: string): Result<Token[], LexError[]> {
  return new Lexer(source).tokenize();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips the common leading whitespace from all non-empty lines.
 * Equivalent to Kotlin's `trimIndent()`.
 */
function trimIndent(raw: string): string {
  const lines = raw.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return raw.trim();

  const minIndent = nonEmpty.reduce((min, line) => {
    const leading = line.match(/^(\s*)/)?.[1].length ?? 0;
    return Math.min(min, leading);
  }, Infinity);

  const stripped = lines.map((l) => l.slice(minIndent));

  // trim leading/trailing blank lines
  let start = 0;
  let end = stripped.length;
  while (start < end && stripped[start]?.trim() === "") start++;
  while (end > start && stripped[end - 1]?.trim() === "") end--;
  return stripped.slice(start, end).join("\n");
}
