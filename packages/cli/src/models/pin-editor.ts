/**
 * Writes pinned `models` lines into a `.weave` source (`weave models pin`,
 * Spec 39 item 5).
 *
 * The edit is textual, located with the real lexer, so everything else in the
 * file — comments, blank lines, ordering, other fields — stays byte for byte:
 *
 * - An agent with a top-level `agent <name> { … }` block that already has a
 *   `models [...]` field gets that field's text replaced.
 * - An agent with a block but no `models` gets one line inserted before the
 *   block's closing brace, at the indentation of the block's fields.
 * - An agent with no block gets a new `agent <name> { models [...] }` block
 *   appended under a comment that says where it came from.
 *
 * When a file declares the same agent twice, the parser keeps the last block,
 * so the last one is edited. The result is parsed again and compared with the
 * original: if anything other than those agents' `models` changed, the edit is
 * refused rather than written.
 */

import {
  formatError,
  parseConfig,
  type Token,
  TokenType,
  tokenize,
  type WeaveConfig,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";

/** The `models` list to pin, per agent, in the order they are written. */
export type PinnedLists = Readonly<Record<string, readonly string[]>>;

/** One change in the file, for the diff printed before writing. */
export interface PinHunk {
  /** The agent the hunk belongs to. */
  readonly agent: string;
  readonly kind: "replace" | "insert" | "append";
  /** Whole source lines removed (empty for an insert or append). */
  readonly removed: readonly string[];
  /** Whole source lines added in their place. */
  readonly added: readonly string[];
}

/** The edited source and what changed. */
export interface PinEdit {
  readonly text: string;
  readonly hunks: readonly PinHunk[];
}

/** Why the source could not be edited safely. */
export type PinEditError =
  | { readonly type: "SourceInvalid"; readonly errors: readonly string[] }
  | { readonly type: "EditUnverified"; readonly message: string };

/** A one-line, user-facing reason. */
export function describePinEditError(error: PinEditError): string {
  if (error.type === "SourceInvalid")
    return `the global config does not parse, so it was not changed: ${error.errors.join("; ")}`;
  return `the edit could not be verified, so nothing was written: ${error.message}`;
}

/** Where one top-level agent block sits in the token stream. */
interface AgentBlock {
  readonly name: string;
  /** Index of the `agent` keyword. */
  readonly start: number;
  /** Index of the block's `{`. */
  readonly open: number;
  /** Index of the block's `}`. */
  readonly close: number;
  /** Index of the `models` key, if the block has one at its top level. */
  readonly models?: number;
  /** Index of the `]` closing the `models` list. */
  readonly modelsEnd?: number;
  /** Index of the first field's first token, if any. */
  readonly firstField?: number;
}

/** A single text replacement at character offsets. */
interface Splice {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly hunk: PinHunk;
}

/** Render a DSL `models [...]` field. */
export function modelsField(models: readonly string[]): string {
  return `models [${models.map((model) => JSON.stringify(model)).join(", ")}]`;
}

/** Offsets of each line's first character, for token positions. */
class SourceMap {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++)
      if (text[i] === "\n") this.starts.push(i + 1);
  }

  offset(token: Token): number {
    return (this.starts[token.line - 1] ?? this.text.length) + token.column - 1;
  }

  lineStart(offset: number): number {
    const index = this.text.lastIndexOf("\n", offset - 1);
    return index + 1;
  }

  lineEnd(offset: number): number {
    const index = this.text.indexOf("\n", offset);
    return index === -1 ? this.text.length : index;
  }

  /** The whitespace before the first character on `offset`'s line. */
  indentAt(offset: number): string {
    const start = this.lineStart(offset);
    const match = /^[ \t]*/.exec(this.text.slice(start));
    return match?.[0] ?? "";
  }

  /** Whole lines covering `[from, to)`. */
  lines(from: number, to: number): string[] {
    return this.text
      .slice(this.lineStart(from), this.lineEnd(Math.max(from, to - 1)))
      .split("\n");
  }
}

