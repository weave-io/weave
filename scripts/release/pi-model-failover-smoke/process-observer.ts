import { basename, join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  type CleanupDiagnosticCode,
  type CleanupProcessObservation,
  type CleanupResourceTracker,
  FIXTURE_PACKAGE_NAME,
} from "./contract.js";

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly tag?: "pi" | "fixture" | "child";
}

function parseProcessRows(output: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3] ?? "";
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      Number.isSafeInteger(ppid) &&
      ppid >= 0
    )
      rows.push({ pid, ppid, command });
  }
  return rows;
}

function processDescendants(
  rows: readonly ProcessRow[],
  root: string,
  tracker: CleanupResourceTracker,
  observedPids: readonly ProcessRow[] = [],
): readonly ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const known = new Set(
    tracker.processHandles.flatMap((handle) =>
      handle.pid === undefined ? [] : [handle.pid],
    ),
  );
  for (const row of rows) if (row.command.includes(root)) known.add(row.pid);
  for (const row of observedPids) known.add(row.pid);
  const observedByPid = new Map(
    observedPids.map((row) => [row.pid, row] as const),
  );
  const found = new Map<number, ProcessRow>();
  const queue = [...known];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    for (const child of byParent.get(parent) ?? []) {
      if (found.has(child.pid)) continue;
      found.set(child.pid, observedByPid.get(child.pid) ?? child);
      queue.push(child.pid);
    }
  }
  for (const pid of known) {
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row !== undefined) found.set(pid, observedByPid.get(pid) ?? row);
  }
  return [...found.values()];
}

async function readObservedPidFiles(
  root: string,
  processRows: readonly ProcessRow[],
): Promise<readonly ProcessRow[] | undefined> {
  const files: string[] = [];
  let exceeded = false;
  const scanned = await ResultAsync.fromThrowable(
    async () => {
      for await (const path of new Bun.Glob("*.pid").scan({
        cwd: join(root, "capture"),
        absolute: true,
      })) {
        files.push(path);
        if (files.length > 8) {
          exceeded = true;
          break;
        }
      }
    },
    () => undefined,
  )();
  if (scanned.isErr()) return [];
  if (exceeded) return undefined;
  const observedRows = new Map<number, ProcessRow>();
  for (const path of files) {
    const text = await ResultAsync.fromThrowable(
      () => Bun.file(path).text(),
      () => "",
    )();
    if (text.isErr()) continue;
    const pid = Number(text.value.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    const name = basename(path);
    let tag: ProcessRow["tag"];
    if (name.startsWith("fixture-")) tag = "fixture";
    else if (name.startsWith("pi-child")) tag = "child";
    else if (name.startsWith("pi-")) tag = "pi";
    const observed = processRows.find((row) => row.pid === pid);
    if (observed === undefined) continue;
    const command = observed.command;
    const trustedCommand =
      command.includes(root) ||
      command.includes("pi-coding-agent") ||
      command.includes(FIXTURE_PACKAGE_NAME) ||
      command.includes("provider.js");
    if (!trustedCommand) continue;
    const existing = observedRows.get(pid);
    const tagPriority = { fixture: 1, pi: 2, child: 3 } as const;
    const mergedTag =
      existing?.tag === undefined ||
      (tag !== undefined && tagPriority[tag] > tagPriority[existing.tag])
        ? tag
        : existing.tag;
    observedRows.set(pid, {
      ...observed,
      ...(mergedTag === undefined ? {} : { tag: mergedTag }),
    });
  }
  return [...observedRows.values()];
}

export async function defaultObserveProcesses(input: {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly tracker: CleanupResourceTracker;
  readonly timeoutMs: number;
}): Promise<Result<CleanupProcessObservation, CleanupDiagnosticCode>> {
  const ps = await runBoundedCommand(["ps", "-axo", "pid=,ppid=,command="], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: Math.min(input.timeoutMs, 2_000),
    resources: input.tracker,
    processKind: "helper",
  });
  if (ps.isErr()) return err("process-observation-failed");
  const processRows = parseProcessRows(
    `${ps.value.stdout}\n${ps.value.stderr}`,
  );
  const observedPids = await readObservedPidFiles(input.root, processRows);
  if (observedPids === undefined) return err("process-observation-failed");
  const rows = processDescendants(
    processRows,
    input.root,
    input.tracker,
    observedPids,
  );
  const processKinds = new Map(
    input.tracker.processHandles.flatMap((handle) =>
      handle.pid === undefined ? [] : [[handle.pid, handle.kind] as const],
    ),
  );
  const piTuiPids = rows
    .filter(
      (row) =>
        row.tag === "pi" ||
        row.tag === "child" ||
        row.command.includes(`${input.root}/bin/pi`) ||
        row.command.includes("pi-coding-agent"),
    )
    .map((row) => row.pid);
  const piSet = new Set(piTuiPids);
  const childPids = rows
    .filter((row) => {
      if (row.tag === "child") return true;
      let parent = row.ppid;
      const seen = new Set<number>();
      while (!seen.has(parent)) {
        seen.add(parent);
        if (piSet.has(parent)) return row.pid !== parent;
        const next = rows.find((candidate) => candidate.pid === parent);
        if (next === undefined) break;
        parent = next.ppid;
      }
      return false;
    })
    .map((row) => row.pid);
  const helperPids = rows
    .filter((row) => {
      const kind = processKinds.get(row.pid);
      return (
        kind === "helper" || kind === "pty" || row.command.includes("expect")
      );
    })
    .map((row) => row.pid);
  const panePids = rows
    .filter(
      (row) =>
        processKinds.get(row.pid) === "pty" || row.command.includes("expect"),
    )
    .map((row) => row.pid);
  const fixturePids = rows
    .filter(
      (row) =>
        row.tag === "fixture" ||
        row.command.includes(FIXTURE_PACKAGE_NAME) ||
        row.command.includes("provider.js") ||
        piSet.has(row.pid),
    )
    .map((row) => row.pid);
  return ok({
    pids: rows.map((row) => row.pid),
    piTuiPids,
    fixturePids,
    childPids,
    helperPids,
    panePids,
  });
}
