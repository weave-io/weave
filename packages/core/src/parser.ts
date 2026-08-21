/**
 * Recursive-descent parser for `.weave` token streams.
 *
 * Consumes a `Token[]` produced by the Lexer and builds an `AstNode[]`.
 * Errors are accumulated and returned together — the parser recovers
 * after each bad construct by skipping to the next safe boundary.
 */

import { err, ok, type Result, Result as ResultClass } from "neverthrow";
import { z } from "zod";
import type {
  AgentBlock,
  ArrayValue,
  AstNode,
  AstValue,
  BlockValue,
  BooleanValue,
  CategoryBlock,
  DisableDirective,
  ExtendBeforePlanDirective,
  IdentifierValue,
  NullValue,
  NumberValue,
  Property,
  SettingAssignment,
  StepBlock,
  StringValue,
  WorkflowBlock,
} from "./ast.js";
import {
  boundConfigErrors,
  CONFIG_ERRORS_TRUNCATED,
} from "./config-error-policy.js";
import type { ParseError } from "./errors.js";
import type {
  SafeGraphCopyBudget,
  SafeGraphObject,
  SafeGraphValue,
} from "./safe-graph-copy.js";
import { copySafeGraph } from "./safe-graph-copy.js";
import { MAX_CONFIG_ARRAY_LENGTH } from "./schema-common.js";
import type { SourcePos } from "./tokens.js";
import { type Token, TokenType } from "./tokens.js";

const INVALID_TOKEN_STREAM_FOUND = "[invalid token stream]";
const INVALID_TOKEN_STREAM_EXPECTED = "valid token stream";
const TOKEN_STREAM_LIMIT_FOUND = "[token stream exceeds parser limit]";
const ARRAY_ITEM_LIMIT_FOUND = "[array item limit exceeded]";

/**
 * Maximum number of tokens retained by one parser snapshot.
 *
 * A valid workflow may contain 512 steps. A maximal bounded step can carry
 * two 512-item artifact lists plus its scalar fields and four reconciliation
 * handlers. Eight thousand tokens per step covers that shape, delimiters, and
 * separators. Keep the multiplier explicit so this owner budget stays tied to
 * the public list bound instead of becoming an unbounded source-size allowance.
 */
const MAX_WORKFLOW_STEP_TOKEN_BUDGET = 8_192;
export const MAX_PARSER_TOKEN_COUNT =
  MAX_CONFIG_ARRAY_LENGTH * MAX_WORKFLOW_STEP_TOKEN_BUDGET;

const PARSER_TOKEN_SNAPSHOT_BUDGET: SafeGraphCopyBudget = {
  maxDepth: 4,
  // One token has four fields plus the token itself. The factor leaves room
  // for the root array and future token metadata without removing the cap.
  maxNodes: MAX_PARSER_TOKEN_COUNT * 6,
  maxProperties: MAX_PARSER_TOKEN_COUNT * 6,
  maxPropertiesPerObject: 512,
  maxArrayLength: MAX_PARSER_TOKEN_COUNT,
  // Four token keys plus token values contribute roughly 24 units each.
  maxStringLength: MAX_PARSER_TOKEN_COUNT * 32,
};

function defineOwnProperty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, String(target.length), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function invalidTokenStreamErrors(): ParseError[] {
  const error: ParseError = {
    type: "UnexpectedToken",
    line: 0,
    column: 0,
    found: INVALID_TOKEN_STREAM_FOUND,
    expected: INVALID_TOKEN_STREAM_EXPECTED,
  };
  return boundConfigErrors<ParseError>([error], () => error);
}

const TokenTypeSchema = z.enum([
  TokenType.Identifier,
  TokenType.String,
  TokenType.Number,
  TokenType.LBrace,
  TokenType.RBrace,
  TokenType.LBracket,
  TokenType.RBracket,
  TokenType.Comma,
  TokenType.Newline,
  TokenType.EOF,
]);
const TokenStringSchema = z.string();
const TokenPositionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