/** Finds every top-level agent block and its `models` field. */
function findAgentBlocks(tokens: readonly Token[]): Map<string, AgentBlock> {
  const blocks = new Map<string, AgentBlock>();
  let depth = 0;
  let i = 0;
  const skipNewlines = (from: number): number => {
    let index = from;
    while (tokens[index]?.type === TokenType.Newline) index++;
    return index;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    const startsAgent =
      depth === 0 &&
      token.type === TokenType.Identifier &&
      token.value === "agent";
    if (!startsAgent) {
      if (token.type === TokenType.LBrace) depth++;
      if (token.type === TokenType.RBrace) depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    const nameIndex = skipNewlines(i + 1);
    const nameToken = tokens[nameIndex];
    const openIndex = skipNewlines(nameIndex + 1);
    if (
      nameToken?.type !== TokenType.Identifier ||
      tokens[openIndex]?.type !== TokenType.LBrace
    ) {
      i++;
      continue;
    }
    const block = scanBlock(tokens, nameToken.value, i, openIndex);
    if (block === undefined) return blocks;
    // The parser keeps the last block for a name; edit that one.
    blocks.set(block.name, block);
    i = block.close + 1;
  }
  return blocks;
}

/** Reads one agent block from its `{`; undefined when it never closes. */
function scanBlock(
  tokens: readonly Token[],
  name: string,
  start: number,
  open: number,
): AgentBlock | undefined {
  let braces = 1;
  let brackets = 0;
  let models: number | undefined;
  let modelsEnd: number | undefined;
  let firstField: number | undefined;
  for (let i = open + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.type === TokenType.EOF) return undefined;
    const previous = tokens[i - 1];
    const atFieldStart =
      braces === 1 &&
      brackets === 0 &&
      token.type === TokenType.Identifier &&
      (previous?.type === TokenType.Newline ||
        previous?.type === TokenType.LBrace);
    if (atFieldStart && firstField === undefined) firstField = i;
    // A key is followed by its value, so `models [` is the agent's own field
    // wherever it sits on the line (`{ prompt "p" models ["a"] }` is valid).
    const isModelsKey =
      braces === 1 &&
      brackets === 0 &&
      token.type === TokenType.Identifier &&
      token.value === "models" &&
      tokens[i + 1]?.type === TokenType.LBracket;
    if (isModelsKey) {
      models = i;
      modelsEnd = undefined;
    }
    if (token.type === TokenType.LBracket) brackets++;
    if (token.type === TokenType.RBracket) {
      brackets = Math.max(0, brackets - 1);
      if (
        brackets === 0 &&
        braces === 1 &&
        models !== undefined &&
        modelsEnd === undefined
      )
        modelsEnd = i;
    }
    if (token.type === TokenType.LBrace) braces++;
    if (token.type !== TokenType.RBrace) continue;
    braces--;
    if (braces > 0) continue;
    return {
      name,
      start,
      open,
      close: i,
      ...(models === undefined || modelsEnd === undefined
        ? {}
        : { models, modelsEnd }),
      ...(firstField === undefined ? {} : { firstField }),
    };
  }
  return undefined;
}

function sameList(
  a: readonly string[] | undefined,
  b: readonly string[],
): boolean {
  return (
    a !== undefined && a.length === b.length && a.every((m, i) => m === b[i])
  );
}

/**
 * Edit `source` so each agent in `lists` declares exactly that `models` list.
 * Agents whose list is already exactly that are left alone. `header` is the
 * comment line written above appended blocks.
 */
export function pinModels(
  source: string,
  lists: PinnedLists,
  header: string,
): Result<PinEdit, PinEditError> {
  const before = parseSource(source);
  if (before.isErr()) return err(before.error);
  const tokens = tokenize(source);
  if (tokens.isErr())
    return err({
      type: "SourceInvalid",
      errors: tokens.error.map((e) => formatError(e)),
    });

  const map = new SourceMap(source);
  const blocks = findAgentBlocks(tokens.value);
  const splices: Splice[] = [];
  const appended: [string, readonly string[]][] = [];

  for (const [agent, models] of Object.entries(lists)) {
    if (sameList(before.value.agents[agent]?.models, models)) continue;
    const block = blocks.get(agent);
    if (block === undefined) {
      appended.push([agent, models]);
      continue;
    }
    splices.push(spliceFor(block, agent, models, tokens.value, map));
  }

  let text = source;
  for (const splice of [...splices].sort((a, b) => b.from - a.from))
    text = text.slice(0, splice.from) + splice.text + text.slice(splice.to);

  const hunks: PinHunk[] = [...splices]
    .sort((a, b) => a.from - b.from)
    .map((splice) => splice.hunk);
  if (appended.length > 0) {
    const lines = [header];
    for (const [agent, models] of appended)
      lines.push(`agent ${agent} {`, `  ${modelsField(models)}`, "}");
    const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    const gap = text.trim().length === 0 ? "" : "\n";
    text = `${text}${separator}${gap}${lines.join("\n")}\n`;
    hunks.push({
      agent: appended.map(([agent]) => agent).join(", "),
      kind: "append",
      removed: [],
      added: gap === "" ? lines : ["", ...lines],
    });
  }

  const verified = verify(before.value, text, lists);
  if (verified.isErr()) return err(verified.error);
  return ok({ text, hunks });
}

