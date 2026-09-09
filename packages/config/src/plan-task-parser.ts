import type {
  PlanTaskFormat,
  PlanTaskNode,
  PlanTaskSnapshot,
  PlanTaskSnapshotError,
  PlanTaskState,
} from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";

export const MAX_PLAN_BYTES = 256 * 1024;
export const MAX_PLAN_TASKS = 512;
export const MAX_PLAN_TITLE_LENGTH = 512;
export const MAX_PLAN_NAME_LENGTH = 128;

export interface ParsePlanTasksInput {
  readonly planName: string;
  readonly contentRevision: string;
  readonly markdown: string;
}

type MutableTask = {
  id: string;
  title: string;
  state: PlanTaskState;
  children: MutableTask[];
};

const PARENT_TASK = /^(\s*)-\s+\[([ xX-])\]\s+(\d+)\.\s+(.+?)\s*$/;
const CHILD_TASK = /^(\s+)-\s+\[([ xX-])\]\s+([a-z])\.\s+(.+?)\s*$/;
const LEGACY_TASK = /^(\s*)-\s+\[([ xX-])\]\s+(.+?)\s*$/;
const HEADING_TASK = /^###\s+Task\s+(\d+)\s*(?:—|-|:)\s*(.+?)\s*$/i;
const HEADING_STATE = /^\s*-\s+\[([ xX-])\]\s+\*\*What\*\*\s*:/i;
const PROSE_CHECKBOX =
  /^\*\*(?:What|Files|Depends on|Acceptance|Pitfalls\s*\/\s*non-goals)\*\*\s*:/i;

function markerState(marker: string): PlanTaskState {
  if (marker === "-") return "in_progress";
  if (marker === "x" || marker === "X") return "completed";
  return "pending";
}

function deriveParentState(children: readonly MutableTask[]): PlanTaskState {
  if (children.every((child) => child.state === "pending")) return "pending";
  if (children.every((child) => child.state === "completed"))
    return "completed";
  return "in_progress";
}

class PlanTaskParser {
  private taskCount = 0;

  constructor(private readonly input: ParsePlanTasksInput) {}

  parse(): Result<PlanTaskSnapshot, PlanTaskSnapshotError> {
    const lines = this.withoutFencedExamples(
      this.input.markdown.split(/\r\n?|\n/),
    );
    const headings = this.parseHeadings(lines);
    if (headings.isErr()) return err(headings.error);
    if (headings.value.length > 0)
      return this.snapshot(headings.value, "canonical");

    const canonical = this.parseCanonical(lines);
    if (canonical.isErr()) return err(canonical.error);
    if (canonical.value.length > 0)
      return this.snapshot(canonical.value, "canonical");

    const legacy = this.parseLegacy(lines);
    if (legacy.isErr()) return err(legacy.error);
    return this.snapshot(legacy.value, "legacy");
  }

