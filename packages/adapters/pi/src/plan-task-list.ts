/**
 * The Alt+T plan-task list: a read-only Pi TUI component over the active
 * plan's parent tasks.
 *
 * This module owns the whole surface - layout, width safety, scrolling, theme
 * caching, and key handling - so `extension.ts` only has to resolve the active
 * plan (through the shared resolver it already uses for the widget and the
 * footer) and hand the snapshot over. The component never reads plan state,
 * never resolves which plan is active, and never mutates anything: no
 * execution starts, resumes, or is cancelled through it.
 *
 * Pi contract notes that shape this file:
 * - `render(width)` must return lines whose `visibleWidth` never exceeds
 *   `width`, so every line goes through `truncateToWidth` on a plain string
 *   before any ANSI styling is applied (styling is width-invisible).
 * - `invalidate()` is called on theme change and must drop every cached
 *   themed string, not just the line cache.
 * - Key handling must go through `matchesKey()` against the keys the host's
 *   injected keybindings manager resolves for `tui.select.up`,
 *   `tui.select.down`, and `tui.select.cancel`. Raw byte comparisons would
 *   ignore user configuration in `~/.pi/agent/keybindings.json`.
 */
import {
  type KeyId,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  type PlanTaskNode,
  type PlanTaskSnapshot,
  selectActivePlanTask,
} from "@weaveio/weave-engine";

/**
 * The key that opens the plan-task list. Lives beside the component rather
 * than in `extension.ts` so the registration test and the popup share one
 * source of truth, exactly as `PI_PRIMARY_AGENT_CYCLE_SHORTCUT` does for
 * Alt+A.
 */
export const PI_PLAN_TASK_LIST_SHORTCUT = "alt+t";

/** Lines the popup spends on its own title, blank separator, and hint. */
const CHROME_LINES = 4;

/**
 * Chrome the popup cannot drop even on a terminal too small for the ordinary
 * layout: one title line and one hint line. The blank separator is the first
 * thing sacrificed.
 */
const COMPACT_CHROME_LINES = 2;

/** Rows Pi keeps for its own editor, footer, status, and padding. */
const RESERVED_HOST_ROWS = 6;

/** Smallest viewport the popup will render, so a tiny terminal still scrolls. */
const MIN_VISIBLE_ROWS = 3;

/**
 * Largest viewport the popup will render. A very tall terminal should not turn
 * a read-only overlay into a full-screen takeover, and the cap also bounds the
 * work `render()` does for a huge plan.
 */
const MAX_VISIBLE_ROWS = 24;

/** Height assumed when the host cannot report a usable terminal height. */
const FALLBACK_TERMINAL_ROWS = 24;

/** The only keybindings this read-only surface consumes. */
export type PlanTaskListBinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.cancel";

/**
 * Fallbacks used only when the host does not provide a keybinding manager or
 * `getKeys()`. A provided `getKeys()` that returns no keys leaves the action
 * unbound rather than restoring these defaults.
 */
const DEFAULT_BINDING_KEYS: Record<PlanTaskListBinding, readonly KeyId[]> = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.cancel": ["escape", "ctrl+c"],
};

/**
 * Narrow projection of Pi's `KeybindingsManager`. `getKeys` is optional
 * because simpler stand-ins satisfy the injected `keybindings` argument; when
 * it is missing the component falls back to Pi's documented defaults rather
 * than becoming unusable.
 */
export interface PlanTaskListKeybindingsPort {
  getKeys?(binding: PlanTaskListBinding): readonly KeyId[] | undefined;
}

/** Narrow projection of the theme helpers this surface uses. */
export interface PlanTaskListThemePort {
  fg(
    color: "accent" | "muted" | "text" | "success" | "dim",
    text: string,
  ): string;
  bold(text: string): string;
}

export interface PlanTaskListViewport {
  /** Total rows available to the popup, including its own chrome. */
  readonly rows: number;
  /** Index of the first task row rendered. */
  readonly scrollOffset: number;
}

