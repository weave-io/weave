/**
 * The FOREGROUND plan display identity: which plan the parent session is
 * working through right now, when no durable workflow instance exists.
 *
 * `/weave:start` and a direct "execute `.weave/plans/<name>.md`" request both
 * run Tapestry in the parent's own turn. Neither creates a workflow instance,
 * so `active-plan-ui-state.ts` — which resolves only a durable instance or an
 * eligible recovery pointer — had nothing to resolve, and the Plan Rail showed
 * its agent row alone while the user watched a plan being executed.
 *
 * ## What this module is, and is not
 *
 * It is READ-ONLY UI STATE. It names a plan for the rail to display and does
 * nothing else: it never starts, resumes, or authorizes an execution, never
 * acquires a lease, never touches the runtime store, and never transitions a
 * task. It is deliberately the LAST display authority — a durable workflow and
 * an eligible recovery pointer both outrank it — so it can only ever fill a
 * gap, never contradict authoritative execution state.
 *
 * ## Where an identity may come from
 *
 * Exactly two places, both user-authorized:
 *
 * 1. `/weave:start`, from the plan the user selected and confirmed;
 * 2. one direct interactive message that explicitly asks for exactly one
 *    contained `.weave/plans/<safe-name>.md` to be executed.
 *
 * Nothing else. Assistant text, system prompts, tool output, arbitrary prose
 * about "the plan", and any filesystem scan outside the project root are all
 * structurally excluded: {@link parseForegroundPlanRequest} reads one bounded
 * string and returns a safe basename or a typed rejection, and the caller must
 * still prove catalog membership and read the snapshot before displaying it.
 *
 * ## Surviving a restart
 *
 * A selection is recorded as ONE bounded adapter-owned custom session entry
 * and reconstructed from that entry alone. Model prose in the transcript is
 * never re-parsed on startup: a restart that re-read the conversation could be
 * steered by anything the session happens to contain.
 */
import { err, ok, Result } from "neverthrow";
import { z } from "zod";

/** The adapter-owned custom session entry that survives a restart. */
export const FOREGROUND_PLAN_ENTRY_TYPE = "weave.plan.foreground";

/**
 * The same safe-name allowlist the plan catalog and the engine's plan-name
 * validation use. A name that would not validate as a plan name is never
 * displayed, recorded, or looked up.
 */
const SAFE_PLAN_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Ceiling on a plan basename. Longer names are rejected, never truncated. */
export const MAX_FOREGROUND_PLAN_NAME_LENGTH = 128;

/**
 * Ceiling on the user text one request may be parsed from.
 *
 * A longer message is REJECTED rather than scanned: this parser runs on every
 * interactive submission, and an unbounded scan of pasted content is a cost
 * the UI has no reason to pay.
 */
export const MAX_FOREGROUND_PLAN_REQUEST_LENGTH = 4_096;

/** Ceiling on the newest session entries a restart will scan. */
export const MAX_FOREGROUND_PLAN_ENTRY_SCAN = 512;

/** Why a direct request did not name a foreground plan. */
export type ForegroundPlanRequestRejection =
  | "input-too-long"
  | "no-plan-path"
  | "unsafe-plan-path"
  | "multiple-plans"
  | "no-execution-intent";

