import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { readArtifactSha256 } from "../../packages/adapters/pi/src/extension-build-identity.js";
import type { SanitizedEvent } from "./child-stream-capture-contract.js";
import {
  blocked,
  type CaptureFailure,
  type CaptureSuccess,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_TOTAL_BYTES,
  REQUIRED_PI_VERSION,
} from "./child-stream-capture-contract.js";
import {
  createOrdinalState,
  isRecord,
  RETAINED_EVENT_TYPES,
  type SanitizerState,
  sanitizeRawEventWithState,
  sha256HexOfText,
  utf8Bytes,
} from "./child-stream-capture-sanitizer.js";
import {
  buildCaptureManifest,
  serializeFixture,
  verifyCaptureManifest,
} from "./child-stream-capture-verifier.js";

const CAPTURE_TIMEOUT_MS = 45_000;
const CAPTURE_KILL_WAIT_MS = 1_000;
const CAPTURE_PROMPT_TEXT = "go";
const CAPTURE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CAPTURE_PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";

/**
 * This extension is loaded with Pi's public `-e` option. Its deterministic
 * provider emits real pi-ai assistant events; Pi then performs the built-in
 * read and bash calls and publishes the resulting RPC JSONL events.
 */
const DETERMINISTIC_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  let turn = 0;

  pi.registerProvider("weave-capture-deterministic", {
    name: "Weave Capture Deterministic",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "unused",
    api: "openai-completions",
    models: [{
      id: "capture-deterministic-1",
      name: "Weave Capture Deterministic Model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model: any, _context: any) {
      turn += 1;
      const thisTurn = turn;
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      (async () => {
        stream.push({ type: "start", partial: output });
        const thinkingText = String(thisTurn);
        output.content.push({ type: "thinking", thinking: thinkingText });
        const thinkIdx = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: output });
        (output.content[thinkIdx] as any).thinking = thinkingText;
        stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta: thinkingText, partial: output });
        stream.push({ type: "thinking_end", contentIndex: thinkIdx, content: thinkingText, partial: output });

        if (thisTurn === 1) {
          output.content.push({ type: "toolCall", id: "weave-capture-read-call", name: "read", arguments: {} });
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          const argsJson = JSON.stringify({ path: "weave-capture-sample.txt" });
          (output.content[idx] as any).arguments = { path: "weave-capture-sample.txt" };
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: argsJson, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: "weave-capture-read-call", name: "read", arguments: { path: "weave-capture-sample.txt" } }, partial: output });
          output.stopReason = "toolUse";
        } else if (thisTurn === 2) {
          output.content.push({ type: "toolCall", id: "weave-capture-bash-call", name: "bash", arguments: {} });
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          const argsJson = JSON.stringify({ command: "echo weave-capture-ok" });
          (output.content[idx] as any).arguments = { command: "echo weave-capture-ok" };
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: argsJson, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: "weave-capture-bash-call", name: "bash", arguments: { command: "echo weave-capture-ok" } }, partial: output });
          output.stopReason = "toolUse";
        } else {
          output.content.push({ type: "text", text: "" });
          const idx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: idx, partial: output });
          for (const answer of ["Weave capture ", "deterministic final ", "answer."]) {
            (output.content[idx] as any).text += answer;
            stream.push({ type: "text_delta", contentIndex: idx, delta: answer, partial: output });
          }
          stream.push({ type: "text_end", contentIndex: idx, content: "Weave capture deterministic final answer.", partial: output });
          output.stopReason = "stop";
        }

        stream.push({ type: "done", reason: output.stopReason as any, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
`;

interface DeterministicCaptureWorkspace {
  readonly root: string;
  readonly extensionPath: string;
  readonly workspacePath: string;
}

function prepareWorkspace(): ResultAsync<
  DeterministicCaptureWorkspace,
  CaptureFailure
> {
  const root = join(tmpdir(), `weave-pi-capture-${crypto.randomUUID()}`);
  const extensionPath = join(root, "deterministic-extension.ts");
  const workspacePath = join(root, "workspace");
  return ResultAsync.fromPromise(
    $`mkdir -p ${workspacePath}`
      .quiet()
      .then(() => Bun.write(extensionPath, DETERMINISTIC_EXTENSION_SOURCE))
      .then(() =>
        Bun.write(
          join(workspacePath, "weave-capture-sample.txt"),
          "weave capture deterministic workspace file\n",
        ),
      )
      .then(() => ({ root, extensionPath, workspacePath })),
    () => blocked("workspace-failed"),
  ).orElse((failure) =>
    cleanupWorkspace(root).andThen(() => errAsync(failure)),
  );
}

function cleanupWorkspace(root: string): ResultAsync<void, CaptureFailure> {
  return ResultAsync.fromPromise($`rm -rf ${root}`.quiet(), () =>
    blocked("workspace-failed"),
  ).map(() => undefined);
}

function safeRuntimeEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(key)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function appendJsonlLine(
  buffer: string,
  chunk: string,
): {
  readonly buffer: string;
  readonly lines: readonly string[];
} {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    buffer: remainder,
    lines: parts.map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line,
    ),
  };
}

function verifyPiVersion(
  pi: string,
  requiredVersion: string,
): ResultAsync<string, CaptureFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const process = Bun.spawn({
        cmd: [pi, "--version"],
        stdout: "pipe",
        stderr: "pipe",
        env: safeRuntimeEnvironment(),
      });
      const stdout = process.stdout;
      if (stdout === undefined || typeof stdout === "number") {
        await process.exited;
        return "";
      }
      const version = await new Response(stdout).text();
      await process.exited;
      return version.trim();
    })(),
    () => blocked("spawn-failed"),
  ).andThen((version) =>
    version === requiredVersion || version.startsWith(`${requiredVersion} `)
      ? okAsync(version)
      : errAsync(blocked("pi-version-mismatch")),
  );
}

async function readDeterministicEvents(
  child: ReturnType<typeof Bun.spawn>,
): Promise<Result<readonly SanitizedEvent[], CaptureFailure>> {
  const stdout = child.stdout;
  if (stdout === undefined || typeof stdout === "number") {
    return err(blocked("spawn-failed"));
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const state: SanitizerState = { ordinals: createOrdinalState() };
  const events: SanitizedEvent[] = [];
  let buffer = "";
  let settled = false;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  try {
    while (!settled) {
      if (Date.now() > deadline) return err(blocked("capture-timeout"));
      const remainingMs = deadline - Date.now();
      const read = await Promise.race([
        reader.read(),
        new Promise<{ readonly timedOut: true }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ timedOut: true }), remainingMs),
        ),
      ]);
      if ("timedOut" in read) return err(blocked("capture-timeout"));
      if (read.done) {
        return buffer.length === 0
          ? err(blocked("capture-timeout"))
          : err(blocked("sanitization-failed"));
      }
      const chunk = decoder.decode(read.value, { stream: true });
      if (utf8Bytes(buffer) + read.value.byteLength > MAX_CAPTURE_TOTAL_BYTES) {
        return err(blocked("bounds-exceeded"));
      }
      const decoded = appendJsonlLine(buffer, chunk);
      buffer = decoded.buffer;
      for (const line of decoded.lines) {
        if (line.length === 0) continue;
        const parsed = Result.fromThrowable(
          () => JSON.parse(line) as unknown,
          () => blocked("sanitization-failed"),
        )();
        if (parsed.isErr() || !isRecord(parsed.value)) {
          return err(
            parsed.isErr() ? parsed.error : blocked("sanitization-failed"),
          );
        }
        const eventType = parsed.value.type;
        if (typeof eventType !== "string")
          return err(blocked("sanitization-failed"));
        if (!RETAINED_EVENT_TYPES.has(eventType)) continue;
        if (events.length >= MAX_CAPTURE_EVENTS)
          return err(blocked("bounds-exceeded"));
        const sanitized = sanitizeRawEventWithState(
          parsed.value,
          events.length,
          state,
        );
        if (sanitized.isErr()) return err(sanitized.error);
        events.push(sanitized.value);
        if (eventType === "agent_settled") {
          settled = true;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return settled ? ok(events) : err(blocked("capture-timeout"));
}

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  Result.fromThrowable(
    () => child.kill("SIGTERM"),
    () => undefined,
  )();
  await Promise.race([
    child.exited,
    new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, CAPTURE_KILL_WAIT_MS),
    ),
  ]);
  if (child.exitCode === null) {
    Result.fromThrowable(
      () => child.kill("SIGKILL"),
      () => undefined,
    )();
  }
}

function runDeterministicCapture(input: {
  readonly pi: string;
  readonly workspace: DeterministicCaptureWorkspace;
}): ResultAsync<readonly SanitizedEvent[], CaptureFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const child = Bun.spawn({
        cmd: [
          input.pi,
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-prompt-templates",
          "--offline",
          "-e",
          input.workspace.extensionPath,
          "--provider",
          "weave-capture-deterministic",
          "--model",
          "capture-deterministic-1",
        ],
        cwd: input.workspace.workspacePath,
        env: safeRuntimeEnvironment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const stdin = child.stdin;
        if (stdin === undefined || typeof stdin === "number") {
          return err(blocked("spawn-failed"));
        }
        stdin.write(
          `${JSON.stringify({ type: "prompt", message: CAPTURE_PROMPT_TEXT })}\n`,
        );
        return await readDeterministicEvents(child);
      } finally {
        await terminateChild(child);
      }
    })(),
    () => blocked("spawn-failed"),
  ).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

interface PackageIdentity {
  readonly version: string;
  readonly sha256: string;
}

function packagePathCandidates(packageName: string): readonly string[] {
  const bunRoot = Bun.env.BUN_INSTALL ?? join(homedir(), ".bun");
  return [
    join(
      bunRoot,
      "install",
      "global",
      "node_modules",
      packageName,
      "package.json",
    ),
    join("node_modules", packageName, "package.json"),
  ];
}

function readPackageIdentity(
  packageName: string,
): ResultAsync<PackageIdentity, CaptureFailure> {
  const resolved = Result.fromThrowable(
    () => Bun.resolveSync(`${packageName}/package.json`, import.meta.dir),
    () => undefined,
  )();
  const candidates = [
    ...(resolved.isOk() ? [resolved.value] : []),
    ...packagePathCandidates(packageName),
  ];
  const readCandidate = (
    index: number,
  ): ResultAsync<PackageIdentity, CaptureFailure> => {
    const path = candidates[index];
    if (path === undefined) return errAsync(blocked("pi-ai-unavailable"));
    return ResultAsync.fromPromise(Bun.file(path).text(), () =>
      blocked("pi-ai-unavailable"),
    )
      .andThen((text) => {
        const parsed = Result.fromThrowable(
          () => JSON.parse(text) as unknown,
          () => blocked("pi-ai-unavailable"),
        )();
        if (
          parsed.isErr() ||
          !isRecord(parsed.value) ||
          typeof parsed.value.version !== "string"
        ) {
          return errAsync(
            parsed.isErr() ? parsed.error : blocked("pi-ai-unavailable"),
          );
        }
        return okAsync({
          version: parsed.value.version,
          sha256: sha256HexOfText(text),
        });
      })
      .orElse(() => readCandidate(index + 1));
  };
  return readCandidate(0);
}

function writeImmutableCapture(
  fixturePath: string,
  manifestPath: string,
  fixtureText: string,
  manifestText: string,
): ResultAsync<void, CaptureFailure> {
  return ResultAsync.fromPromise(
    Promise.all([
      Bun.file(fixturePath).exists(),
      Bun.file(manifestPath).exists(),
    ]),
    () => blocked("write-failed"),
  ).andThen(([fixtureExists, manifestExists]) => {
    if (fixtureExists || manifestExists)
      return errAsync(blocked("fixture-exists"));
    return ResultAsync.fromPromise(
      $`mkdir -p ${fixturePath.slice(0, fixturePath.lastIndexOf("/"))}`
        .quiet()
        .then(() => Bun.write(fixturePath, fixtureText))
        .then(() => Bun.write(manifestPath, manifestText))
        .then(() => undefined),
      () => blocked("write-failed"),
    );
  });
}

function withWorkspaceCleanup<T>(
  workspace: DeterministicCaptureWorkspace,
  operation: ResultAsync<T, CaptureFailure>,
): ResultAsync<T, CaptureFailure> {
  return operation
    .andThen((value) => cleanupWorkspace(workspace.root).map(() => value))
    .orElse((failure) =>
      cleanupWorkspace(workspace.root).andThen(() => errAsync(failure)),
    );
}

function resolveFixturePaths(input: {
  readonly fixtureDir: string;
  readonly fixtureBaseName: string;
}): { readonly fixturePath: string; readonly manifestPath: string } {
  return {
    fixturePath: join(input.fixtureDir, `${input.fixtureBaseName}.json`),
    manifestPath: join(
      input.fixtureDir,
      `${input.fixtureBaseName}.manifest.json`,
    ),
  };
}

/** Capture once from real Pi 0.84.2 and refuse to overwrite the fixture. */
export function captureChildEvents(input: {
  readonly pi: string;
  readonly requireHostVersion?: string;
  readonly fixtureDir: string;
  readonly fixtureBaseName?: string;
}): ResultAsync<CaptureSuccess, CaptureFailure> {
  const startedAt = Date.now();
  const requiredVersion = input.requireHostVersion ?? REQUIRED_PI_VERSION;
  const fixtureBaseName =
    input.fixtureBaseName ?? "pi-0.84.2-child-ui-events.v1";
  const paths = resolveFixturePaths({
    fixtureDir: input.fixtureDir,
    fixtureBaseName,
  });
  return verifyPiVersion(input.pi, requiredVersion)
    .andThen((piVersion) =>
      readPackageIdentity(CAPTURE_PI_AI_PACKAGE_NAME).map((piAi) => ({
        piVersion,
        piAi,
      })),
    )
    .andThen(({ piVersion, piAi }) =>
      readPackageIdentity(CAPTURE_PACKAGE_NAME).andThen((piPackage) => {
        if (piPackage.version !== piVersion) {
          return errAsync(blocked("pi-version-mismatch"));
        }
        return prepareWorkspace().andThen((workspace) =>
          withWorkspaceCleanup(
            workspace,
            runDeterministicCapture({ pi: input.pi, workspace }).map(
              (events) => ({
                piVersion,
                piAi,
                piPackage,
                piExecutableSha256: "",
                events,
              }),
            ),
          ),
        );
      }),
    )
    .andThen(({ piVersion, piAi, piPackage, events }) =>
      readArtifactSha256(input.pi)
        .mapErr(() => blocked("spawn-failed"))
        .andThen((piExecutableSha256) => {
          const fixtureText = serializeFixture(events);
          const fixtureSha256 = sha256HexOfText(fixtureText);
          const manifest = buildCaptureManifest({
            piVersion,
            piExecutableSha256,
            piPackageSha256: piPackage.sha256,
            piAiVersion: piAi.version,
            piAiPackageSha256: piAi.sha256,
            eventCount: events.length,
            fixtureBytes: utf8Bytes(fixtureText),
            captureTimeMs: Date.now() - startedAt,
            fixtureSha256,
          });
          const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
          const verified = verifyCaptureManifest(fixtureText, manifestText);
          if (verified.isErr()) return errAsync(blocked("sanitization-failed"));
          return writeImmutableCapture(
            paths.fixturePath,
            paths.manifestPath,
            fixtureText,
            manifestText,
          ).map(() => ({
            fixturePath: paths.fixturePath,
            manifestPath: paths.manifestPath,
            eventCount: events.length,
            captureDurationMs: Date.now() - startedAt,
            fixtureSha256,
          }));
        }),
    );
}
