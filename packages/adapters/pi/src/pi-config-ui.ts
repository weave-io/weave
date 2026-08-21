/**
 * The `/weave:pi-config` overlay: the native Pi TUI surface that chooses which
 * Pi extensions a Weave RPC child loads.
 *
 * This module owns the whole visible surface - layout, width safety, cursor
 * movement, selection state, and key handling - so `extension-impl.ts` only has
 * to gather the inventory, hand over the stored record, and persist whatever
 * intent comes back. It performs no I/O, opens no store, reads no environment,
 * and never throws on an expected path.
 *
 * Contract notes that shape this file, mirroring `plan-task-list.ts`:
 * - `render(width)` must return lines whose visible width never exceeds
 *   `width`, so every line is truncated as plain text *before* styling.
 * - `invalidate()` is called on theme change and drops every cached string.
 * - Key handling goes through `matchesKey()` against the keys the host's
 *   injected keybindings manager resolves, so `~/.pi/agent/keybindings.json`
 *   takes effect here. Only the three surface-specific accelerators
 *   (`space`, `a`, `n`) are fixed literals, because Pi has no binding for them.
 *
 * Two invariants are structural rather than merely rendered:
 * - The Weave adapter row is pinned first *unconditionally*, is not
 *   toggleable, and can never appear in a saved payload. The row states a
 *   contract - every child loads Weave - so it is rendered from that contract
 *   rather than from inventory evidence, and a degraded collection that never
 *   observed the adapter still shows it. `buildPiConfigSaveIntent` rejects any
 *   state that names it, so a caller cannot construct one by hand either.
 * - A degraded inventory opens read-only. An incomplete list of extensions
 *   would silently persist as "the user deselected everything missing", which
 *   is exactly the payload that would strip a child of its model provider.
 *
 * The overlay is also honest about drift. A stored entry the live inventory no
 * longer offers is merged in as an unavailable, non-toggleable row instead of
 * vanishing, because the user is about to decide what to keep and cannot
 * decide about something they cannot see. Saving still drops it, matching the
 * spawn path, and the row says so before the user commits.
 */
import {
  type KeyId,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";
import {
  CHILD_EXTENSION_SELECTION_SCHEMA_VERSION,
  type ChildExtensionSelectionEntry,
  type ChildExtensionSelectionMode,
  type ChildExtensionSelectionRecord,
  isSafeChildExtensionPath,
  MAX_CHILD_EXTENSION_ENTRIES,
} from "./child-extension-selection.js";

/** Lines the overlay spends on its own title, guidance, separator, and hint. */
const CHROME_LINES = 7;

/** Rows Pi keeps for its own editor, footer, status, and padding. */
const RESERVED_HOST_ROWS = 6;

/** Smallest row window the overlay will render, so a tiny terminal still scrolls. */
const MIN_VISIBLE_ROWS = 3;

/** Largest row window, so a tall terminal does not become a full-screen takeover. */
const MAX_VISIBLE_ROWS = 20;

/** Height assumed when the host cannot report a usable terminal height. */
const FALLBACK_TERMINAL_ROWS = 24;

/** Smallest width the layout reasons about; below this everything truncates. */
const MIN_RENDER_WIDTH = 1;

/** The pinned first row's label. It is never toggleable and never persisted. */
export const PI_CONFIG_MANDATORY_ROW_LABEL =
  "Weave adapter — always enabled" as const;

/**
 * Scope shown for a row that exists only in the stored record.
 *
 * The live inventory never described it, so no real scope (`user`, `project`,
 * `temporary`) can be claimed for it without inventing evidence. "stored" is
 * the one thing that is actually known: it came from the saved selection.
 */
export const PI_CONFIG_STORED_ONLY_SCOPE = "stored" as const;

/** Tag on any row the live inventory cannot honour. */
export const PI_CONFIG_UNAVAILABLE_TAG = "unavailable" as const;

/**
 * Tag on a stored row a save would omit. It names the consequence rather than
 * the state, because that is the part the user has to decide about.
 */
export const PI_CONFIG_DROPPED_TAG = "dropped on save" as const;

/** Tag on the pinned row when the inventory never listed the Weave adapter. */
export const PI_CONFIG_MANDATORY_UNLISTED_TAG = "not in inventory" as const;

/** The explicit row that returns the child to Pi's own extension set. */
export const PI_CONFIG_INHERIT_ROW_LABEL =
  "Inherit all extensions (default)" as const;

/** Bindings this surface consumes from the host's keybindings manager. */
export type PiConfigBinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.confirm"
  | "tui.select.cancel";

/**
 * Used only when the host does not provide a keybindings manager, does not
 * provide `getKeys()`, or does not know a binding at all.
 *
 * An older host that has never heard of `tui.select.confirm` must not leave a
 * *mutating* overlay with no way to save; an explicitly configured empty list
 * still means "unbound", because that is a user decision rather than a gap.
 */
interface PiConfigDefaultBindingKeys {
  readonly "tui.select.up": readonly KeyId[];
  readonly "tui.select.down": readonly KeyId[];
  readonly "tui.select.confirm": readonly KeyId[];
  readonly "tui.select.cancel": readonly KeyId[];
}

const DEFAULT_BINDING_KEYS = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
} satisfies PiConfigDefaultBindingKeys;