/**
 * The closed grammar of a positive user request, over the WHOLE message.
 *
 * A message asks for a plan to be executed when, and only when, every token
 * outside the plan path itself is in one of four closed vocabularies, in this
 * order:
 *
 *     <lead-in>* <execution verb> <connector>* PATH <trailer>*
 *
 * Nothing is inferred, nothing is scored, and no token is ignored: a single
 * word outside the vocabularies rejects the message. That is the difference
 * between `run .weave/plans/alpha.md` and `For example: run
 * .weave/plans/alpha.md` — the second states `for`, `example` and `:` before
 * the verb, none of which this grammar has a rule for, so it is not a request.
 *
 * ## Why the whole message, and not the clause before the path
 *
 * The predecessor matched only the clause between the previous punctuation
 * and the path. It therefore accepted every framing that ends in a colon or a
 * comma: `For example: run …`, `Ignore this quoted sample: run …`, `The docs
 * say: execute …`. All three name a plan inside a QUOTATION or an EXAMPLE, and
 * all three left the clause `run` / `execute`, which the clause grammar
 * accepted as the user's own instruction. Reading the whole message is what
 * makes "the user asked for this" structural rather than positional.
 *
 * ## Total, closed, and unambiguous
 *
 * Total: every input reaches exactly one verdict — accepted, or one typed
 * rejection. Closed: the four vocabularies below are the entire language, and
 * a character outside the punctuation each part allows is a rejection rather
 * than a separator to skip. Unambiguous: the head is parsed left to right,
 * longest phrase first, with no backtracking, and the trailer is a set
 * membership test per token, so there is no second reading of any message.
 *
 * Anything the grammar does not accept is not "maybe a request": the caller
 * falls back to `/weave:start`, which asks the user explicitly.
 */
type PhraseVocabulary = readonly (readonly string[])[];

/** Words that may precede the verb. */
const EXECUTION_LEAD_INS: PhraseVocabulary = [
  ["i", "want", "you", "to"],
  ["i'd", "like", "you", "to"],
  ["go", "ahead", "and"],
  ["you", "should"],
  ["let's"],
  ["lets"],
  ["please"],
  ["now"],
  ["then"],
  ["and"],
  ["ok"],
  ["okay"],
  ["next"],
  ["first"],
];

/** The verbs that ask for execution. Nothing else is an execution request. */
const EXECUTION_VERBS: PhraseVocabulary = [
  ["work", "through"],
  ["carry", "out"],
  ["pick", "up"],
  ["execute"],
  ["run"],
  ["start"],
  ["implement"],
  ["continue"],
  ["resume"],
  ["finish"],
  ["complete"],
];

/**
 * Words that may sit between the verb and the path.
 *
 * Every entry is a word that QUALIFIES the plan being named and reframes
 * nothing: `existing` says the plan is already written, and `weave` names the
 * product whose plan it is. Both appear in the sentence a user actually types
 * (`execute the existing Weave plan at .weave/plans/<name>.md`), and neither
 * can turn a refusal, a question or a quotation into a request — those are
 * refused by the whole-message vetoes and by the closed head grammar, not by
 * this set.
 */
const EXECUTION_CONNECTORS: ReadonlySet<string> = new Set([
  "the",
  "this",
  "that",
  "our",
  "my",
  "its",
  "it",
  "existing",
  "weave",
  "plan",
  "file",
  "at",
  "in",
  "on",
  "with",
  "from",
  "through",
  "path",
  "located",
  "stored",
  "working",
  "work",
  "executing",
  "running",
]);

/**
 * Words that may follow the path.
 *
 * Deliberately narrow: it covers how a user finishes an instruction (`end to
 * end`, `please`, `now`, `thanks`) and nothing that would reframe the sentence.
 * `for example`, `as a sample`, `if`, `but` and every other framing word are
 * absent, so a trailing qualification rejects the message instead of being
 * read as emphasis.
 */
const EXECUTION_TRAILERS: ReadonlySet<string> = new Set([
  "end",
  "to",
  "now",
  "then",
  "and",
  "yes",
  "please",
  "thanks",
  "thank",
  "you",
  "for",
  "me",
  "us",
  "completely",
  "fully",
  "in",
  "full",
  "completion",
  "step",
  "by",
  "the",
  "plan",
  "file",
  "again",
  "right",
  "away",
  "asap",
  "today",
]);

/**
 * The quote or bracket a path may be OPENED with.
 *
 * It belongs to the path, not to the sentence, so it is stripped from the end
 * of the head and is admitted nowhere else. A fence, a quotation mark or a
 * bracket earlier in the head frames the path as a sample rather than asking
 * for it (` ```\nrun …\n``` `, `"execute …" is what you told me`), and the
 * tokenizer rejects the message instead of stepping over it.
 */
