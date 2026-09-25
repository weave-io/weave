/**
 * Tiny in-memory OpenCode session stores for the audit tests. The tables
 * carry the columns the readers use, with the same names and JSON shapes as
 * the real stores (OpenCode V1: `session`, `message`, `part`; OpenCode V2:
 * `session_v2`, `session_message`).
 */

import { Database } from "bun:sqlite";

export const DAY = Date.parse("2026-09-10T00:00:00Z");
export const HOUR = 60 * 60 * 1000;

export interface SessionSpec {
  id: string;
  directory?: string;
  parentId?: string | null;
  time?: number;
  projectId?: string;
}

export interface DelegationSpec {
  target?: string;
  status?: "completed" | "error" | "running";
  error?: string;
}

/** OpenCode V1 store: messages hold role/agent, parts hold text and tools. */
export class V1Store {
  readonly db = new Database(":memory:");
  private clock = DAY;
  private seq = 0;

  constructor() {
    this.db.run(
      "create table project (id text primary key, worktree text not null)",
    );
    this.db.run(
      "create table session (id text primary key, project_id text not null, parent_id text, directory text not null, time_created integer not null)",
    );
    this.db.run(
      "create table message (id text primary key, session_id text not null, time_created integer not null, data text not null)",
    );
    this.db.run(
      "create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, data text not null)",
    );
    this.db.run("insert into project values ('global', '/')");
  }

  project(id: string, worktree: string): this {
    this.db.run("insert into project values (?, ?)", [id, worktree]);
    return this;
  }

  session(spec: SessionSpec): this {
    this.db.run("insert into session values (?, ?, ?, ?, ?)", [
      spec.id,
      spec.projectId ?? "global",
      spec.parentId ?? null,
      spec.directory ?? "/home/dev/app",
      spec.time ?? DAY,
    ]);
    return this;
  }

  /** A user message with one text part. */
  user(sessionId: string, text: string): this {
    const id = this.message(sessionId, { role: "user", agent: "loom" });
    this.part(id, sessionId, { type: "text", text });
    return this;
  }

  /** An assistant message by `agent` with one `task` part per delegation. */
  assistant(
    sessionId: string,
    agent: string,
    delegations: DelegationSpec[] = [],
  ): this {
    const id = this.message(sessionId, { role: "assistant", agent });
    this.part(id, sessionId, { type: "step-start" });
    for (const d of delegations) {
      const status = d.status ?? "completed";
      this.part(id, sessionId, {
        type: "tool",
        tool: "task",
        callID: `call_${this.seq}`,
        state: {
          status,
          input: {
            description: "private task description",
            prompt: "private delegation prompt",
            ...(d.target === undefined ? {} : { subagent_type: d.target }),
          },
          ...(status === "error" ? { error: d.error ?? "boom" } : {}),
          ...(status === "completed" ? { output: "private output" } : {}),
        },
      });
    }
    this.part(id, sessionId, { type: "step-finish" });
    return this;
  }

  private message(sessionId: string, data: object): string {
    const id = `msg_${String(++this.seq).padStart(4, "0")}`;
    this.clock += 1000;
    this.db.run("insert into message values (?, ?, ?, ?)", [
      id,
      sessionId,
      this.clock,
      JSON.stringify(data),
    ]);
    return id;
  }

  private part(messageId: string, sessionId: string, data: object): void {
    const id = `prt_${String(++this.seq).padStart(4, "0")}`;
    this.db.run("insert into part values (?, ?, ?, ?, ?)", [
      id,
      messageId,
      sessionId,
      this.clock,
      JSON.stringify(data),
    ]);
  }
}

/** OpenCode V2 store: one `session_message` row per message. */
export class V2Store {
  readonly db = new Database(":memory:");
  private seq = 0;

  constructor() {
    this.db.run(
      "create table project (id text primary key, worktree text not null)",
    );
    this.db.run(
      "create table session_v2 (id text primary key, project_id text not null, parent_id text, directory text not null, time_created integer not null)",
    );
    this.db.run(
      "create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, data text not null)",
    );
    this.db.run("insert into project values ('global', '/')");
  }

  session(spec: SessionSpec): this {
    this.db.run("insert into session_v2 values (?, ?, ?, ?, ?)", [
      spec.id,
      spec.projectId ?? "global",
      spec.parentId ?? null,
      spec.directory ?? "/home/dev/app",
      spec.time ?? DAY,
    ]);
    return this;
  }

  user(sessionId: string, text: string, type = "user"): this {
    this.row(sessionId, type, { time: { created: DAY }, text });
    return this;
  }

  assistant(
    sessionId: string,
    agent: string,
    delegations: DelegationSpec[] = [],
  ): this {
    const content: object[] = [{ type: "text", text: "private answer" }];
    for (const d of delegations) {
      const status = d.status ?? "completed";
      content.push({
        type: "tool",
        id: `tool_${++this.seq}`,
        name: "subagent",
        state: {
          status,
          input: {
            description: "private task description",
            prompt: "private delegation prompt",
            ...(d.target === undefined ? {} : { agent: d.target }),
          },
          ...(status === "error"
            ? { error: { type: "tool", message: d.error ?? "boom" } }
            : {}),
          ...(status === "completed"
            ? { content: [{ type: "text", text: "private output" }] }
            : {}),
        },
        time: { created: DAY },
      });
    }
    this.row(sessionId, "assistant", {
      time: { created: DAY },
      agent,
      model: { id: "m", providerID: "p" },
      content,
    });
    return this;
  }

  private row(sessionId: string, type: string, data: object): void {
    const seq = ++this.seq;
    this.db.run("insert into session_message values (?, ?, ?, ?, ?, ?)", [
      `smg_${String(seq).padStart(4, "0")}`,
      sessionId,
      type,
      seq,
      DAY + seq,
      JSON.stringify(data),
    ]);
  }
}

/** A window that contains `DAY`. */
export const WINDOW = { since: DAY - 24 * HOUR, until: DAY + 24 * HOUR };
