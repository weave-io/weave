/**
 * BunFilesystemPlanStateProvider — default Bun-backed implementation of
 * `PlanStateProvider` from `@weaveio/weave-engine`.
 *
 * Owns safe plan I/O under `<projectRoot>/.weave/plans/<planName>.md`:
 * - safe-name validation
 * - canonical-root containment
 * - symlink-component rejection
 * - revisioned snapshot parsing (canonical + unambiguous legacy)
 * - expected-revision compare-and-swap
 * - atomic same-directory replacement
 *
 * `planExists` / `isPlanComplete` are projections of `readSnapshot`.
 *
 * @see docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md §16
 * @see docs/adr/0010-plan-state-and-artifact-approval-authority.md
 */

import { dlopen } from "bun:ffi";
import { dirname, join, resolve, sep } from "node:path";
import {
  derivePlanParentState,
  isAllowedPlanLeafTransition,
  isPlanSnapshotComplete,
  type PlanFormat,
  type PlanStateError,
  type PlanStateProvider,
  type PlanTaskNode,
  type PlanTaskSnapshot,
  type PlanTaskState,
  type PlanTaskTransition,
  validatePlanTransition,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  type Result as NeverthrowResult,
  ok,
  okAsync,
  Result,
  ResultAsync,
} from "neverthrow";

// ---------------------------------------------------------------------------
// Safe-name validation
// ---------------------------------------------------------------------------

/** Regex for safe plan names: alphanumeric, hyphens, underscores only. */
const SAFE_PLAN_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function invalidPlanName(planName: string, reason: string): PlanStateError {
  return { type: "InvalidPlanName", planName, reason };
}

function isSafePlanName(planName: string): boolean {
  return SAFE_PLAN_NAME_RE.test(planName);
}

// ---------------------------------------------------------------------------
// Path / identity helpers
// ---------------------------------------------------------------------------

type FileIdentity = {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number;
  readonly mtimeMs: number;
};

type FileStatus = {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly identity: FileIdentity;
};