const HEAD_PATH_OPENER_RE = /[\s"'`([]+$/u;

/**
 * The only separator between words BEFORE the path: whitespace or a comma.
 *
 * A colon, a period, a digit, a bullet, an angle quote or any other character
 * is not a separator this grammar knows, so `e.g. run …`, `> execute …`,
 * `1. run …` and `Example: run …` are rejected rather than tokenized.
 *
 * An apostrophe is deliberately NOT a separator either: it is a letter inside
 * `let's` and `i'd`. It is admitted ONLY there — see
 * {@link isContractionApostrophe} — so a quote around a word is an unknown
 * character that rejects the head, exactly as `"` and a backtick already do.
 */
const HEAD_WORD_SEPARATOR_RE = /[\s,]/u;

/** The characters a head word may be built from, apostrophe excluded. */
const HEAD_WORD_LETTER_RE = /[a-z]/iu;

/** Characters that separate words AFTER the path, including sentence-final ones. */
const TRAILER_SEPARATOR_RE = /[\s"'`()[\],.;:!\u2014\u2013-]+/u;

/**
 * Words that make a message something other than a request, wherever they
 * appear.
 *
 * A negation can sit far from the verb (`run the tests, not
 * .weave/plans/alpha.md`), so unlike the grammar this is a whole-input veto.
 * It is a veto and never an acceptance: it can only ever refuse, so it narrows
 * the closed grammar rather than widening it.
 */
const NEGATION_RE =
  /\b(?:no|not|never|dont|don't|doesn't|didn't|won't|wouldn't|shouldn't|cannot|can't|stop|cancel|abort|skip|avoid|without|instead|unless)\b/iu;

/**
 * The characters that can FRAME a whole message as a quotation or as code,
 * each mapped to the framing it belongs to.
 *
 * A typographic pair maps to the straight pair a reader means by it, so
 * `‘…’` and `“…”` are the same framing as `'…'` and `"…"` rather than two
 * spellings this parser has to be taught separately.
 */
const REQUEST_FRAMING_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["'", "'"],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ['"', '"'],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["`", "`"],
]);

/** Whitespace, tested one character at a time so no scan can backtrack. */
const REQUEST_WHITESPACE_RE = /\s/u;

/**
 * One contained plan path: an optional `./`, then exactly `.weave/plans/`,
 * then one safe basename, then `.md`.
 *
 * The pattern is anchored on its left by a start-of-input or a separator, so
 * `../other-worktree/.weave/plans/alpha.md` and
 * `/Users/someone/other/.weave/plans/alpha.md` do not match: a path that
 * reaches outside this project root is not parsed into the basename it happens
 * to end with. Its right lookahead refuses a further path segment, so
 * `.weave/plans/alpha.md.bak` and `.weave/plans/alpha.mdx` are not read as
 * `alpha`.
 */
const PLAN_PATH_RE =
  /(?:^|[\s"'`([])(?:\.\/)?\.weave\/plans\/([A-Za-z0-9_-]+)\.md(?=$|[\s"'`)\],;:!?]|\.(?=\s|$))/gu;

/**
 * Anything that LOOKS like a plans path, in any spelling.
 *
 * Deliberately wider than {@link PLAN_PATH_RE}: it matches the separator with
 * or without the leading dot and in either slash direction, and case
 * -insensitively. Every mention it finds must be accounted for by an accepted
 * path, so a traversal, an absolute path, a nested subdirectory, a Windows
 * spelling or an unsafe basename REJECTS THE WHOLE MESSAGE — including when a
 * perfectly good path sits beside it. A message that names one thing this
 * parser will not touch is a message whose intent it cannot state.
 */
const PLAN_PATH_MENTION_RE = /\.?weave[\\/]+plans[\\/]+/giu;

/**
 * Parses one direct user message into the single plan it explicitly asks to
 * execute.
 *
 * Fail-closed at every step: over the length bound, no plan path, ANY
 * plan-path-like mention this parser will not accept, more than one distinct
 * plan, a negation, an interrogative, or a clause that is not an execution
 * request all return a typed rejection and change nothing.
 *
 * A successful parse is NOT authority to display: the caller must still prove
 * the name is in this project root's plan catalog and that its snapshot reads.
 */
export function parseForegroundPlanRequest(
  text: string,
): Result<string, ForegroundPlanRequestRejection> {
  // Keep this boundary total at runtime as well as at the TypeScript boundary:
  // Pi event payloads are host data, and a malformed non-string must be a typed
  // rejection rather than a property access or string-coercion throw.
  const parsedText = z.string().safeParse(text);
  if (!parsedText.success) return err("no-plan-path");
  const requestText = parsedText.data;
  if (requestText.length > MAX_FOREGROUND_PLAN_REQUEST_LENGTH) {
    return err("input-too-long");
  }

  const mentions = countMatches(requestText, PLAN_PATH_MENTION_RE);
  const matches = collectPlanPathMatches(requestText);
  // Every plan-ish mention must be one this parser accepted. One it did not is
  // not "prose that named nothing": it is a path whose meaning it refuses to
  // guess, and it disqualifies the message rather than the path.
  if (matches.length !== mentions) {
    return err(mentions === 0 ? "no-plan-path" : "unsafe-plan-path");
  }
  const first = matches[0];
  if (first === undefined) return err("no-plan-path");
  if (matches.some((match) => match.name !== first.name)) {
    return err("multiple-plans");
  }
  if (!isSafeForegroundPlanName(first.name)) return err("unsafe-plan-path");

  if (!isExecutionRequest(requestText, matches)) {
    return err("no-execution-intent");
  }
  return ok(first.name);
}

/**
 * True when the WHOLE message is a positive request to execute the plan.
 *
 * The message is read as `head PATH (gap PATH)* tail`, where every path has
 * already been proven to name the same plan. The head must parse as
 * `lead-in* verb connector*`, and every gap and the tail must consist only of
 * trailer words. Nothing else is admitted.
 */
function isExecutionRequest(
  text: string,
  matches: readonly PlanPathMatch[],
): boolean {
  // A question is not an instruction, however many execution verbs it holds.
  if (text.includes("?")) return false;
  if (NEGATION_RE.test(text)) return false;
  // A quoted or fenced message SHOWS a request; it does not make one.
  if (isWholeRequestFramed(text, matches)) return false;
  const first = matches[0];
  if (first === undefined) return false;
  if (!isExecutionHead(text.slice(0, first.index))) return false;
  let cursor = first.index + first.length;
  for (const match of matches.slice(1)) {
    if (!isExecutionTrailer(text.slice(cursor, match.index))) return false;
    cursor = match.index + match.length;
  }
  return isExecutionTrailer(text.slice(cursor));
}

/**
 * True when the WHOLE message is wrapped in one quotation or code framing.
 *
 * A whole-input veto, like the negation and the question mark, and never an
 * acceptance: it can only refuse. `'Execute the existing Weave plan at
 * .weave/plans/alpha.md'` READS as an instruction and is not one — it is an
 * instruction being SHOWN, exactly like the fenced and double-quoted samples
 * the head grammar already refuses. The single-quote spelling reached
 * acceptance only because an apostrophe is a letter inside `let's`.
 *
 * Path-local quoting survives untouched: framing that opens immediately
 * before the first path and closes immediately after the last one quotes the
 * PATH, not the request, so `run '.weave/plans/alpha.md'` and its double-quote
 * and backtick spellings are not framed messages.
 *
 * The scan is two bounded walks over a message whose length was already
 * checked, and it reads only the first and last non-whitespace characters.
 */
function isWholeRequestFramed(
  text: string,
  matches: readonly PlanPathMatch[],
): boolean {
  const start = firstContentIndex(text);
  const end = lastContentIndex(text);
  // One framing character alone is not a pair, so it frames nothing.
  if (start === undefined || end === undefined || end <= start) return false;
  const opener = REQUEST_FRAMING_CHARACTERS.get(text.charAt(start));
  if (opener === undefined) return false;
  const closer = REQUEST_FRAMING_CHARACTERS.get(text.charAt(end));
  if (closer === undefined || closer !== opener) return false;
  return !framesOnlyThePlanPath(matches, start, end);
}

/** True when the framing hugs the plan paths themselves and nothing else. */
function framesOnlyThePlanPath(
  matches: readonly PlanPathMatch[],
  start: number,
  end: number,
): boolean {
  const first = matches[0];
  const last = matches[matches.length - 1];
  if (first === undefined || last === undefined) return false;
  return first.index === start + 1 && last.index + last.length === end;
}

/** First index that is not whitespace, or `undefined` for a blank message. */
function firstContentIndex(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    if (!REQUEST_WHITESPACE_RE.test(text.charAt(index))) return index;
  }
  return undefined;
}

/** Last index that is not whitespace, or `undefined` for a blank message. */
function lastContentIndex(text: string): number | undefined {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!REQUEST_WHITESPACE_RE.test(text.charAt(index))) return index;
  }
  return undefined;
}