function spliceFor(
  block: AgentBlock,
  agent: string,
  models: readonly string[],
  tokens: readonly Token[],
  map: SourceMap,
): Splice {
  const field = modelsField(models);
  const modelsToken =
    block.models === undefined ? undefined : tokens[block.models];
  const endToken =
    block.modelsEnd === undefined ? undefined : tokens[block.modelsEnd];
  if (modelsToken !== undefined && endToken !== undefined) {
    const from = map.offset(modelsToken);
    const to = map.offset(endToken) + 1;
    const removed = map.lines(from, to);
    const lineFrom = map.lineStart(from);
    const lineTo = map.lineEnd(to);
    const added = (
      map.text.slice(lineFrom, from) +
      field +
      map.text.slice(to, lineTo)
    ).split("\n");
    return {
      from,
      to,
      text: field,
      hunk: { agent, kind: "replace", removed, added },
    };
  }

  const closeToken = tokens[block.close];
  const startToken = tokens[block.start];
  const close =
    closeToken === undefined ? map.text.length : map.offset(closeToken);
  const blockIndent =
    startToken === undefined ? "" : map.indentAt(map.offset(startToken));
  const firstField =
    block.firstField === undefined ? undefined : tokens[block.firstField];
  const indent =
    firstField === undefined || firstField.line === startToken?.line
      ? `${blockIndent}  `
      : map.indentAt(map.offset(firstField));
  const line = `${indent}${field}`;
  const previous = tokens[block.close - 1];
  if (previous?.type === TokenType.Newline) {
    // The `}` starts its own line: insert a whole line above it.
    const at = map.lineStart(close);
    return {
      from: at,
      to: at,
      text: `${line}\n`,
      hunk: { agent, kind: "insert", removed: [], added: [line] },
    };
  }
  // `{ … }` on one line, or the `}` after the last field: break the line.
  return {
    from: close,
    to: close,
    text: `\n${line}\n${blockIndent}`,
    hunk: { agent, kind: "insert", removed: [], added: [line] },
  };
}

function parseSource(source: string): Result<WeaveConfig, PinEditError> {
  const parsed = parseConfig(source);
  if (parsed.isOk()) return ok(parsed.value);
  return err({
    type: "SourceInvalid",
    errors: parsed.error.map((e) => formatError(e)),
  });
}

/** The edited file must differ from the original only in those `models`. */
function verify(
  before: WeaveConfig,
  text: string,
  lists: PinnedLists,
): Result<void, PinEditError> {
  const parsed = parseConfig(text);
  if (parsed.isErr())
    return err({
      type: "EditUnverified",
      message: `the edited file does not parse: ${parsed.error.map((e) => formatError(e)).join("; ")}`,
    });
  const after = parsed.value;
  for (const [agent, models] of Object.entries(lists)) {
    if (!sameList(after.agents[agent]?.models, models))
      return err({
        type: "EditUnverified",
        message: `agent ${agent} would not get the pinned models`,
      });
  }
  if (
    !Bun.deepEquals(withoutPinned(before, lists), withoutPinned(after, lists))
  )
    return err({
      type: "EditUnverified",
      message: "the edit would change more than the pinned models",
    });
  return ok(undefined);
}

function withoutPinned(config: WeaveConfig, lists: PinnedLists): WeaveConfig {
  const agents: Record<string, unknown> = { ...config.agents };
  for (const name of Object.keys(lists)) {
    const agent = config.agents[name];
    if (agent === undefined) continue;
    const { models: _models, ...rest } = agent;
    if (Object.keys(rest).length === 0) delete agents[name];
    else agents[name] = rest;
  }
  return { ...config, agents: agents as WeaveConfig["agents"] };
}