function isSafeGraphRecord(value: SafeGraphValue): value is SafeGraphObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function parseTokenType(value: SafeGraphValue): TokenType | null {
  const parsed = TokenTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseTokenString(value: SafeGraphValue): string | null {
  const parsed = TokenStringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseTokenPosition(value: SafeGraphValue): number | null {
  const parsed = TokenPositionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hasOnlyTokenFields(record: SafeGraphObject): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === 4 &&
    keys.includes("type") &&
    keys.includes("value") &&
    keys.includes("line") &&
    keys.includes("column")
  );
}

function isTokenValueValid(type: TokenType, value: string): boolean {
  switch (type) {
    case TokenType.Identifier:
      return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value);
    case TokenType.Number:
      return /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value);
    case TokenType.LBrace:
      return value === "{";
    case TokenType.RBrace:
      return value === "}";
    case TokenType.LBracket:
      return value === "[";
    case TokenType.RBracket:
      return value === "]";
    case TokenType.Comma:
      return value === ",";
    case TokenType.Newline:
      return value === "\n";
    case TokenType.EOF:
      return value === "";
    case TokenType.String:
      return true;
  }
}

function snapshotToken(value: SafeGraphValue): Token | null {
  if (!isSafeGraphRecord(value) || !hasOnlyTokenFields(value)) return null;
  const typeValue = parseTokenType(value.type);
  const tokenValue = parseTokenString(value.value);
  const lineValue = parseTokenPosition(value.line);
  const columnValue = parseTokenPosition(value.column);
  if (
    typeValue === null ||
    tokenValue === null ||
    lineValue === null ||
    columnValue === null ||
    !isTokenValueValid(typeValue, tokenValue)
  ) {
    return null;
  }
  return {
    type: typeValue,
    value: tokenValue,
    line: lineValue,
    column: columnValue,
  };
}

function tokenStreamLimitErrors(): ParseError[] {
  const error: ParseError = {
    type: "UnexpectedToken",
    line: 0,
    column: 0,
    found: TOKEN_STREAM_LIMIT_FOUND,
    expected: `at most ${MAX_PARSER_TOKEN_COUNT} tokens`,
  };
  return boundConfigErrors<ParseError>([error], () => error);
}

function snapshotTokenStream(tokens: Token[]): Result<Token[], ParseError[]> {
  const isArray = ResultClass.fromThrowable(
    () => Array.isArray(tokens),
    () => false,
  )();
  if (isArray.isErr() || !isArray.value) return err(invalidTokenStreamErrors());

  const tokenCount = ResultClass.fromThrowable(
    () => tokens.length,
    () => invalidTokenStreamErrors(),
  )();
  if (tokenCount.isErr()) return err(tokenCount.error);
  if (!Number.isSafeInteger(tokenCount.value) || tokenCount.value < 0) {
    return err(invalidTokenStreamErrors());
  }
  if (tokenCount.value > MAX_PARSER_TOKEN_COUNT) {
    return err(tokenStreamLimitErrors());
  }

  const copied = copySafeGraph(tokens, PARSER_TOKEN_SNAPSHOT_BUDGET);
  if (copied.isErr()) return err(invalidTokenStreamErrors());
  if (!Array.isArray(copied.value) || copied.value.length === 0) {
    return err(invalidTokenStreamErrors());
  }

  const snapshot: Token[] = [];
  for (const value of copied.value) {
    const token = snapshotToken(value);
    if (token === null) return err(invalidTokenStreamErrors());
    appendOwn(snapshot, token);
  }

  const eof = snapshot[snapshot.length - 1];
  if (
    eof === undefined ||
    eof.type !== TokenType.EOF ||
    snapshot.slice(0, -1).some((token) => token.type === TokenType.EOF)
  ) {
    return err(invalidTokenStreamErrors());
  }
  return ok(snapshot);
}