/**
 * Tokenizes the text before the path into lowercase words.
 *
 * `undefined` — not an empty list — when the head holds a character this
 * grammar has no rule for, so an unknown separator rejects the message instead
 * of silently splitting it.
 *
 * An apostrophe is a character this grammar knows in ONE place: between two
 * letters, where it spells `let's` and `i'd`. A leading, trailing or standalone
 * one is not trimmed off the word — it is the unknown character it looks like,
 * and it rejects the head just as `"` and a backtick do.
 */
function tokenizeExecutionHead(head: string): string[] | undefined {
  const body = head.replace(HEAD_PATH_OPENER_RE, "");
  const tokens: string[] = [];
  let word = "";
  const flush = (): void => {
    if (word !== "") tokens.push(word);
    word = "";
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = normalizeApostrophe(body.charAt(index));
    if (HEAD_WORD_SEPARATOR_RE.test(char)) {
      flush();
      continue;
    }
    if (HEAD_WORD_LETTER_RE.test(char)) {
      word += char.toLowerCase();
      continue;
    }
    if (char === "'" && isContractionApostrophe(body, index)) {
      word += char;
      continue;
    }
    return undefined;
  }
  flush();
  return tokens;
}

/** A typographic apostrophe is the same character to a reader. */
function normalizeApostrophe(char: string): string {
  return char === "\u2018" || char === "\u2019" ? "'" : char;
}