type CommandOutput = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCommand(
  command: readonly string[],
): ResultAsync<CommandOutput, string> {
  const spawned = Result.fromThrowable(
    () =>
      Bun.spawn({
        cmd: [...command],
        stdout: "pipe",
        stderr: "pipe",
      }),
    () => "failed to start Bun subprocess",
  )();
  if (spawned.isErr()) return errAsync(spawned.error);

  return ResultAsync.fromPromise(
    Promise.all([
      spawned.value.exited,
      new Response(spawned.value.stdout).text(),
      new Response(spawned.value.stderr).text(),
    ]),
    () => "failed to read Bun subprocess result",
  ).map(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

function isSymlink(path: string): ResultAsync<boolean, string> {
  return runCommand(["test", "-L", path]).andThen((output) => {
    if (output.exitCode === 0) return okAsync(true);
    if (output.exitCode === 1) return okAsync(false);
    return errAsync("failed to inspect path component");
  });
}

function canonicalPath(path: string): ResultAsync<string, string> {
  return runCommand(["realpath", path]).andThen((output) => {
    if (output.exitCode !== 0) return errAsync("failed to resolve path");
    const canonical = output.stdout.trim();
    if (canonical.length === 0) return errAsync("resolved path was empty");
    return okAsync(canonical);
  });
}

function fileStatus(path: string): ResultAsync<FileStatus, string> {
  return ResultAsync.fromPromise(
    Bun.file(path).stat(),
    () => "failed to stat path",
  ).map((stat) => ({
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    identity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
  }));
}

function noFollowOpenFlags(): number | undefined {
  if (process.platform === "darwin") return 0x100 | 0x1000000;
  if (process.platform === "linux") return 0x20000 | 0x80000;
  return undefined;
}

function libcPath(): string | undefined {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  return undefined;
}

/**
 * Read from one descriptor opened with O_NOFOLLOW and derive identity from that
 * same descriptor. The Bun FFI call is wrapped once; cleanup uses `finally`
 * because the descriptor and temporary library handle must always close.
 */
function readNoFollow(
  path: string,
): ResultAsync<{ bytes: Uint8Array; status: FileStatus }, string> {
  const libraryPath = libcPath();
  const flags = noFollowOpenFlags();
  if (libraryPath === undefined || flags === undefined) {
    return errAsync("secure no-follow reads are unavailable on this platform");
  }

  const operation = ResultAsync.fromThrowable(
    async () => {
      const library = dlopen(libraryPath, {
        open: { args: ["cstring", "i32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
      });
      const encodedPath = new TextEncoder().encode(`${path}\0`);
      const descriptor = library.symbols.open(encodedPath, flags);
      if (descriptor < 0) {
        library.close();
        throw new Error("secure open failed");
      }
      try {
        const file = Bun.file(descriptor);
        const stat = await file.stat();
        const bytes = await file.bytes();
        return {
          bytes,
          status: {
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            identity: {
              dev: stat.dev,
              ino: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            },
          },
        };
      } finally {
        library.symbols.close(descriptor);
        library.close();
      }
    },
    () => "secure no-follow read failed",
  );
  return operation();
}

function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

function contentRevisionOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Markdown task grammar
// ---------------------------------------------------------------------------

const PARENT_RE = /^(\s*)- \[([ xX-])\]\s+(\d+)\.\s+(.*)$/;
const CHILD_RE = /^(\s+)- \[([ xX-])\]\s+([a-z])\.\s+(.*)$/;
const ANY_CHECKBOX_RE = /^(\s*)- \[([ xX-])\]\s+(.*)$/;

type ParsedLine =
  | {
      kind: "parent";
      indent: number;
      state: PlanTaskState;
      id: string;
      title: string;
      raw: string;
      lineIndex: number;
    }
  | {
      kind: "child";
      indent: number;
      state: PlanTaskState;
      letter: string;
      title: string;
      raw: string;
      lineIndex: number;
    }
  | {
      kind: "legacy_checkbox";
      indent: number;
      state: PlanTaskState;
      title: string;
      raw: string;
      lineIndex: number;
    }
  | { kind: "other"; raw: string; lineIndex: number };

function markerToState(marker: string): PlanTaskState | undefined {
  if (marker === " ") return "pending";
  if (marker === "-") return "in_progress";
  if (marker === "x" || marker === "X") return "completed";
  return undefined;
}

function stateToMarker(state: PlanTaskState): string {
  if (state === "pending") return "[ ]";
  if (state === "in_progress") return "[-]";
  return "[x]";
}

function replaceCheckboxMarker(line: string, state: PlanTaskState): string {
  return line.replace(/\[(?: |x|X|-)\]/, stateToMarker(state));
}

function parseLine(raw: string, lineIndex: number): ParsedLine {
  const parent = PARENT_RE.exec(raw);
  if (parent) {
    const state = markerToState(parent[2] ?? "");
    if (state !== undefined) {
      return {
        kind: "parent",
        indent: parent[1]?.length ?? 0,
        state,
        id: parent[3] ?? "",
        title: (parent[4] ?? "").trimEnd(),
        raw,
        lineIndex,
      };
    }
  }

  const child = CHILD_RE.exec(raw);
  if (child) {
    const state = markerToState(child[2] ?? "");
    if (state !== undefined) {
      return {
        kind: "child",
        indent: child[1]?.length ?? 0,
        state,
        letter: child[3] ?? "",
        title: (child[4] ?? "").trimEnd(),
        raw,
        lineIndex,
      };
    }
  }

  const legacy = ANY_CHECKBOX_RE.exec(raw);
  if (legacy) {
    const state = markerToState(legacy[2] ?? "");
    if (state !== undefined) {
      return {
        kind: "legacy_checkbox",
        indent: legacy[1]?.length ?? 0,
        state,
        title: (legacy[3] ?? "").trimEnd(),
        raw,
        lineIndex,
      };
    }
  }

  return { kind: "other", raw, lineIndex };
}

type MutableParent = {
  id: string;
  title: string;
  state: PlanTaskState;
  lineIndex: number;
  children: Array<{
    id: string;
    title: string;
    state: PlanTaskState;
    lineIndex: number;
    letter: string;
  }>;
};

function letterFromIndex(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function tryParseCanonical(
  lines: readonly ParsedLine[],
): NeverthrowResult<PlanTaskNode[], string> {
  const parents: MutableParent[] = [];
  let current: MutableParent | undefined;
  let sawCheckbox = false;

  for (const line of lines) {
    if (line.kind === "other") continue;
    if (line.kind === "legacy_checkbox") {
      return err("mixed canonical and non-canonical checkbox lines");
    }
    sawCheckbox = true;

    if (line.kind === "parent") {
      if (line.indent !== 0) {
        return err("canonical parent tasks must start at column 0");
      }
      const expectedId = String(parents.length + 1);
      if (line.id !== expectedId) {
        return err(
          `canonical parent IDs must be consecutive starting at 1 (expected ${expectedId}, found ${line.id})`,
        );
      }
      current = {
        id: line.id,
        title: line.title,
        state: line.state,
        lineIndex: line.lineIndex,
        children: [],
      };
      parents.push(current);
      continue;
    }

    // child
    if (current === undefined) {
      return err("canonical child task appeared before a parent");
    }
    if (line.indent < 2) {
      return err("canonical child tasks must be indented");
    }
    const expectedLetter = letterFromIndex(current.children.length);
    if (line.letter !== expectedLetter) {
      return err(
        `canonical child letters under ${current.id} must be consecutive (expected ${expectedLetter}, found ${line.letter})`,
      );
    }
    current.children.push({
      id: `${current.id}.${line.letter}`,
      title: line.title,
      state: line.state,
      lineIndex: line.lineIndex,
      letter: line.letter,
    });
  }

  if (!sawCheckbox) return ok([]);

  const nodes: PlanTaskNode[] = parents.map((parent) => {
    if (parent.children.length === 0) {
      return {
        id: parent.id,
        title: parent.title,
        state: parent.state,
        children: [],
      };
    }
    const children: PlanTaskNode[] = parent.children.map((child) => ({
      id: child.id,
      title: child.title,
      state: child.state,
      children: [],
    }));
    return {
      id: parent.id,
      title: parent.title,
      state: derivePlanParentState(children.map((c) => c.state)),
      children,
    };
  });
  return ok(nodes);
}

function tryParseLegacy(
  lines: readonly ParsedLine[],
): NeverthrowResult<PlanTaskNode[], string> {
  type StackItem = {
    indent: number;
    node: {
      id: string;
      title: string;
      state: PlanTaskState;
      lineIndex: number;
      children: Array<{
        id: string;
        title: string;
        state: PlanTaskState;
        lineIndex: number;
      }>;
    };
  };

  const roots: StackItem["node"][] = [];
  const stack: StackItem[] = [];
  let parentCount = 0;

  for (const line of lines) {
    if (line.kind === "other") continue;

    const indent = line.indent;
    let title = line.title;
    if (line.kind === "parent") title = `${line.id}. ${line.title}`;
    if (line.kind === "child") title = `${line.letter}. ${line.title}`;
    const state = line.state;

    while (
      stack.length > 0 &&
      indent <= (stack[stack.length - 1]?.indent ?? -1)
    ) {
      stack.pop();
    }

    if (stack.length >= 2) {
      return err(
        "plan checkbox nesting deeper than two levels is not supported",
      );
    }

    if (stack.length === 0) {
      parentCount += 1;
      const node = {
        id: String(parentCount),
        title,
        state,
        lineIndex: line.lineIndex,
        children: [] as Array<{
          id: string;
          title: string;
          state: PlanTaskState;
          lineIndex: number;
        }>,
      };
      roots.push(node);
      stack.push({ indent, node });
      continue;
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      return err("legacy parser stack underflow");
    }
    const letter = letterFromIndex(parent.node.children.length);
    const child = {
      id: `${parent.node.id}.${letter}`,
      title,
      state,
      lineIndex: line.lineIndex,
    };
    parent.node.children.push(child);
    stack.push({
      indent,
      node: {
        id: child.id,
        title: child.title,
        state: child.state,
        lineIndex: child.lineIndex,
        children: [],
      },
    });
  }

  const nodes: PlanTaskNode[] = roots.map((parent) => {
    if (parent.children.length === 0) {
      return {
        id: parent.id,
        title: parent.title,
        state: parent.state,
        children: [],
      };
    }
    const children: PlanTaskNode[] = parent.children.map((child) => ({
      id: child.id,
      title: child.title,
      state: child.state,
      children: [],
    }));
    return {
      id: parent.id,
      title: parent.title,
      state: derivePlanParentState(children.map((c) => c.state)),
      children,
    };
  });
  return ok(nodes);
}

type ParsedPlanDocument = {
  readonly format: PlanFormat;
  readonly parents: readonly PlanTaskNode[];
  readonly lines: readonly string[];
  /** lineIndex → role metadata for rewrites */
  readonly lineMeta: ReadonlyMap<
    number,
    | { role: "parent"; id: string }
    | { role: "child"; id: string; parentId: string }
  >;
};

function parsePlanDocument(
  planName: string,
  content: string,
): NeverthrowResult<ParsedPlanDocument, PlanStateError> {
  const rawLines = content.split("\n");
  // Preserve trailing newline semantics: split keeps final empty only when ends with \n
  const lines = content.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
  const parsedLines = lines.map((raw, lineIndex) => parseLine(raw, lineIndex));

  const canonical = tryParseCanonical(parsedLines);
  if (canonical.isOk()) {
    const lineMeta = new Map<
      number,
      | { role: "parent"; id: string }
      | { role: "child"; id: string; parentId: string }
    >();
    for (const line of parsedLines) {
      if (line.kind === "parent") {
        lineMeta.set(line.lineIndex, { role: "parent", id: line.id });
      } else if (line.kind === "child") {
        // parent id is the current open parent — recover from structure
        // by scanning parents list after build
      }
    }
    // Rebuild line meta from successful canonical structure + parsed lines
    let currentParentId: string | undefined;
    for (const line of parsedLines) {
      if (line.kind === "parent") {
        currentParentId = line.id;
        lineMeta.set(line.lineIndex, { role: "parent", id: line.id });
      } else if (line.kind === "child" && currentParentId !== undefined) {
        lineMeta.set(line.lineIndex, {
          role: "child",
          id: `${currentParentId}.${line.letter}`,
          parentId: currentParentId,
        });
      }
    }
    return ok({
      format: "canonical",
      parents: canonical.value,
      lines,
      lineMeta,
    });
  }

  const legacy = tryParseLegacy(parsedLines);
  if (legacy.isErr()) {
    return err({
      type: "PlanTreeMalformed",
      planName,
      reason: legacy.error,
    });
  }

  // Build legacy line meta by replaying indent stack with assigned IDs
  const lineMeta = new Map<
    number,
    | { role: "parent"; id: string }
    | { role: "child"; id: string; parentId: string }
  >();
  const stack: Array<{ indent: number; id: string; childCount: number }> = [];
  let parentCount = 0;
  for (const line of parsedLines) {
    if (line.kind === "other") continue;
    while (
      stack.length > 0 &&
      line.indent <= (stack[stack.length - 1]?.indent ?? -1)
    ) {
      stack.pop();
    }
    if (stack.length === 0) {
      parentCount += 1;
      const id = String(parentCount);
      lineMeta.set(line.lineIndex, { role: "parent", id });
      stack.push({ indent: line.indent, id, childCount: 0 });
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      return err({
        type: "PlanTreeMalformed",
        planName,
        reason: "legacy line-meta stack underflow",
      });
    }
    const letter = letterFromIndex(parent.childCount);
    parent.childCount += 1;
    const id = `${parent.id}.${letter}`;
    lineMeta.set(line.lineIndex, {
      role: "child",
      id,
      parentId: parent.id,
    });
    stack.push({ indent: line.indent, id, childCount: 0 });
  }

  return ok({
    format: "legacy",
    parents: legacy.value,
    lines,
    lineMeta,
  });
}

function buildSnapshot(
  planName: string,
  contentRevision: string,
  doc: ParsedPlanDocument,
): PlanTaskSnapshot {
  return {
    planName,
    contentRevision,
    format: doc.format,
    parents: doc.parents,
    totalParentCount: doc.parents.length,
    complete: isPlanSnapshotComplete(doc.parents),
  };
}

function applyTransitionToDocument(
  planName: string,
  doc: ParsedPlanDocument,
  input: PlanTaskTransition,
): NeverthrowResult<
  { content: string; parents: readonly PlanTaskNode[] },
  PlanStateError
> {
  let targetLine: number | undefined;
  let parentLine: number | undefined;
  let fromState: PlanTaskState | undefined;

  for (const [lineIndex, meta] of doc.lineMeta) {
    if (meta.role === "child" && meta.id === input.taskId) {
      targetLine = lineIndex;
      parentLine = [...doc.lineMeta.entries()].find(
        ([, m]) => m.role === "parent" && m.id === meta.parentId,
      )?.[0];
      break;
    }
    if (meta.role === "parent" && meta.id === input.taskId) {
      // only if leaf
      const parent = doc.parents.find((p) => p.id === input.taskId);
      if (parent && parent.children.length === 0) {
        targetLine = lineIndex;
      }
      break;
    }
  }

  // Resolve fromState from snapshot tree
  for (const parent of doc.parents) {
    if (parent.id === input.taskId && parent.children.length === 0) {
      fromState = parent.state;
      break;
    }
    for (const child of parent.children) {
      if (child.id === input.taskId) {
        fromState = child.state;
        break;
      }
    }
    if (fromState !== undefined) break;
  }

  if (targetLine === undefined || fromState === undefined) {
    return err({
      type: "TaskNotFound",
      planName,
      taskId: input.taskId,
    });
  }

  if (!isAllowedPlanLeafTransition(fromState, input.toState)) {
    return err({
      type: "InvalidTransition",
      planName,
      taskId: input.taskId,
      from: fromState,
      to: input.toState,
      reason: `transition ${fromState} → ${input.toState} is not allowed`,
    });
  }

  const nextLines = [...doc.lines];
  const target = nextLines[targetLine];
  if (target === undefined) {
    return err({
      type: "PlanTreeMalformed",
      planName,
      reason: `missing source line for task ${input.taskId}`,
    });
  }
  nextLines[targetLine] = replaceCheckboxMarker(target, input.toState);

  // Update parent marker when a child changed
  if (parentLine !== undefined) {
    const parentMeta = doc.lineMeta.get(parentLine);
    if (parentMeta?.role === "parent") {
      const parentNode = doc.parents.find((p) => p.id === parentMeta.id);
      if (parentNode !== undefined) {
        const childStates = parentNode.children.map((child) =>
          child.id === input.taskId ? input.toState : child.state,
        );
        const derived = derivePlanParentState(childStates);
        const parentRaw = nextLines[parentLine];
        if (parentRaw !== undefined) {
          nextLines[parentLine] = replaceCheckboxMarker(parentRaw, derived);
        }
      }
    }
  }

  const content = nextLines.join("\n") + (doc.lines.length > 0 ? "\n" : "");
  const reparsed = parsePlanDocument(planName, content);
  if (reparsed.isErr()) return err(reparsed.error);
  return ok({ content, parents: reparsed.value.parents });
}

// ---------------------------------------------------------------------------
// BunFilesystemPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Default `PlanStateProvider` implementation backed only by Bun runtime APIs.
 *
 * The provider opens plan files with `O_NOFOLLOW` through Bun FFI, reads and
 * stats the same descriptor, checks stable identity again before replacement,
 * enforces expected-revision CAS, and performs same-directory atomic `mv`
 * through `Bun.spawn`. Any failed proof step blocks the operation.
 *
 * Plan files are expected at `<projectRoot>/.weave/plans/<planName>.md`.
 */
export class BunFilesystemPlanStateProvider implements PlanStateProvider {
  private readonly projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = resolve(projectRoot ?? process.cwd());
  }

  private unavailable(reason: string): PlanStateError {
    return {
      type: "ProviderUnavailable",
      cause: { message: reason },
      reason,
    };
  }

  private ensureRoot(): ResultAsync<string, PlanStateError> {
    return isSymlink(this.projectRoot)
      .mapErr(() => this.unavailable("failed to inspect project root"))
      .andThen((linked) => {
        if (linked) {
          return errAsync(
            this.unavailable(
              "project root must not be a symlink; containment is unproven",
            ),
          );
        }
        return canonicalPath(this.projectRoot).mapErr(() =>
          this.unavailable("failed to resolve canonical project root"),
        );
      })
      .andThen((root) =>
        fileStatus(root)
          .mapErr(() => this.unavailable("failed to inspect project root"))
          .andThen((status) => {
            if (!status.isDirectory) {
              return errAsync(
                this.unavailable("project root is not a directory"),
              );
            }
            return okAsync(root);
          }),
      );
  }

  private validateName(planName: string): ResultAsync<string, PlanStateError> {
    if (!isSafePlanName(planName)) {
      return errAsync(
        invalidPlanName(
          planName,
          "plan name contains unsafe characters; use letters, numbers, hyphens, or underscores",
        ),
      );
    }
    return okAsync(planName);
  }

  private planPathFor(
    root: string,
    planName: string,
  ): ResultAsync<string, PlanStateError> {
    const weaveDir = join(root, ".weave");
    const plansDir = join(weaveDir, "plans");
    const planPath = join(plansDir, `${planName}.md`);

    if (!planPath.startsWith(root + sep)) {
      return errAsync(
        invalidPlanName(planName, "resolved plan path escaped project root"),
      );
    }

    return this.assertSafeComponent(weaveDir, planName, true).andThen(() =>
      this.assertSafeComponent(plansDir, planName, true).andThen(() =>
        okAsync(planPath),
      ),
    );
  }

  private assertSafeComponent(
    path: string,
    planName: string,
    allowMissing: boolean,
  ): ResultAsync<undefined, PlanStateError> {
    return isSymlink(path)
      .mapErr(() => this.unavailable("failed to inspect plan path component"))
      .andThen((linked) => {
        if (linked) {
          return errAsync(
            this.unavailable(
              "plan path contains a symlink; stable containment is unproven",
            ),
          );
        }
        return fileStatus(path)
          .map(() => undefined)
          .mapErr(() => {
            if (allowMissing) return { type: "PlanMissing", planName } as const;
            return this.unavailable("failed to inspect plan path component");
          });
      })
      .orElse((error) => {
        if (allowMissing && error.type === "PlanMissing") {
          return okAsync(undefined);
        }
        return errAsync(error);
      });
  }

  private readPlanBytes(
    planName: string,
    planPath: string,
  ): ResultAsync<
    { bytes: Uint8Array; identity: FileIdentity; text: string },
    PlanStateError
  > {
    return ResultAsync.fromPromise(
      Bun.file(planPath).exists(),
      (): PlanStateError => ({
        type: "PlanReadFailed",
        planName,
        reason: "failed to check plan file existence",
      }),
    ).andThen((exists) => {
      if (!exists) {
        return errAsync<never, PlanStateError>({
          type: "PlanMissing",
          planName,
        });
      }
      return readNoFollow(planPath)
        .mapErr(
          (): PlanStateError =>
            this.unavailable(
              "secure no-follow plan read failed; file identity is unproven",
            ),
        )
        .andThen((first) => {
          if (!first.status.isFile) {
            return errAsync({
              type: "PlanReadFailed" as const,
              planName,
              reason: "plan path is not a regular file",
            });
          }
          return readNoFollow(planPath)
            .mapErr(
              (): PlanStateError => ({
                type: "PlanReadFailed",
                planName,
                reason: "failed to re-open plan file securely",
              }),
            )
            .andThen((second) => {
              if (
                !second.status.isFile ||
                !identitiesMatch(
                  first.status.identity,
                  second.status.identity,
                ) ||
                first.bytes.byteLength !== first.status.identity.size ||
                second.bytes.byteLength !== second.status.identity.size ||
                contentRevisionOf(first.bytes) !==
                  contentRevisionOf(second.bytes)
              ) {
                return errAsync({
                  type: "PlanReadFailed" as const,
                  planName,
                  reason: "plan file identity changed during read",
                });
              }
              return okAsync({
                bytes: second.bytes,
                identity: second.status.identity,
                text: new TextDecoder().decode(second.bytes),
              });
            });
        });
    });
  }

  private replacePlan(
    planName: string,
    planPath: string,
    expectedIdentity: FileIdentity,
    expectedRevision: string,
    content: string,
  ): ResultAsync<undefined, PlanStateError> {
    const plansDir = dirname(planPath);
    const tempPath = join(
      plansDir,
      `.${planName}.${Bun.randomUUIDv7()}.tmp.md`,
    );
    const writeError = (): PlanStateError => ({
      type: "PlanWriteFailed",
      planName,
      reason: "atomic plan replacement failed",
    });
    const cleanup = (): ResultAsync<undefined, never> =>
      ResultAsync.fromPromise(Bun.file(tempPath).unlink(), () => undefined)
        .map(() => undefined)
        .orElse(() => okAsync(undefined));

    return ResultAsync.fromPromise(Bun.write(tempPath, content), writeError)
      .andThen(() =>
        runCommand(["chmod", "600", tempPath])
          .mapErr(writeError)
          .andThen((output) => {
            if (output.exitCode !== 0) return errAsync(writeError());
            return this.assertSafeComponent(planPath, planName, false);
          }),
      )
      .andThen(() =>
        readNoFollow(planPath)
          .mapErr(
            (): PlanStateError => ({
              type: "PlanRevisionStale",
              planName,
              expectedRevision,
              actualRevision: "unavailable",
            }),
          )
          .andThen((beforeReplace) => {
            const actualRevision = contentRevisionOf(beforeReplace.bytes);
            if (
              !beforeReplace.status.isFile ||
              !identitiesMatch(
                expectedIdentity,
                beforeReplace.status.identity,
              ) ||
              actualRevision !== expectedRevision
            ) {
              return errAsync({
                type: "PlanRevisionStale" as const,
                planName,
                expectedRevision,
                actualRevision,
              });
            }
            return runCommand(["mv", "-f", tempPath, planPath])
              .mapErr(writeError)
              .andThen((output) => {
                if (output.exitCode !== 0) return errAsync(writeError());
                return okAsync(undefined);
              });
          }),
      )
      .orElse((error) => cleanup().andThen(() => errAsync(error)));
  }

  readSnapshot(
    planName: string,
  ): ResultAsync<PlanTaskSnapshot, PlanStateError> {
    return this.validateName(planName).andThen((safeName) =>
      this.ensureRoot().andThen((root) =>
        this.planPathFor(root, safeName).andThen((planPath) =>
          this.readPlanBytes(safeName, planPath).andThen(({ bytes, text }) => {
            const parsed = parsePlanDocument(safeName, text);
            if (parsed.isErr()) return errAsync(parsed.error);
            return okAsync(
              buildSnapshot(safeName, contentRevisionOf(bytes), parsed.value),
            );
          }),
        ),
      ),
    );
  }

  applyTransition(
    input: PlanTaskTransition,
  ): ResultAsync<PlanTaskSnapshot, PlanStateError> {
    return this.validateName(input.planName).andThen((safeName) =>
      this.ensureRoot().andThen((root) =>
        this.planPathFor(root, safeName).andThen((planPath) =>
          this.readPlanBytes(safeName, planPath).andThen(
            ({ bytes, identity, text }) => {
              const actualRevision = contentRevisionOf(bytes);
              const parsed = parsePlanDocument(safeName, text);
              if (parsed.isErr()) return errAsync(parsed.error);
              const snapshot = buildSnapshot(
                safeName,
                actualRevision,
                parsed.value,
              );
              const normalizedInput = { ...input, planName: safeName };
              const validated = validatePlanTransition(
                snapshot,
                normalizedInput,
              );
              if (validated.isErr()) return errAsync(validated.error);

              const applied = applyTransitionToDocument(
                safeName,
                parsed.value,
                normalizedInput,
              );
              if (applied.isErr()) return errAsync(applied.error);

              return this.replacePlan(
                safeName,
                planPath,
                identity,
                actualRevision,
                applied.value.content,
              ).andThen(() => this.readSnapshot(safeName));
            },
          ),
        ),
      ),
    );
  }

  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    return this.readSnapshot(planName)
      .map(() => true)
      .orElse((error) => {
        if (error.type === "PlanMissing") return okAsync(false);
        return errAsync(error);
      });
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    return this.readSnapshot(planName).map((snapshot) => snapshot.complete);
  }
}