/** Toggle a row. Fixed because Pi binds no equivalent action. */
const TOGGLE_KEY: KeyId = "space";
/** Select every available optional extension. */
const SELECT_ALL_KEY: KeyId = "a";
/** Select no optional extension. */
const SELECT_NONE_KEY: KeyId = "n";

/** Narrow projection of Pi's `KeybindingsManager`. */
export interface PiConfigKeybindingsPort {
  getKeys?(binding: PiConfigBinding): readonly KeyId[] | undefined;
}

/** Narrow projection of the theme helpers this surface uses. */
export interface PiConfigThemePort {
  fg(
    color: "accent" | "muted" | "text" | "success" | "dim" | "warning",
    text: string,
  ): string;
  bold(text: string): string;
}

type PiConfigGetKeys = NonNullable<PiConfigKeybindingsPort["getKeys"]>;
interface PiConfigParsedTheme {
  readonly owner: PiConfigThemePort;
  readonly fg: PiConfigThemePort["fg"];
  readonly bold: PiConfigThemePort["bold"];
}

const PI_CONFIG_OBSERVED_VALUE_SCHEMA = z.unknown();
type PiConfigObservedValue = z.input<typeof PI_CONFIG_OBSERVED_VALUE_SCHEMA>;
const PI_CONFIG_CALLABLE_CHECK = (value: PiConfigObservedValue): boolean =>
  Result.fromThrowable(
    () => value instanceof Function,
    (): boolean => false,
  )().unwrapOr(false);
const PI_CONFIG_GET_KEYS_SCHEMA = z.custom<PiConfigGetKeys>(
  PI_CONFIG_CALLABLE_CHECK,
);
type PiConfigCallable =
  | PiConfigGetKeys
  | PiConfigThemePort["fg"]
  | PiConfigThemePort["bold"];
const PI_CONFIG_MEMBER_SCHEMA = z.custom<PiConfigCallable>(
  PI_CONFIG_CALLABLE_CHECK,
);
const PI_CONFIG_THEME_FG_SCHEMA = z.custom<PiConfigThemePort["fg"]>(
  PI_CONFIG_CALLABLE_CHECK,
);
const PI_CONFIG_THEME_BOLD_SCHEMA = z.custom<PiConfigThemePort["bold"]>(
  PI_CONFIG_CALLABLE_CHECK,
);
interface PiConfigObjectReference {
  readonly piConfigObjectMarker?: never;
}
const PI_CONFIG_OBJECT_SCHEMA = z.custom<PiConfigObjectReference>((value) =>
  Result.fromThrowable(
    (): boolean =>
      value !== null &&
      Object(value) === value &&
      !Array.isArray(value) &&
      !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);
type PiConfigMember = z.output<typeof PI_CONFIG_MEMBER_SCHEMA>;

function readPiConfigMember(
  target: PiConfigObservedValue,
  key: string,
): PiConfigMember | undefined {
  const parsedTarget = PI_CONFIG_OBJECT_SCHEMA.safeParse(target);
  if (!parsedTarget.success) return undefined;
  let current: object | null = parsedTarget.data;
  const seen = new Set<object>();
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(current, key),
      (): PropertyDescriptor | undefined => undefined,
    )();
    if (descriptor.isErr()) return undefined;
    if (descriptor.value !== undefined) {
      if (!("value" in descriptor.value)) return undefined;
      const parsed = PI_CONFIG_MEMBER_SCHEMA.safeParse(descriptor.value.value);
      return parsed.success ? parsed.data : undefined;
    }
    const prototype = Result.fromThrowable(
      () => Object.getPrototypeOf(current),
      (): object | null => null,
    )();
    if (prototype.isErr()) return undefined;
    current = prototype.value;
  }
  return undefined;
}