/** True when the apostrophe at `index` sits between two letters. */
function isContractionApostrophe(body: string, index: number): boolean {
  if (index === 0) return false;
  // `charAt` past the end is the empty string, which is not a letter, so the
  // bound needs no separate check.
  const before = normalizeApostrophe(body.charAt(index - 1));
  const after = normalizeApostrophe(body.charAt(index + 1));
  return HEAD_WORD_LETTER_RE.test(before) && HEAD_WORD_LETTER_RE.test(after);
}

/** Matches one phrase of a vocabulary at `index`, longest phrase first. */
function matchPhrase(
  tokens: readonly string[],
  index: number,
  vocabulary: PhraseVocabulary,
): number {
  for (const phrase of vocabulary) {
    if (phrase.every((word, offset) => tokens[index + offset] === word)) {
      return phrase.length;
    }
  }
  return 0;
}

/** True when the head is exactly `lead-in* verb connector*`. */
function isExecutionHead(head: string): boolean {
  const tokens = tokenizeExecutionHead(head);
  if (tokens === undefined) return false;
  let index = 0;
  for (;;) {
    const leadIn = matchPhrase(tokens, index, EXECUTION_LEAD_INS);
    if (leadIn === 0) break;
    index += leadIn;
  }
  const verb = matchPhrase(tokens, index, EXECUTION_VERBS);
  if (verb === 0) return false;
  index += verb;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined || !EXECUTION_CONNECTORS.has(token)) return false;
    index += 1;
  }
  return true;
}