export interface RenderPlanTaskListInput {
  readonly snapshot: PlanTaskSnapshot;
  readonly viewport: PlanTaskListViewport;
  /** Terminal columns. Omitted only by callers that want untruncated text. */
  readonly width?: number;
  readonly theme?: PlanTaskListThemePort;
  /** Trailing hint, so the component can name the user's actual keys. */
  readonly hint?: string;
}

function stateMarker(state: PlanTaskNode["state"]): string {
  if (state === "completed") return "[x]";
  if (state === "in_progress") return "[~]";
  return "[ ]";
}

function stateColor(
  state: PlanTaskNode["state"],
): "success" | "accent" | "muted" {
  if (state === "completed") return "success";
  if (state === "in_progress") return "accent";
  return "muted";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Number of task rows that fit in a viewport of `rows` total height.
 *
 * A roomy viewport keeps the ordinary 3..24 window. A viewport too small for
 * that layout does not pretend otherwise: it drops the blank separator and
 * reports only the rows that actually remain, down to zero. Reporting a
 * minimum the terminal cannot honour is what let the popup render more lines
 * than it had rows for.
 */
export function planTaskListVisibleRows(rows: number): number {
  const total = Number.isFinite(rows) ? Math.trunc(rows) : 0;
  const roomy = total - CHROME_LINES;
  if (roomy >= MIN_VISIBLE_ROWS) return Math.min(roomy, MAX_VISIBLE_ROWS);
  return Math.max(
    0,
    Math.min(total - COMPACT_CHROME_LINES, MIN_VISIBLE_ROWS - 1),
  );
}

/**
 * Rows the popup may occupy on a terminal of `terminalRows` height, after
 * leaving Pi's own editor and footer room. Falls back to a conservative
 * height when the host reports nothing usable.
 *
 * The returned budget is always at least 1 and never more than the terminal
 * actually has: the preferred minimum layout is a *preference*, not a licence
 * to overdraw a four-row terminal.
 */
export function planTaskListRowBudget(
  terminalRows: number | undefined,
): number {
  const usable =
    typeof terminalRows === "number" &&
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

/**
 * Highest scroll offset that still fills the viewport. A viewport with no task
 * rows cannot scroll at all, so the offset stays pinned at zero rather than
 * running off the end of the plan.
 */
export function planTaskListMaxScroll(taskCount: number, rows: number): number {
  const visible = planTaskListVisibleRows(rows);
  if (visible <= 0) return 0;
  return Math.max(0, taskCount - visible);
}

/**
 * Smallest scroll offset that keeps `index` inside the viewport, so the popup
 * opens on the active task instead of on a window that hides it.
 */
export function planTaskListOffsetForIndex(
  index: number | undefined,
  taskCount: number,
  rows: number,
): number {
  if (index === undefined || index < 0) return 0;
  const visible = planTaskListVisibleRows(rows);
  const maxScroll = planTaskListMaxScroll(taskCount, rows);
  if (index < visible) return 0;
  return clamp(index - visible + 1, 0, maxScroll);
}

/**
 * Renders the bounded, scrollable plan-task list. Returns an explanatory body
 * when the plan has no parent tasks - the popup always says something rather
 * than opening empty.
 *
 * Every line is truncated as plain text *before* styling, so styled output has
 * exactly the same visible width as unstyled output, and the number of lines
 * never exceeds `viewport.rows`.
 */
export function renderPlanTaskListLines(
  input: RenderPlanTaskListInput,
): string[] {
  const { parents, planName, totalParentCount } = input.snapshot;
  const theme = input.theme;
  // Hosts may hand over a partial theme object; a missing helper degrades to
  // unstyled text rather than crashing the overlay mid-render.
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : undefined;
  const bold =
    typeof theme?.bold === "function" ? theme.bold.bind(theme) : undefined;
  const cap =
    input.width === undefined
      ? undefined
      : Math.max(1, Math.trunc(input.width));
  const fit = (text: string): string =>
    cap === undefined ? text : truncateToWidth(text, cap);
  const style = (
    text: string,
    color: "accent" | "muted" | "text" | "success" | "dim",
    useBold = false,
  ): string => {
    if (fg === undefined) return useBold ? (bold?.(text) ?? text) : text;
    const colored = fg(color, text);
    return useBold ? (bold?.(colored) ?? colored) : colored;
  };

  const title = style(
    fit(
      `Plan "${planName}" - ${totalParentCount} task${totalParentCount === 1 ? "" : "s"}`,
    ),
    "accent",
    true,
  );
  const hint = input.hint ?? "Up/Down scrolls, Esc closes";
  const totalRows = Math.max(
    0,
    Number.isFinite(input.viewport.rows) ? Math.trunc(input.viewport.rows) : 0,
  );
  if (totalRows <= 0) return [];
  const visibleRows = planTaskListVisibleRows(input.viewport.rows);
  // The blank separator is the first line dropped when the terminal cannot
  // afford the ordinary layout.
  const separator = visibleRows >= MIN_VISIBLE_ROWS ? [""] : [];

  if (parents.length === 0) {
    return [
      title,
      ...separator,
      style(fit("This plan has no tasks."), "muted"),
      style(fit(hint), "dim"),
    ].slice(0, totalRows);
  }

  const activeIndex = selectActivePlanTask(input.snapshot).match(
    (activeTask) => activeTask.parentIndex,
    () => undefined,
  );

  const maxScroll = planTaskListMaxScroll(parents.length, input.viewport.rows);
  const offset = clamp(Math.trunc(input.viewport.scrollOffset), 0, maxScroll);
  const window = parents.slice(offset, offset + visibleRows);

  const lines = [title, ...separator];
  for (const [index, parent] of window.entries()) {
    const ordinal = offset + index;
    const active = ordinal === activeIndex;
    const cursor = active ? "\u203a" : " ";
    lines.push(
      style(
        fit(
          `${cursor} ${stateMarker(parent.state)} ${parent.id}. ${parent.title}`,
        ),
        active ? "accent" : stateColor(parent.state),
      ),
    );
  }

  const hidden = parents.length - window.length;
  lines.push(
    style(fit(hidden > 0 ? `${hidden} more \u2014 ${hint}` : hint), "dim"),
  );
  // Final guard: whatever the layout decided, the popup never claims more
  // rows than the terminal gave it.
  return lines.slice(0, totalRows);
}

/** Pi `Component` shape this module produces. */
export interface PlanTaskListComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface CreatePlanTaskListComponentInput {
  readonly snapshot: PlanTaskSnapshot;
  readonly theme?: PlanTaskListThemePort;
  readonly keybindings?: PlanTaskListKeybindingsPort;
  /**
   * Current terminal height, read on every render so a resize re-budgets the
   * viewport. Returning `undefined` selects the conservative fallback.
   */
  readonly getTerminalRows?: () => number | undefined;
  /** Called at most once, when the user cancels. */
  readonly onCancel: () => void;
  /** Called after any state change, so the host can request a re-render. */
  readonly onChange?: () => void;
  /** Guard so a stale generation renders nothing instead of a dead plan. */
  readonly isCurrent?: () => boolean;
  /**
   * Called at most once, the first time `render()` or `handleInput()` sees
   * that `isCurrent()` has gone false. The host uses it to close the overlay
   * it can no longer own; without it a replaced generation would leave a
   * blank overlay that no key can dismiss.
   *
   * The single-shot guard is what makes it safe to call from `render()`: a
   * host that re-renders in response cannot drive an unbounded loop.
   */
  readonly onStale?: () => void;
}

function resolveKeys(
  keybindings: PlanTaskListKeybindingsPort | undefined,
  binding: PlanTaskListBinding,
): readonly KeyId[] {
  if (typeof keybindings?.getKeys !== "function") {
    return DEFAULT_BINDING_KEYS[binding];
  }
  return keybindings.getKeys(binding) ?? [];
}

function matchesAny(data: string, keys: readonly KeyId[]): boolean {
  for (const key of keys) {
    if (matchesKey(data, key)) return true;
  }
  return false;
}

/** Human-readable hint naming the keys the user actually has bound. */
function buildHint(
  upKeys: readonly KeyId[],
  downKeys: readonly KeyId[],
  cancelKeys: readonly KeyId[],
): string {
  const first = (keys: readonly KeyId[]): string => keys[0] ?? "unbound";
  return `${first(upKeys)}/${first(downKeys)} scrolls, ${first(cancelKeys)} closes`;
}

/**
 * Builds the read-only Alt+T component. The caller owns plan resolution; this
 * function owns everything the terminal sees.
 */
export function createPlanTaskListComponent(
  input: CreatePlanTaskListComponentInput,
): PlanTaskListComponent {
  const upKeys = resolveKeys(input.keybindings, "tui.select.up");
  const downKeys = resolveKeys(input.keybindings, "tui.select.down");
  const cancelKeys = resolveKeys(input.keybindings, "tui.select.cancel");
  const hint = buildHint(upKeys, downKeys, cancelKeys);
  const taskCount = input.snapshot.parents.length;

  const rowsNow = (): number =>
    planTaskListRowBudget(input.getTerminalRows?.());

  // Open on the active task rather than on a window that hides it.
  let scrollOffset = planTaskListOffsetForIndex(
    selectActivePlanTask(input.snapshot).match(
      (task) => task.parentIndex,
      () => undefined,
    ),
    taskCount,
    rowsNow(),
  );
  let cancelled = false;
  let staleNotified = false;
  let cachedWidth: number | undefined;
  let cachedRows: number | undefined;
  let cachedLines: string[] | undefined;

  /** Single-shot stale report, so repeated stale renders stay side-effect free. */
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

  const scrollBy = (delta: number): void => {
    const rows = rowsNow();
    const next = clamp(
      scrollOffset + delta,
      0,
      planTaskListMaxScroll(taskCount, rows),
    );
    if (next === scrollOffset) return;
    scrollOffset = next;
    invalidate();
  };

  return {
    render(width) {
      if (input.isCurrent?.() === false) {
        notifyStale();
        return [];
      }
      const rows = rowsNow();
      // Both width and height are part of the cache key: a resize must not
      // serve a viewport computed for the old geometry.
      if (
        cachedLines !== undefined &&
        cachedWidth === width &&
        cachedRows === rows
      ) {
        return cachedLines;
      }
      scrollOffset = clamp(
        scrollOffset,
        0,
        planTaskListMaxScroll(taskCount, rows),
      );
      const lines = renderPlanTaskListLines({
        snapshot: input.snapshot,
        viewport: { rows, scrollOffset },
        width,
        theme: input.theme,
        hint,
      });
      cachedLines = lines;
      cachedWidth = width;
      cachedRows = rows;
      return lines;
    },
    handleInput(data) {
      if (cancelled) return;
      // A replaced generation must not act on input, but it must still arrange
      // closure rather than trap the user in an overlay that ignores Esc.
      if (input.isCurrent?.() === false) {
        notifyStale();
        return;
      }
      if (matchesAny(data, cancelKeys)) {
        cancelled = true;
        input.onCancel();
        return;
      }
      if (matchesAny(data, upKeys)) {
        scrollBy(-1);
        input.onChange?.();
        return;
      }
      if (matchesAny(data, downKeys)) {
        scrollBy(1);
        input.onChange?.();
      }
      // Everything else is ignored: this surface is read-only and owns no
      // action beyond scrolling and closing.
    },
    invalidate,
  };
}