class Parser {
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
    appendOwn(this.#errors, {
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
      appendOwn(this.#errors, {
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
      case "extend":
        return this.#parseExtendDirective();
      default:
        return this.#parseSettingAssignment();
    }
  }
  #parseNamedBlock(blockType: string): AgentBlock | CategoryBlock | null {
    const startTok = this.#advance(); // consume 'agent' / 'category'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const nameTok = this.#current();

    if (nameTok.type !== TokenType.Identifier) {
      appendOwn(this.#errors, {
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
      appendOwn(this.#errors, {
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
      appendOwn(this.#errors, {
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
    const seenPropertyKeys = new Set<string>();
    let extendsValue: string | undefined;

    while (true) {
      this.#skipNewlines();
      const cur = this.#current();
      if (cur.type === TokenType.RBrace || cur.type === TokenType.EOF) break;

      if (cur.type === TokenType.Identifier && cur.value === "step") {
        if (steps.length >= MAX_CONFIG_ARRAY_LENGTH) {
          appendOwn(this.#errors, {
            type: "UnexpectedToken",
            line: cur.line,
            column: cur.column,
            found: ARRAY_ITEM_LIMIT_FOUND,
            expected: `at most ${MAX_CONFIG_ARRAY_LENGTH} workflow steps`,
          });
          this.#skipWorkflowRemainder();
          continue;
        }
        const step = this.#parseStepBlock();
        if (step) appendOwn(steps, step);
        continue;
      }

      const prop = this.#parseProperty();
      if (!prop) continue;

      if (seenPropertyKeys.has(prop.key)) {
        appendOwn(this.#errors, {
          type: "UnexpectedToken",
          line: prop.pos.line,
          column: prop.pos.column,
          found: prop.key,
          expected: "unique workflow property",
        });
        continue;
      }
      seenPropertyKeys.add(prop.key);

      if (prop.key === "extends" && prop.value.kind === "string") {
        extendsValue = prop.value.value;
        continue;
      }

      appendOwn(properties, prop);
    }

    if (this.#current().type !== TokenType.RBrace) {
      appendOwn(this.#errors, {
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
    } else {
      this.#advance();
    }

    const workflowBlock: WorkflowBlock = {
      type: "workflow",
      name,
      properties,
      steps,
      pos,
    };
    if (extendsValue !== undefined) {
      defineOwnProperty(workflowBlock, "extends", extendsValue);
    }
    return workflowBlock;
  }

  #skipWorkflowRemainder(): void {
    // The workflow opening brace has already been consumed. Leave its closing
    // brace for #parseWorkflowBlock so recovery does not consume the next
    // top-level declaration.
    let braceDepth = 1;
    while (this.#current().type !== TokenType.EOF) {
      const token = this.#current();
      if (token.type === TokenType.RBrace) {
        if (braceDepth === 1) return;
        braceDepth -= 1;
        this.#advance();
        continue;
      }
      if (token.type === TokenType.LBrace) braceDepth += 1;
      this.#advance();
    }
  }

  #parseStepBlock(): StepBlock | null {
    const startTok = this.#advance(); // consume 'step'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const nameTok = this.#current();

    if (nameTok.type !== TokenType.Identifier) {
      appendOwn(this.#errors, {
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

    // Parse all properties, extracting insert_before / insert_after into
    // dedicated AST fields rather than leaving them in the generic properties bag.
    const rawProperties = this.#parseProperties();
    const properties: Property[] = [];
    const seenPropertyKeys = new Set<string>();
    let insertBefore: string | undefined;
    let insertAfter: string | undefined;

    for (const prop of rawProperties) {
      if (seenPropertyKeys.has(prop.key)) {
        appendOwn(this.#errors, {
          type: "UnexpectedToken",
          line: prop.pos.line,
          column: prop.pos.column,
          found: prop.key,
          expected: "unique step property",
        });
        continue;
      }
      seenPropertyKeys.add(prop.key);

      if (prop.key === "insert_before" && prop.value.kind === "string") {
        insertBefore = prop.value.value;
        continue;
      }
      if (prop.key === "insert_after" && prop.value.kind === "string") {
        insertAfter = prop.value.value;
        continue;
      }
      appendOwn(properties, prop);
    }

    this.#skipNewlines();
    if (this.#current().type !== TokenType.RBrace) {
      appendOwn(this.#errors, {
        type: "UnclosedBlock",
        line: pos.line,
        column: pos.column,
      });
    } else {
      this.#advance();
    }

    const stepBlock: StepBlock = { name, properties, pos };
    if (insertBefore !== undefined) {
      defineOwnProperty(stepBlock, "insert_before", insertBefore);
    }
    if (insertAfter !== undefined) {
      defineOwnProperty(stepBlock, "insert_after", insertAfter);
    }
    return stepBlock;
  }

