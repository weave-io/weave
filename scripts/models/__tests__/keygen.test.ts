import { describe, expect, it } from "bun:test";
import { type KeyFileIo, keygen } from "../keygen.js";

/** An in-memory disk that records the order of operations. */
class MemoryKeyFileIo implements KeyFileIo {
  readonly files = new Map<string, { text: string; mode?: number }>();
  readonly calls: string[] = [];
  failOn?: "createPrivate" | "write";

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async createPrivate(path: string): Promise<void> {
    this.calls.push(`createPrivate ${path}`);
    if (this.failOn === "createPrivate") throw new Error("chmod failed");
    this.files.set(path, { text: "", mode: 0o600 });
  }

  async write(path: string, text: string): Promise<void> {
    this.calls.push(`write ${path}`);
    if (this.failOn === "write") throw new Error("disk full");
    const existing = this.files.get(path);
    this.files.set(path, { text, mode: existing?.mode });
  }
}

describe("scripts/models/keygen.ts", () => {
  it("creates the key file with mode 600 before writing the private key into it", async () => {
    const io = new MemoryKeyFileIo();
    const publicKey = (await keygen(["/keys/k"], io))._unsafeUnwrap();

    expect(io.calls).toEqual(["createPrivate /keys/k", "write /keys/k"]);
    const file = io.files.get("/keys/k");
    expect(file?.mode).toBe(0o600);
    expect(file?.text.trim().length).toBeGreaterThan(0);
    expect(file?.text.trim()).not.toBe(publicKey);
    const raw = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
    expect(btoa(String.fromCharCode(...raw))).toBe(publicKey);
    expect(raw.byteLength).toBe(32);
  });

  it("refuses to overwrite an existing key file", async () => {
    const io = new MemoryKeyFileIo();
    io.files.set("/keys/k", { text: "old" });
    const result = await keygen(["/keys/k"], io);

    expect(result._unsafeUnwrapErr()).toEqual({
      type: "Exists",
      path: "/keys/k",
    });
    expect(io.files.get("/keys/k")?.text).toBe("old");
    expect(io.calls).toEqual([]);
  });

  it("returns typed errors when the file cannot be created or written", async () => {
    for (const failOn of ["createPrivate", "write"] as const) {
      const io = new MemoryKeyFileIo();
      io.failOn = failOn;
      const result = await keygen(["/keys/k"], io);
      expect(result._unsafeUnwrapErr()).toEqual({
        type: "WriteFailed",
        path: "/keys/k",
      });
    }
  });

  it("asks for an output path", async () => {
    expect(
      (await keygen([], new MemoryKeyFileIo()))._unsafeUnwrapErr(),
    ).toEqual({
      type: "Usage",
    });
  });
});
