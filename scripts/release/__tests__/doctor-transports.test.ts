import { describe, expect, it } from "bun:test";
import {
  boundedBytesFetch,
  boundedJsonFetch,
  boundedResponseBytes,
  DOCTOR_TRANSPORT_LIMITS,
  OFFICIAL_GITHUB_API_ORIGIN,
  resolveGitHubApiUrl,
  runBoundedProcess,
  validateGitHubApiUrl,
  withDoctorTimeout,
} from "../doctor-transports.js";

describe("doctor GitHub API origin validation", () => {
  it("accepts only the exact official origin", () => {
    for (const value of [
      "https://api.github.com",
      "https://api.github.com/",
      "https://api.github.com:443",
    ]) {
      const result = validateGitHubApiUrl(value);
      expect(result.isOk(), value).toBe(true);
      if (result.isOk()) expect(result.value).toBe(OFFICIAL_GITHUB_API_ORIGIN);
    }
  });

  it("refuses every origin a token must never reach", () => {
    const hostile = [
      "http://api.github.com",
      "https://api.github.com.evil.example",
      "https://evil.example",
      "https://attacker@api.github.com",
      "https://user:token@api.github.com",
      "https://api.github.com:8443",
      "https://api.github.com/../evil",
      "https://api.github.com/api/v3",
      "https://api.github.com/?redirect=https://evil.example",
      "https://api.github.com/#evil",
      "https://api.github.example",
      "//api.github.com",
      "api.github.com",
      "",
      "https://api.github.com\n",
      "ftp://api.github.com",
      "https://[::1]",
    ];
    for (const value of hostile) {
      const result = validateGitHubApiUrl(value);
      expect(result.isErr(), value).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("DoctorPortFailed");
        expect(result.error.operation).toBe("github.api-url");
      }
    }
  });

  it("treats an unset value as the official origin and never silently repairs a hostile one", () => {
    const unset = resolveGitHubApiUrl(undefined);
    expect(unset.isOk()).toBe(true);
    if (unset.isOk()) expect(unset.value).toBe(OFFICIAL_GITHUB_API_ORIGIN);

    const empty = resolveGitHubApiUrl("");
    expect(empty.isOk()).toBe(true);

    const hostile = resolveGitHubApiUrl("https://evil.example");
    expect(hostile.isErr()).toBe(true);
  });
});

describe("bounded HTTP transports", () => {
  it("refuses a body whose declared length exceeds the bound", async () => {
    const response = new Response("x".repeat(64), {
      headers: { "content-length": "64" },
    });
    await expect(boundedResponseBytes(response, 16, 1_000)).rejects.toThrow(
      "response exceeds 16 bytes",
    );
  });

  it("cancels a body that lies about its length while it streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(boundedResponseBytes(response, 12, 1_000)).rejects.toThrow(
      "response exceeds 12 bytes",
    );
  });

  it("bounds JSON and byte reads with a wall clock", async () => {
    const json = await boundedJsonFetch(
      "https://registry.example/pkg",
      async () => new Response(JSON.stringify({ ok: true })),
      DOCTOR_TRANSPORT_LIMITS.jsonResponseBytes,
    );
    expect(json.ok).toBe(true);
    expect(json.value).toEqual({ ok: true });

    const missing = await boundedJsonFetch(
      "https://registry.example/pkg",
      async () => new Response("nope", { status: 404 }),
      DOCTOR_TRANSPORT_LIMITS.jsonResponseBytes,
    );
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(404);
    expect(missing.value).toBeUndefined();

    const bytes = await boundedBytesFetch(
      "https://registry.example/pkg.tgz",
      async () => new Response("payload"),
      DOCTOR_TRANSPORT_LIMITS.tarballResponseBytes,
    );
    expect(bytes.ok).toBe(true);
    expect(new TextDecoder().decode(bytes.bytes)).toBe("payload");

    await expect(
      boundedBytesFetch(
        "https://registry.example/slow",
        () => new Promise<Response>(() => undefined),
        1_024,
        25,
      ),
    ).rejects.toThrow("timed out");
  });

  it("clears its timer when the operation wins the race", async () => {
    await expect(withDoctorTimeout(async () => 7, 1_000)).resolves.toBe(7);
  });
});

describe("bounded subprocess reads", () => {
  it("returns bounded stdout for a successful command", async () => {
    const result = await runBoundedProcess(["/bin/echo", "weave"]);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.exitCode).toBe(0);
      expect(result.value.stdout.trim()).toBe("weave");
    }
  });

  it("kills a command that outruns its wall clock", async () => {
    const started = Date.now();
    const result = await runBoundedProcess(["/bin/sleep", "30"], {
      timeoutMs: 200,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain("timed out after 200ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses stdout that exceeds its byte bound while streaming", async () => {
    const result = await runBoundedProcess(
      ["/bin/sh", "-c", "yes weave | head -c 200000"],
      { maxStdoutBytes: 1_024 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain("stdout exceeded 1024 bytes");
  });

  it("refuses stderr that exceeds its byte bound while streaming", async () => {
    const result = await runBoundedProcess(
      ["/bin/sh", "-c", "yes weave | head -c 200000 1>&2"],
      { maxStderrBytes: 1_024 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toContain("stderr exceeded 1024 bytes");
  });

  it("reports a nonzero exit with its bounded stderr", async () => {
    const result = await runBoundedProcess([
      "/bin/sh",
      "-c",
      "echo boom 1>&2; exit 3",
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("boom");
  });

  it("fails closed when the command cannot be spawned", async () => {
    const result = await runBoundedProcess([
      "/nonexistent/weave-doctor-binary",
    ]);
    expect(result.isErr()).toBe(true);
  });

  it("rejects an empty command", async () => {
    const result = await runBoundedProcess([]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.operation).toBe("process");
  });
});