function parsePiConfigKeybindings(
  keybindings: PiConfigKeybindingsPort | undefined,
): { readonly getKeys?: PiConfigGetKeys } | undefined {
  if (keybindings === undefined) return undefined;
  const value = readPiConfigMember(keybindings, "getKeys");
  if (value === undefined) return {};
  const parsed = PI_CONFIG_GET_KEYS_SCHEMA.safeParse(value);
  return parsed.success ? { getKeys: parsed.data } : undefined;
}

function parsePiConfigTheme(
  theme: PiConfigThemePort | undefined,
): PiConfigParsedTheme | undefined {
  if (theme === undefined) return undefined;
  const fg = readPiConfigMember(theme, "fg");
  const bold = readPiConfigMember(theme, "bold");
  const parsedFg = PI_CONFIG_THEME_FG_SCHEMA.safeParse(fg);
  const parsedBold = PI_CONFIG_THEME_BOLD_SCHEMA.safeParse(bold);
  return parsedFg.success && parsedBold.success
    ? { owner: theme, fg: parsedFg.data, bold: parsedBold.data }
    : undefined;
}

/**
 * One extension the overlay can show. `PiExtensionInventoryEntry` is
 * structurally assignable to it, which is how the command feeds this module
 * without dragging the inventory's collection concerns into the UI.
 */
export interface PiConfigExtensionEntry {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly path: string;
  readonly scope: string;
  readonly mandatory: boolean;
  readonly available: boolean;
}

/** Canonical scope order. Anything unrecognized sorts last, then by label. */
const SCOPE_ORDER: readonly string[] = ["user", "project", "temporary"];

function scopeRank(scope: string): number {
  const index = SCOPE_ORDER.indexOf(scope);
  return index === -1 ? SCOPE_ORDER.length : index;
}

/**
 * A rendered row. Only `optional` rows carry a togglable extension.
 *
 * The mandatory row's `entry` is optional because the row is a contract, not
 * an observation: a degraded collection may never have seen the adapter, and
 * the row must still be pinned.
 */
export type PiConfigRow =
  | { readonly kind: "mandatory"; readonly entry?: PiConfigExtensionEntry }
  | { readonly kind: "inherit" }
  | { readonly kind: "optional"; readonly entry: PiConfigExtensionEntry };

/**
 * Merges the stored record's entries into the display list.
 *
 * A stored id the live inventory no longer offers becomes an unavailable row
 * rather than disappearing: the user is deciding what a child loads, and an
 * invisible difference between "what is stored" and "what is shown" turns save
 * into a silent edit. The merged row keeps the stored label, source, and path
 * so the extension is recognizable, claims no live scope it cannot prove, and
 * is never toggleable or savable.
 */
export function mergePiConfigEntries(
  entries: readonly PiConfigExtensionEntry[],
  record: ChildExtensionSelectionRecord | undefined,
): readonly PiConfigExtensionEntry[] {
  if (record === undefined || record.mode !== "explicit") return entries;
  const known = new Set(entries.map((entry) => entry.id));
  const merged = entries.slice();
  // The codec already bounds the record, but the display list is bounded here
  // too so a future decode relaxation cannot grow this surface unnoticed.
  for (const stored of record.entries.slice(0, MAX_CHILD_EXTENSION_ENTRIES)) {
    if (known.has(stored.id)) continue;
    known.add(stored.id);
    merged.push({
      id: stored.id,
      label: stored.label,
      source: stored.source,
      path: stored.path,
      scope: PI_CONFIG_STORED_ONLY_SCOPE,
      mandatory: false,
      available: false,
    });
  }
  return merged;
}

/**
 * Builds the row list: the mandatory Weave row first, then the inherit-all
 * row, then every optional extension ordered by scope and label.
 *
 * The mandatory row is always emitted, with or without a matching inventory
 * entry. More than one mandatory entry cannot happen with a real inventory,
 * but the first one wins rather than rendering two locked rows.
 */
export function buildPiConfigRows(
  entries: readonly PiConfigExtensionEntry[],
): readonly PiConfigRow[] {
  const mandatory = entries.find((entry) => entry.mandatory);
  const optional = entries
    .filter((entry) => !entry.mandatory)
    .slice()
    .sort((left, right) => {
      const byScope = scopeRank(left.scope) - scopeRank(right.scope);
      if (byScope !== 0) return byScope;
      const byLabel = left.label.localeCompare(right.label);
      return byLabel !== 0 ? byLabel : left.id.localeCompare(right.id);
    });
  const rows: PiConfigRow[] = [
    mandatory === undefined
      ? { kind: "mandatory" }
      : { kind: "mandatory", entry: mandatory },
  ];
  rows.push({ kind: "inherit" });
  for (const entry of optional) rows.push({ kind: "optional", entry });
  return rows;
}