/** True when every word after the path is a trailer word. */
function isExecutionTrailer(tail: string): boolean {
  for (const token of tail.split(TRAILER_SEPARATOR_RE)) {
    if (token === "") continue;
    if (!EXECUTION_TRAILERS.has(token.toLowerCase())) return false;
  }
  return true;
}

/** One accepted plan path: its name, where it starts, and how long it is. */
interface PlanPathMatch {
  readonly name: string;
  readonly index: number;
  readonly length: number;
}

/** Every accepted plan path, with the exact span it occupies. */
function collectPlanPathMatches(text: string): readonly PlanPathMatch[] {
  // A fresh regex per call: a shared /g literal carries `lastIndex` between
  // calls and would skip the first match of every second message.
  const pattern = new RegExp(PLAN_PATH_RE.source, PLAN_PATH_RE.flags);
  const found: PlanPathMatch[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1];
    // The match consumes one leading separator; the head ends where the path
    // itself begins.
    if (name !== undefined) {
      const length = matchedPathLength(match[0]);
      found.push({
        name,
        index: match.index + (match[0].length - length),
        length,
      });
    }
    match = pattern.exec(text);
  }
  return found;
}

/** Length of the path itself inside a match that may carry a separator. */
function matchedPathLength(matched: string): number {
  const start = matched.indexOf(".weave/plans/");
  const dotSlash = matched.indexOf("./.weave/plans/");
  const from = dotSlash === -1 ? start : dotSlash;
  return from === -1 ? matched.length : matched.length - from;
}

function countMatches(text: string, pattern: RegExp): number {
  const scoped = new RegExp(pattern.source, pattern.flags);
  let count = 0;
  while (scoped.exec(text) !== null) count += 1;
  return count;
}

/** Input boundary for values that arrive from Pi session entries or callers. */
const ForegroundPlanInputBoundary = z.unknown();
type ForegroundPlanInput = z.input<typeof ForegroundPlanInputBoundary>;

/** True when a name is a plan basename this module will display or record. */
export function isSafeForegroundPlanName(
  value: ForegroundPlanInput,
): value is string {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return false;
  return (
    parsed.data.length > 0 &&
    parsed.data.length <= MAX_FOREGROUND_PLAN_NAME_LENGTH &&
    SAFE_PLAN_NAME_RE.test(parsed.data)
  );
}

/** The bounded payload of one recorded selection. */
export const ForegroundPlanEntrySchema = z
  .object({
    v: z.literal(1),
    planName: z
      .string()
      .min(1)
      .max(MAX_FOREGROUND_PLAN_NAME_LENGTH)
      .regex(SAFE_PLAN_NAME_RE),
  })
  .strict();

export type ForegroundPlanEntry = z.infer<typeof ForegroundPlanEntrySchema>;

/** Builds the payload for `appendEntry(FOREGROUND_PLAN_ENTRY_TYPE, …)`. */
export function foregroundPlanEntry(planName: string): ForegroundPlanEntry {
  return { v: 1, planName };
}

/**
 * The FULL envelope one recorded selection must present.
 *
 * `type` is checked, not just `customType`, and that is the whole point: Pi's
 * `CustomEntry` is `{ type: "custom", customType, data }`, while a user
 * message, an assistant message, a tool result and a `custom_message` are
 * different entry types that can carry any fields a model chose to write. An
 * envelope that only had to say `customType` could therefore be FORGED by
 * ordinary conversation content, and a restart would replay it as the user's
 * own selection.
 */
const ForegroundPlanSessionEntrySchema = z
  .object({
    type: z.literal("custom"),
    customType: z.literal(FOREGROUND_PLAN_ENTRY_TYPE),
    data: ForegroundPlanEntrySchema,
  })
  .strict();

