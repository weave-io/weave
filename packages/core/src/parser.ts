/**
 * Recursive-descent parser for `.weave` token streams.
 *
 * Consumes a `Token[]` produced by the Lexer and builds an `AstNode[]`.
 * Errors are accumulated and returned together — the parser recovers
 * after each bad construct by skipping to the next safe boundary.
 */

import { ok, err, type Result } from "neverthrow";
import type { ParseError } from "./errors.js";
import { type Token, TokenType } from "./tokens.js";
import type { SourcePos } from "./tokens.js";
import type {
  AstNode,
  AstValue,
  Property,
  AgentBlock,
  CategoryBlock,
  WorkflowBlock,
  DisableDirective,
  SettingAssignment,
  StepBlock,
  StringValue,
  NumberValue,
  BooleanValue,
  IdentifierValue,
  ArrayValue,
  BlockValue,
} from "./ast.js";

export class Parser {
  readonly #tokens: Token[];
  #cursor = 0;
  readonly #errors: ParseError[] = [];

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  #current(): Token {
    return (
      this.#tokens[this.#cursor] ?? {
        type: TokenType.EOF,
        value: "",
        line: 0,
        column: 0,
      }
    );
  }

  #peek(offset = 0): Token {
    return (
      this.#tokens[this.#cursor + offset] ?? {
        type: TokenType.EOF,
        value: "",
        line: 0,
        column: 0,
      }
    );
  }

  #advance(): Token {
    const token = this.#current();
    if (token.type !== TokenType.EOF) this.#cursor++;
    return token;
  }

  /** Consume a token of the expected type (and optional value). Returns it or records an error. */
  #expect(type: TokenType, value?: string): Token | null {
    const token = this.#current();
    if (token.type === type && (value === undefined || token.value === value)) {
      this.#advance();
      return token;
    }
    const expected = value ? `'${value}'` : type;
    this.#errors.push({
      type: "UnexpectedToken",
      line: token.line,
      column: token.column,
      found: token.value || token.type,
      expected,
    });
    return null;
  }

  #skipNewlines(): void {
    while (this.#current().type === TokenType.Newline) {
      this.#advance();
    }
  }

  #pos(): SourcePos {
    const t = this.#current();
    return { line: t.line, column: t.column };
  }

  // ---------------------------------------------------------------------------
  // Error recovery — skip to next safe boundary
  // ---------------------------------------------------------------------------

  #skipToNextBoundary(): void {
    while (true) {
      const t = this.#current();
      if (
        t.type === TokenType.EOF ||
        t.type === TokenType.Newline ||
        t.type === TokenType.RBrace
      )
        break;
      this.#advance();
    }
  }

  // ---------------------------------------------------------------------------
  // Top-level dispatch
  // ---------------------------------------------------------------------------

  #parseTopLevel(): AstNode | null {
    this.#skipNewlines();
    const token = this.#current();

    if (token.type === TokenType.EOF) return null;

    if (token.type !== TokenType.Identifier) {
      this.#errors.push({
        type: "UnexpectedToken",
        line: token.line,
        column: token.column,
        found: token.value || token.type,
        expected: "keyword or identifier",
      });
      this.#skipToNextBoundary();
      return null;
    }

    switch (token.value) {
      case "agent":
        return this.#parseNamedBlock("agent");
      case "category":
        return this.#parseNamedBlock("category");
      case "workflow":
        return this.#parseWorkflowBlock();
      case "disable":
        return this.#parseDisableDirective();
      default:
        return this.#parseSettingAssignment();
    }
  }

  // ---------------------------------------------------------------------------
  // Block parsers
  // ---------------------------------------------------------------------------

  #parseNamedBlock(blockType: "agent"): AgentBlock | null;
  #parseNamedBlock(blockType: "category"): CategoryBlock | null;
  #parseNamedBlock(blockType: string): AgentBlock | CategoryBlock | null {
    const startTok = this.#advance(); // consume 'agent' / 'category'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const nameTok = this.#current();

    if (nameTok.type !== TokenType.Identifier) {
      this.#errors.push({
        type: "MissingBlockName",
        line: nameTok.line,
        column: nameTok.column,
        blockType,
      });
      this.#skipToNextBoundary();
      return null;
    }

    const name = nameTok.value;
    this.#advance(); // consume name

    this.#skipNewlines();
    if (!this.#expect(TokenType.LBrace)) {
      this.#skipToNextBoundary();
      return null;
    }

    const properties = this.#parseProperties();

    this.#skipNewlines();
    // Expect closing brace
    if (this.#current().type !== TokenType.RBrace) {
      this.#errors.push({
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
      // skip to EOF-safe position
      while (
        this.#current().type !== TokenType.RBrace &&
        this.#current().type !== TokenType.EOF
      ) {
        this.#advance();
      }
    }
    if (this.#current().type === TokenType.RBrace) this.#advance();

    if (blockType === "agent") return { type: "agent", name, properties, pos };
    return { type: "category", name, properties, pos };
  }

  #parseWorkflowBlock(): WorkflowBlock | null {
    const startTok = this.#advance(); // consume 'workflow'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const nameTok = this.#current();

    if (nameTok.type !== TokenType.Identifier) {
      this.#errors.push({
        type: "MissingBlockName",
        line: nameTok.line,
        column: nameTok.column,
        blockType: "workflow",
      });
      this.#skipToNextBoundary();
      return null;
    }

    const name = nameTok.value;
    this.#advance();

    this.#skipNewlines();
    if (!this.#expect(TokenType.LBrace)) {
      this.#skipToNextBoundary();
      return null;
    }

    const properties: Property[] = [];
    const steps: StepBlock[] = [];

    while (true) {
      this.#skipNewlines();
      const cur = this.#current();
      if (cur.type === TokenType.RBrace || cur.type === TokenType.EOF) break;

      if (cur.type === TokenType.Identifier && cur.value === "step") {
        const step = this.#parseStepBlock();
        if (step) steps.push(step);
        continue;
      }

      const prop = this.#parseProperty();
      if (prop) properties.push(prop);
    }

    if (this.#current().type !== TokenType.RBrace) {
      this.#errors.push({
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
    } else {
      this.#advance();
    }

    return { type: "workflow", name, properties, steps, pos };
  }

  #parseStepBlock(): StepBlock | null {
    const startTok = this.#advance(); // consume 'step'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const nameTok = this.#current();

    if (nameTok.type !== TokenType.Identifier) {
      this.#errors.push({
        type: "MissingBlockName",
        line: nameTok.line,
        column: nameTok.column,
        blockType: "step",
      });
      this.#skipToNextBoundary();
      return null;
    }

    const name = nameTok.value;
    this.#advance();

    this.#skipNewlines();
    if (!this.#expect(TokenType.LBrace)) {
      this.#skipToNextBoundary();
      return null;
    }

    const properties = this.#parseProperties();

    this.#skipNewlines();
    if (this.#current().type !== TokenType.RBrace) {
      this.#errors.push({
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
    } else {
      this.#advance();
    }

    return { name, properties, pos };
  }

  #parseDisableDirective(): DisableDirective | null {
    const startTok = this.#advance(); // consume 'disable'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const targetTok = this.#current();

    if (
      targetTok.type !== TokenType.Identifier ||
      !["agents", "hooks", "skills"].includes(targetTok.value)
    ) {
      this.#errors.push({
        type: "UnexpectedToken",
        line: targetTok.line,
        column: targetTok.column,
        found: targetTok.value || targetTok.type,
        expected: "agents | hooks | skills",
      });
      this.#skipToNextBoundary();
      return null;
    }

    const target = targetTok.value as "agents" | "hooks" | "skills";
    this.#advance();

    this.#skipNewlines();
    const arrayValue = this.#parseArrayLiteral();
    if (!arrayValue) return null;

    const items = arrayValue.elements
      .filter(
        (el): el is StringValue | IdentifierValue =>
          el.kind === "string" || el.kind === "identifier",
      )
      .map((el) => el.value);

    return { type: "disable", target, items, pos };
  }

  #parseSettingAssignment(): SettingAssignment | null {
    const keyTok = this.#advance();
    const pos: SourcePos = { line: keyTok.line, column: keyTok.column };

    this.#skipNewlines();
    const value = this.#parseValue();
    if (!value) return null;

    return { type: "setting", key: keyTok.value, value, pos };
  }

  // ---------------------------------------------------------------------------
  // Property / Value parsers
  // ---------------------------------------------------------------------------

  #parseProperties(): Property[] {
    const properties: Property[] = [];

    while (true) {
      this.#skipNewlines();
      const cur = this.#current();
      if (cur.type === TokenType.RBrace || cur.type === TokenType.EOF) break;

      const prop = this.#parseProperty();
      if (prop) properties.push(prop);
    }

    return properties;
  }

  #parseProperty(): Property | null {
    const keyTok = this.#current();

    if (keyTok.type !== TokenType.Identifier) {
      this.#errors.push({
        type: "UnexpectedToken",
        line: keyTok.line,
        column: keyTok.column,
        found: keyTok.value || keyTok.type,
        expected: "property key (identifier)",
      });
      this.#skipToNextBoundary();
      return null;
    }

    this.#advance(); // consume key
    const pos: SourcePos = { line: keyTok.line, column: keyTok.column };

    // Allow optional newline between key and value (block-style sub-keys)
    this.#skipNewlines();

    const value = this.#parseValue();
    if (!value) return null;

    return { key: keyTok.value, value, pos };
  }

  #parseValue(): AstValue | null {
    this.#skipNewlines();
    const token = this.#current();

    if (token.type === TokenType.String) {
      this.#advance();
      return {
        kind: "string",
        value: token.value,
        pos: { line: token.line, column: token.column },
      } satisfies StringValue;
    }

    if (token.type === TokenType.Number) {
      this.#advance();
      return {
        kind: "number",
        value: parseFloat(token.value),
        pos: { line: token.line, column: token.column },
      } satisfies NumberValue;
    }

    if (token.type === TokenType.Identifier) {
      this.#advance();
      if (token.value === "true") {
        return {
          kind: "boolean",
          value: true,
          pos: { line: token.line, column: token.column },
        } satisfies BooleanValue;
      }
      if (token.value === "false") {
        return {
          kind: "boolean",
          value: false,
          pos: { line: token.line, column: token.column },
        } satisfies BooleanValue;
      }
      return {
        kind: "identifier",
        value: token.value,
        pos: { line: token.line, column: token.column },
      } satisfies IdentifierValue;
    }

    if (token.type === TokenType.LBracket) {
      return this.#parseArrayLiteral();
    }

    if (token.type === TokenType.LBrace) {
      return this.#parseBlockLiteral();
    }

    this.#errors.push({
      type: "UnexpectedToken",
      line: token.line,
      column: token.column,
      found: token.value || token.type,
      expected: "value (string, number, identifier, [ or {)",
    });
    this.#skipToNextBoundary();
    return null;
  }

  #parseArrayLiteral(): ArrayValue | null {
    const startTok = this.#advance(); // consume '['
    const pos: SourcePos = { line: startTok.line, column: startTok.column };
    const elements: AstValue[] = [];

    this.#skipNewlines();

    while (
      this.#current().type !== TokenType.RBracket &&
      this.#current().type !== TokenType.EOF
    ) {
      const el = this.#parseValue();
      if (el) elements.push(el);

      this.#skipNewlines();

      // optional comma
      if (this.#current().type === TokenType.Comma) {
        this.#advance();
        this.#skipNewlines();
      }
    }

    if (this.#current().type !== TokenType.RBracket) {
      this.#errors.push({
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
      return null;
    }

    this.#advance(); // consume ']'
    return { kind: "array", elements, pos } satisfies ArrayValue;
  }

  #parseBlockLiteral(): BlockValue | null {
    const startTok = this.#advance(); // consume '{'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    const properties = this.#parseProperties();

    this.#skipNewlines();
    if (this.#current().type !== TokenType.RBrace) {
      this.#errors.push({
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
      return null;
    }

    this.#advance(); // consume '}'
    return { kind: "block", properties, pos } satisfies BlockValue;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  parse(): Result<AstNode[], ParseError[]> {
    const nodes: AstNode[] = [];

    while (this.#current().type !== TokenType.EOF) {
      const before = this.#cursor;
      const node = this.#parseTopLevel();
      if (node) nodes.push(node);
      // Safety: if nothing was consumed and we are not at EOF, advance one
      // token to prevent an infinite loop on stray tokens (e.g. a lone `}`
      // left over from error recovery stopping AT a boundary delimiter).
      if (this.#cursor === before && this.#current().type !== TokenType.EOF) {
        this.#advance();
      }
    }

    if (this.#errors.length > 0) return err(this.#errors);
    return ok(nodes);
  }
}

// ---------------------------------------------------------------------------
// Standalone function
// ---------------------------------------------------------------------------

/**
 * Parses a `Token[]` stream into an `AstNode[]`.
 * Errors are collected and returned together.
 */
export function parse(tokens: Token[]): Result<AstNode[], ParseError[]> {
  return new Parser(tokens).parse();
}