/** The overlay's mutable state, exposed so the model can be tested directly. */
export interface PiConfigSelectionState {
  readonly mode: ChildExtensionSelectionMode;
  /**
   * Ids of selected optional entries. Never contains the mandatory id, and
   * never contains an id a save could not honour.
   */
  readonly selected: ReadonlySet<string>;
  /**
   * Ids the stored record selected that the live inventory cannot honour -
   * either missing entirely or present but unavailable.
   *
   * Kept out of `selected` so no code path can mistake them for a savable
   * choice, and kept at all so the rows can say they were part of the stored
   * selection and that saving will drop them.
   */
  readonly unavailableStored?: ReadonlySet<string>;
}

/**
 * Seeds the state from the stored record.
 *
 * A stored id the inventory cannot honour is never selectable, because the
 * save must only ever persist what the user can see and a child can load. It
 * is remembered separately instead of forgotten, so the row can show the drift
 * before the user decides.
 */
export function initialPiConfigSelection(
  record: ChildExtensionSelectionRecord | undefined,
  entries: readonly PiConfigExtensionEntry[],
): PiConfigSelectionState {
  const selectable = new Set(
    entries
      .filter((entry) => !entry.mandatory && entry.available)
      .map((entry) => entry.id),
  );
  if (record === undefined || record.mode === "inherit-all") {
    return { mode: "inherit-all", selected: new Set() };
  }
  const selected = new Set<string>();
  const unavailableStored = new Set<string>();
  for (const entry of record.entries) {
    if (selectable.has(entry.id)) selected.add(entry.id);
    else unavailableStored.add(entry.id);
  }
  return { mode: "explicit", selected, unavailableStored };
}

/** What the command should persist. */
export type PiConfigSaveIntent =
  | { readonly kind: "inherit-all" }
  | {
      readonly kind: "explicit";
      readonly record: ChildExtensionSelectionRecord;
    };

/** Why a save payload was refused. Every reason is a caller bug, not a user error. */
export type PiConfigSaveError =
  | { readonly reason: "mandatory-entry-in-payload" }
  | { readonly reason: "too-many-entries"; readonly count: number }
  | { readonly reason: "read-only" };

export interface BuildPiConfigSaveIntentInput {
  readonly state: PiConfigSelectionState;
  readonly entries: readonly PiConfigExtensionEntry[];
  /** A degraded inventory can be read but never saved. */
  readonly readOnly?: boolean;
}

/**
 * Turns the current state into the intent the command persists.
 *
 * The Weave adapter is never part of the payload: it is derived at spawn time
 * from live evidence, so a record that named it could only ever be wrong. A
 * state that names it is refused rather than filtered, because silently
 * dropping it would hide the fact that something built an illegal payload.
 * Unknown, unavailable, and unsafe-path entries are dropped, since those are
 * ordinary inventory drift rather than an illegal request.
 */