  private withoutFencedExamples(
    lines: readonly string[],
  ): Array<{ text: string; line: number }> {
    const result: Array<{ text: string; line: number }> = [];
    let fence: "```" | "~~~" | undefined;
    for (const [index, text] of lines.entries()) {
      const opening = /^\s*(```|~~~)/.exec(text)?.[1] as
        | "```"
        | "~~~"
        | undefined;
      if (fence === undefined && opening !== undefined) {
        fence = opening;
        continue;
      }
      if (fence !== undefined) {
        if (text.trimStart().startsWith(fence)) fence = undefined;
        continue;
      }
      result.push({ text, line: index + 1 });
    }
    return result;
  }

  private parseHeadings(
    lines: readonly { text: string; line: number }[],
  ): Result<MutableTask[], PlanTaskSnapshotError> {
    const tasks: MutableTask[] = [];
    for (const [index, line] of lines.entries()) {
      const match = HEADING_TASK.exec(line.text);
      if (match === null) continue;
      const id = match[1] ?? "";
      if (id !== String(tasks.length + 1))
        return this.malformed(
          "heading task IDs must be consecutive starting at 1",
          line.line,
        );
      const title = match[2]?.trim() ?? "";
      const titleCheck = this.validateTitle(title, line.line);
      if (titleCheck.isErr()) return err(titleCheck.error);

      let state: PlanTaskState = "pending";
      for (const candidate of lines.slice(index + 1)) {
        if (HEADING_TASK.test(candidate.text)) break;
        const stateMatch = HEADING_STATE.exec(candidate.text);
        if (stateMatch === null) continue;
        state = markerState(stateMatch[1] ?? " ");
        break;
      }
      const count = this.countTask();
      if (count.isErr()) return err(count.error);
      tasks.push({ id, title, state, children: [] });
    }
    return ok(tasks);
  }

  private parseCanonical(
    lines: readonly { text: string; line: number }[],
  ): Result<MutableTask[], PlanTaskSnapshotError> {
    const parents: MutableTask[] = [];
    let current: MutableTask | undefined;
    let childIndent: number | undefined;
    for (const line of lines) {
      const parent = PARENT_TASK.exec(line.text);
      if (parent !== null) {
        if ((parent[1]?.length ?? 0) !== 0)
          return this.malformed(
            "parent tasks must start at column 0",
            line.line,
          );
        const id = parent[3] ?? "";
        if (id !== String(parents.length + 1))
          return this.malformed(
            "parent task IDs must be consecutive starting at 1",
            line.line,
          );
        const title = parent[4]?.trim() ?? "";
        const titleCheck = this.validateTitle(title, line.line);
        if (titleCheck.isErr()) return err(titleCheck.error);
        const count = this.countTask();
        if (count.isErr()) return err(count.error);
        current = {
          id,
          title,
          state: markerState(parent[2] ?? " "),
          children: [],
        };
        childIndent = undefined;
        parents.push(current);
        continue;
      }

      const child = CHILD_TASK.exec(line.text);
      if (child === null) continue;
      if (current === undefined)
        return this.malformed("child task appeared before a parent", line.line);
      const indent = child[1]?.length ?? 0;
      if (indent < 2)
        return this.malformed("child tasks must be indented", line.line);
      if (childIndent !== undefined && indent !== childIndent)
        return this.malformed(
          "task nesting deeper than two levels is not supported",
          line.line,
        );
      childIndent = indent;
      const letter = child[3] ?? "";
      const expected = String.fromCharCode(97 + current.children.length);
      if (letter !== expected)
        return this.malformed(
          "child task IDs must be consecutive starting at a",
          line.line,
        );
      const title = child[4]?.trim() ?? "";
      const titleCheck = this.validateTitle(title, line.line);
      if (titleCheck.isErr()) return err(titleCheck.error);
      const count = this.countTask();
      if (count.isErr()) return err(count.error);
      current.children.push({
        id: `${current.id}.${letter}`,
        title,
        state: markerState(child[2] ?? " "),
        children: [],
      });
    }
    for (const parent of parents) {
      if (parent.children.length > 0)
        parent.state = deriveParentState(parent.children);
    }
    return ok(parents);
  }

  private parseLegacy(
    lines: readonly { text: string; line: number }[],
  ): Result<MutableTask[], PlanTaskSnapshotError> {
    const parents: MutableTask[] = [];
    let current: MutableTask | undefined;
    let childIndent: number | undefined;
    for (const line of lines) {
      const match = LEGACY_TASK.exec(line.text);
      if (match === null) continue;
      const title = match[3]?.trim() ?? "";
      if (PROSE_CHECKBOX.test(title)) continue;
      const titleCheck = this.validateTitle(title, line.line);
      if (titleCheck.isErr()) return err(titleCheck.error);
      const indent = match[1]?.length ?? 0;
      const count = this.countTask();
      if (count.isErr()) return err(count.error);
      if (indent === 0) {
        current = {
          id: String(parents.length + 1),
          title,
          state: markerState(match[2] ?? " "),
          children: [],
        };
        childIndent = undefined;
        parents.push(current);
        continue;
      }
      if (current === undefined)
        return this.malformed(
          "indented task appeared before a parent",
          line.line,
        );
      if (childIndent !== undefined && indent !== childIndent)
        return this.malformed(
          "task nesting deeper than two levels is not supported",
          line.line,
        );
      childIndent = indent;
      const letter = String.fromCharCode(97 + current.children.length);
      current.children.push({
        id: `${current.id}.${letter}`,
        title,
        state: markerState(match[2] ?? " "),
        children: [],
      });
    }
    for (const parent of parents) {
      if (parent.children.length > 0)
        parent.state = deriveParentState(parent.children);
    }
    return ok(parents);
  }

  private validateTitle(
    title: string,
    line: number,
  ): Result<void, PlanTaskSnapshotError> {
    if (title.length === 0)
      return this.malformed("task title must not be empty", line);
    for (const character of title) {
      const codePoint = character.codePointAt(0) ?? 0;
      const isControl =
        codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
      if (isControl)
        return this.malformed(
          "task titles must not contain control characters",
          line,
        );
    }
    const length = [...title].length;
    if (length <= MAX_PLAN_TITLE_LENGTH) return ok();
    return err({
      type: "PlanLimitExceeded",
      planName: this.input.planName,
      limit: "title",
      actual: length,
      maximum: MAX_PLAN_TITLE_LENGTH,
    });
  }

  private countTask(): Result<void, PlanTaskSnapshotError> {
    this.taskCount += 1;
    if (this.taskCount <= MAX_PLAN_TASKS) return ok();
    return err({
      type: "PlanLimitExceeded",
      planName: this.input.planName,
      limit: "tasks",
      actual: this.taskCount,
      maximum: MAX_PLAN_TASKS,
    });
  }

  private malformed(
    reason: string,
    line: number,
  ): Result<never, PlanTaskSnapshotError> {
    return err({
      type: "PlanMalformed",
      planName: this.input.planName,
      reason,
      line,
    });
  }

  private snapshot(
    parents: readonly MutableTask[],
    format: PlanTaskFormat,
  ): Result<PlanTaskSnapshot, PlanTaskSnapshotError> {
    const immutableParents: PlanTaskNode[] = parents.map((parent) => ({
      ...parent,
      children: parent.children.map((child) => ({ ...child, children: [] })),
    }));
    const leaves = immutableParents.flatMap((parent) =>
      parent.children.length > 0 ? parent.children : [parent],
    );
    const completedTaskCount = leaves.filter(
      (task) => task.state === "completed",
    ).length;
    return ok({
      planName: this.input.planName,
      contentRevision: this.input.contentRevision,
      format,
      parents: immutableParents,
      totalParentCount: immutableParents.length,
      totalTaskCount: leaves.length,
      completedTaskCount,
      complete: leaves.every((task) => task.state === "completed"),
    });
  }
}

export function parsePlanTasks(
  input: ParsePlanTasksInput,
): Result<PlanTaskSnapshot, PlanTaskSnapshotError> {
  return new PlanTaskParser(input).parse();
}