/**
 * Ceiling on the fields one recorded payload may carry.
 *
 * The contract names two. A payload with more is not a payload with extra
 * information, it is not this module's payload, and the copy stops rather than
 * walking whatever the session happens to hold.
 */
const MAX_FOREGROUND_PLAN_ENTRY_FIELDS = 8;

interface ForegroundPlanSessionEntryProjection {
  readonly type: ForegroundPlanInput | undefined;
  readonly customType: ForegroundPlanInput | undefined;
  readonly data: ForegroundPlanInput | undefined;
}

function noForegroundPlanValue(): undefined {}

/** `Object.getOwnPropertyDescriptor` as a value: a proxy trap can throw. */
const ownDescriptor = Result.fromThrowable(
  (target: ForegroundPlanInput, key: string): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(new Object(target), key),
  noForegroundPlanValue,
);

/**
 * The value of an own, enumerable DATA property, or `undefined`.
 *
 * An accessor is never invoked: reading it would run session content's own
 * code during startup. An inherited or non-enumerable property is not the
 * entry's own statement either, so a prototype-polluted payload states
 * nothing.
 */
function ownValue(
  target: ForegroundPlanInput,
  key: string,
): ForegroundPlanInput | undefined {
  const descriptor = ownDescriptor(target, key);
  if (descriptor.isErr()) return undefined;
  const found = descriptor.value;
  if (found === undefined || !("value" in found)) return undefined;
  return found.enumerable === true ? found.value : undefined;
}

/**
 * Rebuilds one entry as a plain object of exactly the fields this module
 * validates, read descriptor-safely.
 *
 * Validation then runs over inert data rather than over a host object: no
 * getter runs, no proxy trap fires inside the schema, and no field the schema
 * does not name survives the copy.
 */
function materializeEntry(
  entry: ForegroundPlanInput,
): ForegroundPlanSessionEntryProjection | undefined {
  if (!isPlainObject(entry)) return undefined;
  return {
    type: ownValue(entry, "type"),
    customType: ownValue(entry, "customType"),
    data: materializePayload(ownValue(entry, "data")),
  };
  // The entry's own `id`, `parentId` and `timestamp` are Pi's, not this
  // contract's, so they are simply not copied. Everything this module
  // validates is copied faithfully, extra fields included, so the strict
  // payload schema still refuses a payload that says more than it should.
}

/** Faithful bounded copy of the recorded payload, extra fields included. */
function materializePayload(data: ForegroundPlanInput): ForegroundPlanInput {
  if (!isPlainObject(data)) return data;
  const keys = Result.fromThrowable(
    () => Object.keys(new Object(data)),
    noForegroundPlanValue,
  )().match((value) => value, noForegroundPlanValue);
  if (keys === undefined || keys.length > MAX_FOREGROUND_PLAN_ENTRY_FIELDS) {
    return undefined;
  }
  const copy = new Map<string, ForegroundPlanInput>();
  for (const key of keys) {
    // `__proto__` and friends are never copied by assignment: they would
    // mutate the copy's own authority rather than describe the payload.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    copy.set(key, ownValue(data, key));
  }
  return Object.fromEntries(copy);
}

/** A non-array object, decided without letting a revoked proxy throw. */
function isPlainObject(value: ForegroundPlanInput): boolean {
  return Result.fromThrowable(
    // `Object(value) === value` distinguishes objects from primitives without
    // reading Symbol.toStringTag or any other user accessor. The old boundary
    // accepted every non-array object, including null-prototype records; keep
    // that contract while still treating revoked proxies as unreadable.
    () => Object(value) === value && !Array.isArray(value),
    () => false,
  )().match(
    (plain) => plain,
    () => false,
  );
}