  #parseDisableDirective(): DisableDirective | null {
    const startTok = this.#advance(); // consume 'disable'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const targetTok = this.#current();
    const targetValue = targetTok.value;

    if (
      targetTok.type !== TokenType.Identifier ||
      (targetValue !== "agents" &&
        targetValue !== "hooks" &&
        targetValue !== "skills")
    ) {
      appendOwn(this.#errors, {
        type: "UnexpectedToken",
        line: targetTok.line,
        column: targetTok.column,
        found: targetTok.value || targetTok.type,
        expected: "agents | hooks | skills",
      });
      this.#skipToNextBoundary();
      return null;
    }

    const target = targetValue;
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

  /**
   * Parse `extend before-plan ["step-a", "step-b"]` top-level directive.
   *
   * Syntax: `extend before-plan [ <string>... ]`
   *
   * The `before-plan` token is a hyphenated identifier. The step names in the
   * array must be strings. The directive is stored as an `ExtendBeforePlanDirective`
   * AST node; the validator maps it into `WeaveConfig.extend_before_plan`.
   */
  #parseExtendDirective(): ExtendBeforePlanDirective | null {
    const startTok = this.#advance(); // consume 'extend'
    const pos: SourcePos = { line: startTok.line, column: startTok.column };

    this.#skipNewlines();
    const slotTok = this.#current();

    // Only `before-plan` is supported in v1.
    if (
      slotTok.type !== TokenType.Identifier ||
      slotTok.value !== "before-plan"
    ) {
      appendOwn(this.#errors, {
        type: "UnexpectedToken",
        line: slotTok.line,
        column: slotTok.column,
        found: slotTok.value || slotTok.type,
        expected: "before-plan",
      });
      this.#skipToNextBoundary();
      return null;
    }
    this.#advance(); // consume 'before-plan'

    this.#skipNewlines();
    const arrayValue = this.#parseArrayLiteral();
    if (!arrayValue) return null;

    const steps: string[] = [];
    for (const el of arrayValue.elements) {
      if (el.kind === "string" || el.kind === "identifier") {
        appendOwn(steps, el.value);
        continue;
      }
      appendOwn(this.#errors, {
        type: "UnexpectedToken",
        line: el.pos.line,
        column: el.pos.column,
        found: el.kind,
        expected: "step name (string or identifier)",
      });
      return null;
    }

    return { type: "extend_before_plan", steps, pos };
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
      if (prop) appendOwn(properties, prop);
    }

    return properties;
  }

  #parseProperty(): Property | null {
    const keyTok = this.#current();

    if (keyTok.type !== TokenType.Identifier) {
      appendOwn(this.#errors, {
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

    // Bare flag pattern: an identifier followed by `}` or EOF (possibly with
    // intervening newlines) is treated as a boolean `true` flag (e.g.
    // `before-plan` inside `extension_points { before-plan }`).
    // We peek past any newlines to find the next meaningful token. If it is
    // `}` or EOF the key has no value — treat it as a bare flag. Otherwise
    // fall through to normal key→value parsing so that `log_level\nINFO`
    // (key and value on separate lines) is handled correctly.
    let lookahead = this.#cursor;
    while (
      (this.#tokens[lookahead]?.type ?? TokenType.EOF) === TokenType.Newline
    ) {
      lookahead++;
    }
    const nextNonNewline = this.#tokens[lookahead];
    if (
      nextNonNewline === undefined ||
      nextNonNewline.type === TokenType.RBrace ||
      nextNonNewline.type === TokenType.EOF
    ) {
      return {
        key: keyTok.value,
        value: {
          kind: "boolean",
          value: true,
          pos: { line: pos.line, column: pos.column },
        } satisfies BooleanValue,
        pos,
        bare: true,
      };
    }

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
      if (token.value === "null") {
        return {
          kind: "null",
          value: null,
          pos: { line: token.line, column: token.column },
        } satisfies NullValue;
      }
      // Named block value pattern: `identifier { ... }` — e.g. `completion plan_created { plan_name "x" }`.
      // The identifier is injected as a synthetic `__name` property so the validator can recover the
      // method name from the resulting BlockValue without introducing new AST types.
      if (this.#current().type === TokenType.LBrace) {
        const block = this.#parseBlockLiteral();
        if (!block) return null;
        const pos: SourcePos = { line: token.line, column: token.column };
        const nameProp: Property = {
          key: "__name",
          value: {
            kind: "identifier",
            value: token.value,
            pos: { line: pos.line, column: pos.column },
          } satisfies IdentifierValue,
          pos: { line: pos.line, column: pos.column },
        };
        return {
          kind: "block",
          properties: [nameProp, ...block.properties],
          pos: { line: pos.line, column: pos.column },
        } satisfies BlockValue;
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

    appendOwn(this.#errors, {
      type: "UnexpectedToken",
      line: token.line,
      column: token.column,
      found: token.value || token.type,
      expected: "value (string, number, identifier, [ or {)",
    });
    this.#skipToNextBoundary();
    return null;
  }

  #skipArrayLiteralRemainder(): void {
    let depth = 1;
    while (depth > 0 && this.#current().type !== TokenType.EOF) {
      const token = this.#advance();
      if (token.type === TokenType.LBracket) depth += 1;
      if (token.type === TokenType.RBracket) depth -= 1;
    }
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
      if (elements.length >= MAX_CONFIG_ARRAY_LENGTH) {
        const token = this.#current();
        appendOwn(this.#errors, {
          type: "UnexpectedToken",
          line: token.line,
          column: token.column,
          found: ARRAY_ITEM_LIMIT_FOUND,
          expected: `at most ${MAX_CONFIG_ARRAY_LENGTH} array items`,
        });
        this.#skipArrayLiteralRemainder();
        return null;
      }

      const el = this.#parseValue();
      if (el) appendOwn(elements, el);

      this.#skipNewlines();

      // optional comma
      if (this.#current().type === TokenType.Comma) {
        this.#advance();
        this.#skipNewlines();
      }
    }

    if (this.#current().type !== TokenType.RBracket) {
      appendOwn(this.#errors, {
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
      appendOwn(this.#errors, {
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
      if (node) appendOwn(nodes, node);
      // Safety: if nothing was consumed and we are not at EOF, advance one
      // token to prevent an infinite loop on stray tokens (e.g. a lone `}`
      // left over from error recovery stopping AT a boundary delimiter).
      if (this.#cursor === before && this.#current().type !== TokenType.EOF) {
        this.#advance();
      }
    }

    if (this.#errors.length > 0) {
      return err(
        boundConfigErrors<ParseError>(this.#errors, () => ({
          type: "UnexpectedToken",
          line: 0,
          column: 0,
          found: "",
          expected: CONFIG_ERRORS_TRUNCATED,
        })),
      );
    }
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
  const snapshot = snapshotTokenStream(tokens);
  if (snapshot.isErr()) return err(snapshot.error);
  return new Parser(snapshot.value).parse();
}