export function buildPiConfigSaveIntent(
  input: BuildPiConfigSaveIntentInput,
): Result<PiConfigSaveIntent, PiConfigSaveError> {
  if (input.readOnly === true) return err({ reason: "read-only" });
  const byId = new Map(
    input.entries.map((entry) => [entry.id, entry] as const),
  );
  for (const id of input.state.selected) {
    if (byId.get(id)?.mandatory === true) {
      return err({ reason: "mandatory-entry-in-payload" });
    }
  }
  if (input.state.mode === "inherit-all") return ok({ kind: "inherit-all" });

  const entries: ChildExtensionSelectionEntry[] = [];
  for (const row of buildPiConfigRows(input.entries)) {
    if (row.kind !== "optional") continue;
    const entry = row.entry;
    if (!input.state.selected.has(entry.id)) continue;
    if (!entry.available) continue;
    if (!isSafeChildExtensionPath(entry.path)) continue;
    entries.push({
      id: entry.id,
      source: entry.source,
      path: entry.path,
      label: entry.label,
    });
  }
  if (entries.length > MAX_CHILD_EXTENSION_ENTRIES) {
    return err({ reason: "too-many-entries", count: entries.length });
  }
  return ok({
    kind: "explicit",
    record: {
      schemaVersion: CHILD_EXTENSION_SELECTION_SCHEMA_VERSION,
      mode: "explicit",
      entries,
    },
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Rows the overlay may occupy on a terminal of `terminalRows` height. */
export function piConfigRowBudget(terminalRows: number | undefined): number {
  const usable =
    terminalRows !== undefined &&
    Number.isFinite(terminalRows) &&
    terminalRows > 0
      ? Math.trunc(terminalRows)
      : FALLBACK_TERMINAL_ROWS;
  const preferred = Math.max(
    MIN_VISIBLE_ROWS + CHROME_LINES,
    Math.min(usable - RESERVED_HOST_ROWS, MAX_VISIBLE_ROWS + CHROME_LINES),
  );
  return clamp(preferred, 1, usable);
}

/** Extension rows that fit in a viewport of `rows` total height. */
export function piConfigVisibleRows(rows: number): number {
  const total = Number.isFinite(rows) ? Math.trunc(rows) : 0;
  return clamp(total - CHROME_LINES, 0, MAX_VISIBLE_ROWS);
}

/** Highest scroll offset that still fills the viewport. */
export function piConfigMaxScroll(rowCount: number, rows: number): number {
  const visible = piConfigVisibleRows(rows);
  if (visible <= 0) return 0;
  return Math.max(0, rowCount - visible);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface PiConfigViewport {
  readonly rows: number;
  readonly scrollOffset: number;
}

export interface RenderPiConfigInput {
  readonly rows: readonly PiConfigRow[];
  readonly state: PiConfigSelectionState;
  readonly cursor: number;
  readonly viewport: PiConfigViewport;
  /** Terminal columns. Omitted only by callers that want untruncated text. */
  readonly width?: number;
  readonly theme?: PiConfigThemePort;
  /** Trailing hint, so the component can name the user's actual keys. */
  readonly hint?: string;
  /** True when a degraded inventory forced a read-only open. */
  readonly readOnly?: boolean;
}

interface PiConfigRenderInputBuilder {
  rows: readonly PiConfigRow[];
  state: PiConfigSelectionState;
  cursor: number;
  viewport: PiConfigViewport;
  width: number;
  hint: string;
  theme?: PiConfigThemePort;
  readOnly?: boolean;
}

type StyleColor = "accent" | "muted" | "text" | "success" | "dim" | "warning";

interface PiConfigRowMarker {
  readonly marker: string;
  readonly color: StyleColor;
}

/** True when the row was in the stored selection but cannot be honoured. */
function isDroppedStoredRow(
  row: PiConfigRow,
  state: PiConfigSelectionState,
): boolean {
  return (
    row.kind === "optional" &&
    !row.entry.available &&
    state.unavailableStored?.has(row.entry.id) === true
  );
}

function rowMarker(
  row: PiConfigRow,
  state: PiConfigSelectionState,
): PiConfigRowMarker {
  if (row.kind === "mandatory") {
    // No checkbox: a locked row must not look like something the user failed
    // to toggle.
    return { marker: "\u25c6", color: "accent" };
  }
  if (row.kind === "inherit") {
    return state.mode === "inherit-all"
      ? { marker: "(\u2022)", color: "success" }
      : { marker: "( )", color: "muted" };
  }
  if (!row.entry.available) {
    // A stored row that will be dropped is neither ticked nor blank: it is a
    // pending loss, so it gets its own mark rather than borrowing one that
    // would read as an ordinary unchecked box.
    return isDroppedStoredRow(row, state)
      ? { marker: "[!]", color: "warning" }
      : { marker: "[ ]", color: "muted" };
  }
  return state.selected.has(row.entry.id)
    ? { marker: "[x]", color: "success" }
    : { marker: "[ ]", color: "muted" };
}

/**
 * Row colour: the cursor wins, then anything the user cannot act on is dim,
 * then the row's own selection colour.
 */
function rowColor(
  row: PiConfigRow,
  state: PiConfigSelectionState,
  active: boolean,
): StyleColor {
  if (active) return "accent";
  if (row.kind === "mandatory") return "dim";
  // A row the user is about to lose is a warning, not background noise; every
  // other unavailable row stays dim because nothing depends on it.
  if (isDroppedStoredRow(row, state)) return "warning";
  if (row.kind === "optional" && !row.entry.available) return "dim";
  return rowMarker(row, state).color;
}

function rowText(row: PiConfigRow, state: PiConfigSelectionState): string {
  const marker = rowMarker(row, state).marker;
  if (row.kind === "mandatory") {
    // The label is a contract. When the inventory never listed the adapter the
    // row says exactly that instead of implying evidence it does not have.
    const tags =
      row.entry === undefined
        ? `mandatory \u00b7 ${PI_CONFIG_MANDATORY_UNLISTED_TAG}`
        : "mandatory";
    return `${marker} ${PI_CONFIG_MANDATORY_ROW_LABEL}  ${tags}`;
  }
  if (row.kind === "inherit") return `${marker} ${PI_CONFIG_INHERIT_ROW_LABEL}`;
  const tags = [row.entry.scope];
  if (!row.entry.available) {
    tags.push(PI_CONFIG_UNAVAILABLE_TAG);
    if (isDroppedStoredRow(row, state)) tags.push(PI_CONFIG_DROPPED_TAG);
  } else if (state.mode === "inherit-all") {
    tags.push("inherited");
  }
  return `${marker} ${row.entry.label}  ${tags.join(" \u00b7 ")}`;
}

/**
 * Renders the overlay.
 *
 * The header states the three facts a user needs before changing anything:
 * what a child will load, what it loses, and when the change takes effect.
 * They are header text rather than a one-shot notice because the consequence
 * has to be visible at the moment of the decision.
 */
export function renderPiConfigLines(input: RenderPiConfigInput): string[] {
  const theme = parsePiConfigTheme(input.theme);
  const fg = theme?.fg.bind(theme.owner);
  const bold = theme?.bold.bind(theme.owner);
  const cap =
    input.width === undefined
      ? undefined
      : Math.max(MIN_RENDER_WIDTH, Math.trunc(input.width));
  const fit = (text: string): string =>
    cap === undefined ? text : truncateToWidth(text, cap);
  const style = (text: string, color: StyleColor, useBold = false): string => {
    if (fg === undefined) return useBold ? (bold?.(text) ?? text) : text;
    const colored = fg(color, text);
    return useBold ? (bold?.(colored) ?? colored) : colored;
  };

  const totalRows = Math.max(
    0,
    Number.isFinite(input.viewport.rows) ? Math.trunc(input.viewport.rows) : 0,
  );
  if (totalRows <= 0) return [];

  const optionalCount = input.rows.filter(
    (row) => row.kind === "optional",
  ).length;
  const selectedCount =
    input.state.mode === "inherit-all"
      ? optionalCount
      : input.state.selected.size;
  const title =
    input.state.mode === "inherit-all"
      ? `Weave child extensions \u2014 inheriting all ${optionalCount} optional`
      : `Weave child extensions \u2014 ${selectedCount} of ${optionalCount} optional selected`;

  const lines: string[] = [style(fit(title), "accent", true)];
  lines.push(
    style(
      fit("Children load only the selected extensions plus Weave."),
      "text",
    ),
  );
  lines.push(
    style(
      fit(
        "Unselected provider extensions supply no models or credentials to children.",
      ),
      "warning",
    ),
  );
  lines.push(
    style(
      fit(
        "Changes apply to children spawned after this session's next start, never to running children.",
      ),
      "muted",
    ),
  );
  const droppedCount = input.rows.filter((row) =>
    isDroppedStoredRow(row, input.state),
  ).length;
  if (input.readOnly === true) {
    lines.push(
      style(
        fit(
          "Read-only: the extension inventory is incomplete, so no selection can be saved.",
        ),
        "warning",
      ),
    );
  } else if (droppedCount > 0) {
    // Stated before the decision, not after it: saving is what removes these,
    // and cancelling is what keeps the stored record as it is.
    lines.push(
      style(
        fit(
          `${droppedCount} stored extension${droppedCount === 1 ? "" : "s"} ${droppedCount === 1 ? "is" : "are"} unavailable and saving drops ${droppedCount === 1 ? "it" : "them"}; cancel keeps the stored selection.`,
        ),
        "warning",
      ),
    );
  } else {
    lines.push("");
  }

  const visible = piConfigVisibleRows(totalRows);
  const maxScroll = piConfigMaxScroll(input.rows.length, totalRows);
  const offset = clamp(Math.trunc(input.viewport.scrollOffset), 0, maxScroll);
  const window = input.rows.slice(offset, offset + visible);
  for (const [index, row] of window.entries()) {
    const ordinal = offset + index;
    const active = ordinal === input.cursor;
    const cursor = active ? "\u203a" : " ";
    lines.push(
      style(
        fit(`${cursor} ${rowText(row, input.state)}`),
        rowColor(row, input.state, active),
      ),
    );
  }

  const hidden = input.rows.length - window.length - offset;
  if (hidden > 0) {
    lines.push(style(fit(`${hidden} more below`), "dim"));
  } else {
    lines.push("");
  }
  lines.push(style(fit(input.hint ?? ""), "dim"));
  return lines.slice(0, totalRows);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Pi `Component` shape this module produces. */
export interface PiConfigComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface CreatePiConfigComponentInput {
  readonly entries: readonly PiConfigExtensionEntry[];
  /** The decoded stored record, or `undefined` when nothing is stored. */
  readonly record?: ChildExtensionSelectionRecord | undefined;
  /** A degraded inventory opens read-only: it can be read but never saved. */
  readonly readOnly?: boolean;
  readonly theme?: PiConfigThemePort;
  readonly keybindings?: PiConfigKeybindingsPort;
  readonly getTerminalRows?: () => number | undefined;
  /** Called at most once, with the intent to persist. */
  readonly onSave: (intent: PiConfigSaveIntent) => void;
  /** Called at most once, when the user cancels. Never writes anything. */
  readonly onCancel: () => void;
  /** Called at most once, when a save payload is refused. */
  readonly onRejected?: (error: PiConfigSaveError) => void;
  /** Called after any state change, so the host can request a re-render. */
  readonly onChange?: () => void;
  /** Guard so a stale generation renders nothing instead of a dead selection. */
  readonly isCurrent?: () => boolean;
  /** Called at most once, the first time a stale generation is observed. */
  readonly onStale?: () => void;
}

function resolveKeys(
  keybindings: PiConfigKeybindingsPort | undefined,
  binding: PiConfigBinding,
): readonly KeyId[] {
  const parsed = parsePiConfigKeybindings(keybindings);
  return (
    parsed?.getKeys?.call(keybindings, binding) ?? DEFAULT_BINDING_KEYS[binding]
  );
}

function matchesAny(data: string, keys: readonly KeyId[]): boolean {
  for (const key of keys) {
    if (matchesKey(data, key)) return true;
  }
  return false;
}

/** Hint naming the keys the user actually has bound. */
export function buildPiConfigHint(input: {
  readonly up: readonly KeyId[];
  readonly down: readonly KeyId[];
  readonly confirm: readonly KeyId[];
  readonly cancel: readonly KeyId[];
  readonly readOnly?: boolean;
}): string {
  const first = (keys: readonly KeyId[]): string => keys[0] ?? "unbound";
  const move = `${first(input.up)}/${first(input.down)} move`;
  const close = `${first(input.cancel)} close`;
  if (input.readOnly === true) return `${move} \u00b7 ${close}`;
  return [
    move,
    `${TOGGLE_KEY} toggle`,
    `${SELECT_ALL_KEY} all`,
    `${SELECT_NONE_KEY} none`,
    `${first(input.confirm)} save`,
    `${first(input.cancel)} cancel`,
  ].join(" \u00b7 ");
}

/**
 * Builds the `/weave:pi-config` component. The caller owns the inventory, the
 * stored record, and persistence; this function owns everything the terminal
 * sees and everything the user can express.
 */
export function createPiConfigComponent(
  input: CreatePiConfigComponentInput,
): PiConfigComponent {
  const upKeys = resolveKeys(input.keybindings, "tui.select.up");
  const downKeys = resolveKeys(input.keybindings, "tui.select.down");
  const confirmKeys = resolveKeys(input.keybindings, "tui.select.confirm");
  const cancelKeys = resolveKeys(input.keybindings, "tui.select.cancel");
  const readOnly = input.readOnly === true;
  const hint = buildPiConfigHint({
    up: upKeys,
    down: downKeys,
    confirm: confirmKeys,
    cancel: cancelKeys,
    readOnly,
  });

  // The display list, not the raw inventory: a stored entry the inventory no
  // longer offers still has to be visible, orderable, and un-savable.
  const entries = mergePiConfigEntries(input.entries, input.record);
  const rows = buildPiConfigRows(entries);
  const seed = initialPiConfigSelection(input.record, entries);
  let mode = seed.mode;
  const selected = new Set(seed.selected);
  // Fixed for the overlay's life: it describes the stored record, which this
  // surface never edits in place, so toggling must not rewrite it.
  const unavailableStored: ReadonlySet<string> = new Set(
    seed.unavailableStored ?? [],
  );
  const currentState = (): PiConfigSelectionState => ({
    mode,
    selected,
    unavailableStored,
  });
  // Open on the first row the user can actually act on.
  let cursor = rows.findIndex((row) => row.kind !== "mandatory");
  if (cursor < 0) cursor = 0;
  let scrollOffset = 0;
  let settled = false;
  let staleNotified = false;
  let cachedWidth: number | undefined;
  let cachedRows: number | undefined;
  let cachedLines: string[] | undefined;

  const rowsNow = (): number => piConfigRowBudget(input.getTerminalRows?.());

  const notifyStale = (): void => {
    if (staleNotified) return;
    staleNotified = true;
    input.onStale?.();
  };

  const invalidate = (): void => {
    cachedWidth = undefined;
    cachedRows = undefined;
    cachedLines = undefined;
  };

  const ensureCursorVisible = (): void => {
    const visible = piConfigVisibleRows(rowsNow());
    if (visible <= 0) {
      scrollOffset = 0;
      return;
    }
    if (cursor < scrollOffset) scrollOffset = cursor;
    else if (cursor >= scrollOffset + visible)
      scrollOffset = cursor - visible + 1;
    scrollOffset = clamp(
      scrollOffset,
      0,
      piConfigMaxScroll(rows.length, rowsNow()),
    );
  };

  const moveBy = (delta: number): void => {
    if (rows.length === 0) return;
    const next = clamp(cursor + delta, 0, rows.length - 1);
    if (next === cursor) return;
    cursor = next;
    ensureCursorVisible();
    invalidate();
  };

  const selectableEntries = (): readonly PiConfigExtensionEntry[] =>
    rows
      .filter(
        (row): row is { kind: "optional"; entry: PiConfigExtensionEntry } =>
          row.kind === "optional",
      )
      .map((row) => row.entry)
      .filter((entry) => entry.available);

  const toggleCurrent = (): void => {
    const row = rows[cursor];
    if (row === undefined) return;
    // The mandatory row has no toggle at all: pressing space on it is a
    // deliberate no-op rather than a silent failed write.
    if (row.kind === "mandatory") return;
    if (row.kind === "inherit") {
      mode = mode === "inherit-all" ? "explicit" : "inherit-all";
      invalidate();
      return;
    }
    if (!row.entry.available) return;
    // Toggling an extension is an explicit statement about the child's set,
    // so it leaves inherit-all rather than quietly doing nothing.
    if (mode === "inherit-all") {
      mode = "explicit";
      selected.clear();
    }
    if (selected.has(row.entry.id)) selected.delete(row.entry.id);
    else selected.add(row.entry.id);
    invalidate();
  };

  const selectAll = (): void => {
    mode = "explicit";
    selected.clear();
    for (const entry of selectableEntries()) selected.add(entry.id);
    invalidate();
  };

  const selectNone = (): void => {
    mode = "explicit";
    selected.clear();
    invalidate();
  };

  const save = (): void => {
    const state = currentState();
    const intent = readOnly
      ? buildPiConfigSaveIntent({ state, entries, readOnly: true })
      : buildPiConfigSaveIntent({ state, entries });
    if (intent.isErr()) {
      // A refused payload still ends the overlay: leaving the user inside a
      // surface whose Enter does nothing is worse than closing with a reason.
      settled = true;
      input.onRejected?.(intent.error);
      input.onCancel();
      return;
    }
    settled = true;
    input.onSave(intent.value);
  };

  return {
    render(width) {
      if (input.isCurrent?.() === false) {
        notifyStale();
        return [];
      }
      const viewportRows = rowsNow();
      if (
        cachedLines !== undefined &&
        cachedWidth === width &&
        cachedRows === viewportRows
      ) {
        return cachedLines;
      }
      scrollOffset = clamp(
        scrollOffset,
        0,
        piConfigMaxScroll(rows.length, viewportRows),
      );
      const renderInput: PiConfigRenderInputBuilder = {
        rows,
        state: currentState(),
        cursor,
        viewport: { rows: viewportRows, scrollOffset },
        width,
        hint,
      };
      if (input.theme !== undefined) renderInput.theme = input.theme;
      if (readOnly) renderInput.readOnly = true;
      const lines = renderPiConfigLines(renderInput);
      cachedLines = lines;
      cachedWidth = width;
      cachedRows = viewportRows;
      return lines;
    },
    handleInput(data) {
      if (settled) return;
      if (input.isCurrent?.() === false) {
        notifyStale();
        return;
      }
      if (matchesAny(data, cancelKeys)) {
        settled = true;
        input.onCancel();
        return;
      }
      if (matchesAny(data, confirmKeys)) {
        if (readOnly) {
          settled = true;
          input.onCancel();
          return;
        }
        save();
        return;
      }
      if (matchesAny(data, upKeys)) {
        moveBy(-1);
        input.onChange?.();
        return;
      }
      if (matchesAny(data, downKeys)) {
        moveBy(1);
        input.onChange?.();
        return;
      }
      if (readOnly) return;
      if (matchesKey(data, TOGGLE_KEY)) {
        toggleCurrent();
        input.onChange?.();
        return;
      }
      if (matchesKey(data, SELECT_ALL_KEY)) {
        selectAll();
        input.onChange?.();
        return;
      }
      if (matchesKey(data, SELECT_NONE_KEY)) {
        selectNone();
        input.onChange?.();
      }
      // Everything else is ignored: this surface owns no action beyond
      // movement, selection, save, and cancel.
    },
    invalidate,
  };
}