/**
 * Reconstructs the recorded foreground plan from Pi's own session entries.
 *
 * Newest wins, and only this adapter's own `custom` entry type is read: a user
 * message, an assistant message, a tool result, a `custom_message`, and every
 * other extension's custom entry are all invisible here, so a restart cannot
 * be steered by prose — not even by prose that names the fields. The scan is
 * bounded to the newest {@link MAX_FOREGROUND_PLAN_ENTRY_SCAN} entries, so a
 * long session costs a fixed amount of startup work.
 *
 * A successful read is still not authority to display: the caller must prove
 * the name is in THIS project root's plan catalog before adopting it.
 */
export function readForegroundPlanEntry(
  entries: readonly ForegroundPlanInput[],
): string | undefined {
  // The COMPLETE scan is guarded, not one step of it. The list is host data
  // that may be a proxy, and every step can throw: `Array.isArray` on a
  // revoked proxy, a `getOwnPropertyDescriptor` trap on `length` or on an
  // index, a `Symbol.toPrimitive` reached inside validation. A list that
  // cannot be read states no selection, which is exactly `undefined`.
  return Result.fromThrowable(
    () => scanForegroundPlanEntries(entries),
    noForegroundPlanValue,
  )().match((planName) => planName, noForegroundPlanValue);
}

/**
 * The bounded, descriptor-safe scan itself.
 *
 * Nothing here reads a member any other way than through its own property
 * descriptor: `length` included, so a `get` trap on the list never runs and a
 * getter never decides how far the scan goes.
 */
function scanForegroundPlanEntries(
  entries: readonly ForegroundPlanInput[],
): string | undefined {
  const isArray = Result.fromThrowable(
    () => Array.isArray(entries),
    () => false,
  )().match(
    (value) => value,
    () => false,
  );
  if (!isArray) return undefined;
  const size = ownArrayLength(entries);
  if (size === undefined) return undefined;
  const start = Math.max(0, size - MAX_FOREGROUND_PLAN_ENTRY_SCAN);
  for (let index = size - 1; index >= start; index -= 1) {
    const parsed = ForegroundPlanSessionEntrySchema.safeParse(
      materializeEntry(ownValue(entries, String(index))),
    );
    if (parsed.success) return parsed.data.data.planName;
  }
  return undefined;
}

/**
 * A real array's `length`, read as an own non-enumerable DATA property.
 *
 * `list.length` would run a proxy's `get` trap; this cannot. A descriptor that
 * is absent, an accessor, enumerable, or not a safe non-negative integer is
 * not a length this scan will trust, and the list is then read as stating
 * nothing rather than scanned to a fabricated bound.
 */
function ownArrayLength(
  list: readonly ForegroundPlanInput[],
): number | undefined {
  const descriptor = ownDescriptor(list, "length");
  if (descriptor.isErr()) return undefined;
  const found = descriptor.value;
  if (found === undefined || !("value" in found)) return undefined;
  if (found.enumerable === true) return undefined;
  const parsed = z.number().safeParse(found.value);
  if (!parsed.success) return undefined;
  if (!Number.isSafeInteger(parsed.data) || parsed.data < 0) return undefined;
  return parsed.data;
}

/**
 * The session-local holder of the display identity.
 *
 * One optional string. It is never persisted by this object (the caller
 * records the session entry), never read by anything that executes, and
 * cleared outright on a new session.
 */
export interface ForegroundPlanDisplayState {
  /** The plan the rail may display, or `undefined`. */
  readonly planName: () => string | undefined;
  /**
   * Adopts a user-authorized selection. An unsafe name is refused, so a
   * malformed value can never reach the rail or the recorded entry.
   */
  readonly select: (planName: string) => boolean;
  /** Drops the identity. Idempotent. */
  readonly clear: () => void;
}

export function createForegroundPlanDisplayState(): ForegroundPlanDisplayState {
  let planName: string | undefined;
  return {
    planName: () => planName,
    select: (candidate) => {
      if (!isSafeForegroundPlanName(candidate)) return false;
      planName = candidate;
      return true;
    },
    clear: () => {
      planName = undefined;
    },
  };
}
