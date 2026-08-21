import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
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
import { runBoundedProcess } from "./child-stream-live-proof-bounded-runner.js";
import type { LiveProofFailureCode } from "./child-stream-live-proof-contract.js";
import { createLiveProofSystem } from "./child-stream-live-proof-host.js";
import {
  type BoundedProcessLimits,
  DEFAULT_BOUNDED_PROCESS_LIMITS,
} from "./child-stream-live-proof-system-contract.js";

const CAPTURE_TIMEOUT_MS = 45_000;
const CAPTURE_KILL_WAIT_MS = 1_000;
const CAPTURE_PACKAGE_MAX_BYTES = 128 * 1024;
const CAPTURE_PROCESS_LIMITS: BoundedProcessLimits = Object.freeze({
  ...DEFAULT_BOUNDED_PROCESS_LIMITS,
  firstOutputMs: CAPTURE_TIMEOUT_MS,
  totalReadMs: CAPTURE_TIMEOUT_MS,
  gracefulTermMs: CAPTURE_KILL_WAIT_MS,
  postKillMs: CAPTURE_KILL_WAIT_MS,
  cleanupMs: CAPTURE_KILL_WAIT_MS * 3,
  maxCaptureBytes: MAX_CAPTURE_TOTAL_BYTES,
});
const CAPTURE_PROMPT_TEXT = "go";
const CAPTURE_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CAPTURE_PI_AI_PACKAGE_NAME = "@earendil-works/pi-ai";
const captureFilesystem = createLiveProofSystem();

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

function writeCaptureText(
  path: string,
  text: string,
  failureType: CaptureFailure["type"],
): ResultAsync<void, CaptureFailure> {
  return captureFilesystem
    .writeText(path, text)
    .mapErr(() => blocked(failureType));
}

function prepareWorkspace(): ResultAsync<
  DeterministicCaptureWorkspace,
  CaptureFailure
> {
  const root = join(tmpdir(), `weave-pi-capture-${crypto.randomUUID()}`);
  const extensionPath = join(root, "deterministic-extension.ts");
  const workspacePath = join(root, "workspace");
  return captureFilesystem
    .makeDirectory(workspacePath)
    .mapErr(() => blocked("workspace-failed"))
    .andThen(() =>
      writeCaptureText(
        extensionPath,
        DETERMINISTIC_EXTENSION_SOURCE,
        "workspace-failed",
      ),
    )
    .andThen(() =>
      writeCaptureText(
        join(workspacePath, "weave-capture-sample.txt"),
        "weave capture deterministic workspace file\n",
        "workspace-failed",
      ),
    )
    .map(() => ({ root, extensionPath, workspacePath }))
    .orElse((failure) =>
      cleanupWorkspace(root).andThen(() => errAsync(failure)),
    );
}

function cleanupWorkspace(root: string): ResultAsync<void, CaptureFailure> {
  return captureFilesystem
    .removePath(root)
    .mapErr(() => blocked("workspace-failed"));
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

function mapBoundedCaptureFailure(code: LiveProofFailureCode): CaptureFailure {
  if (code === "timeout") return blocked("capture-timeout");
  if (code === "overflow") return blocked("bounds-exceeded");
  return blocked("spawn-failed");
}

export function verifyPiVersion(
  pi: string,
  requiredVersion: string,
): ResultAsync<string, CaptureFailure> {
  return runBoundedProcess({
    cmd: [pi, "--version"],
    cwd: ".",
    env: safeRuntimeEnvironment(),
    limits: CAPTURE_PROCESS_LIMITS,
  })
    .map(({ stdout }) => stdout.trim())
    .mapErr((failure) => mapBoundedCaptureFailure(failure.code))
    .andThen((version) =>
      version === requiredVersion || version.startsWith(`${requiredVersion} `)
        ? okAsync(requiredVersion)
        : errAsync(blocked("pi-version-mismatch")),
    );
}

function runDeterministicCapture(input: {
  readonly pi: string;
  readonly workspace: DeterministicCaptureWorkspace;
}): ResultAsync<readonly SanitizedEvent[], CaptureFailure> {
  const state: SanitizerState = { ordinals: createOrdinalState() };
  const events: SanitizedEvent[] = [];
  let settled = false;
  let failure: CaptureFailure | undefined;
  let observedOutputBytes = 0;

  const result = runBoundedProcess({
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
    stdinText: `${JSON.stringify({ type: "prompt", message: CAPTURE_PROMPT_TEXT })}\n`,
    limits: CAPTURE_PROCESS_LIMITS,
    onLine: (stream, line) => {
      observedOutputBytes += utf8Bytes(line) + 1;
      if (observedOutputBytes > MAX_CAPTURE_TOTAL_BYTES) {
        failure = blocked("bounds-exceeded");
        return true;
      }
      if (stream !== "stdout" || settled || failure !== undefined) {
        return false;
      }
      if (line.length === 0) return false;
      const parsed = Result.fromThrowable(
        () => JSON.parse(line) as unknown,
        () => blocked("sanitization-failed"),
      )();
      if (parsed.isErr() || !isRecord(parsed.value)) {
        failure = parsed.isErr()
          ? parsed.error
          : blocked("sanitization-failed");
        return true;
      }
      const eventType = parsed.value.type;
      if (typeof eventType !== "string") {
        failure = blocked("sanitization-failed");
        return true;
      }
      if (!RETAINED_EVENT_TYPES.has(eventType)) return false;
      if (events.length >= MAX_CAPTURE_EVENTS) {
        failure = blocked("bounds-exceeded");
        return true;
      }
      const sanitized = sanitizeRawEventWithState(
        parsed.value,
        events.length,
        state,
      );
      if (sanitized.isErr()) {
        failure = sanitized.error;
        return true;
      }
      events.push(sanitized.value);
      if (eventType === "agent_settled") {
        settled = true;
        return true;
      }
      return false;
    },
  })
    .mapErr((boundedFailure) => mapBoundedCaptureFailure(boundedFailure.code))
    .andThen(() => {
      if (failure !== undefined) return errAsync(failure);
      return settled
        ? okAsync<readonly SanitizedEvent[], CaptureFailure>(events)
        : errAsync(blocked("capture-timeout"));
    });

  return result;
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
    const file = Result.fromThrowable(
      () => Bun.file(path),
      () => blocked("pi-ai-unavailable"),
    )();
    if (file.isErr()) return errAsync(file.error);
    if (file.value.size > CAPTURE_PACKAGE_MAX_BYTES) {
      return errAsync(blocked("pi-ai-unavailable"));
    }
    return ResultAsync.fromThrowable(
      () => file.value.slice(0, CAPTURE_PACKAGE_MAX_BYTES + 1).arrayBuffer(),
      () => blocked("pi-ai-unavailable"),
    )()
      .andThen((bytes) => {
        if (bytes.byteLength > CAPTURE_PACKAGE_MAX_BYTES) {
          return errAsync(blocked("pi-ai-unavailable"));
        }
        const text = Result.fromThrowable(
          () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          () => blocked("pi-ai-unavailable"),
        )();
        if (text.isErr()) return errAsync(text.error);
        const parsed = Result.fromThrowable(
          () => JSON.parse(text.value) as unknown,
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
          sha256: sha256HexOfText(text.value),
        });
      })
      .orElse(() => readCandidate(index + 1));
  };
  return readCandidate(0);
}

function createExclusiveCaptureFile(
  path: string,
): ResultAsync<void, CaptureFailure> {
  return captureFilesystem
    .createPrivateFile(path)
    .mapErr(() => blocked("fixture-exists"));
}

function deleteCaptureFile(path: string): ResultAsync<void, CaptureFailure> {
  return captureFilesystem
    .removePath(path)
    .mapErr(() => blocked("write-failed"));
}

function writeImmutableCapture(
  fixturePath: string,
  manifestPath: string,
  fixtureText: string,
  manifestText: string,
): ResultAsync<void, CaptureFailure> {
  const fixtureDir = fixturePath.slice(0, fixturePath.lastIndexOf("/"));
  let fixtureCreated = false;
  let manifestCreated = false;
  const requireMissing = (path: string): ResultAsync<void, CaptureFailure> =>
    captureFilesystem
      .pathKind(path)
      .mapErr(() => blocked("write-failed"))
      .andThen((kind) =>
        kind === "missing"
          ? okAsync<void, CaptureFailure>(undefined)
          : errAsync(blocked("fixture-exists")),
      );
  const cleanupCreated = (): ResultAsync<void, CaptureFailure> => {
    let cleanup = okAsync<void, CaptureFailure>(undefined);
    if (manifestCreated) {
      cleanup = cleanup.andThen(() => deleteCaptureFile(manifestPath));
    }
    if (fixtureCreated) {
      cleanup = cleanup.andThen(() => deleteCaptureFile(fixturePath));
    }
    return cleanup;
  };

  return captureFilesystem
    .makeDirectory(fixtureDir)
    .mapErr(() => blocked("write-failed"))
    .andThen(() => requireMissing(fixturePath))
    .andThen(() => createExclusiveCaptureFile(fixturePath))
    .map(() => {
      fixtureCreated = true;
      return undefined;
    })
    .andThen(() => writeCaptureText(fixturePath, fixtureText, "write-failed"))
    .andThen(() => requireMissing(manifestPath))
    .andThen(() => createExclusiveCaptureFile(manifestPath))
    .map(() => {
      manifestCreated = true;
      return undefined;
    })
    .andThen(() => writeCaptureText(manifestPath, manifestText, "write-failed"))
    .orElse((failure) => cleanupCreated().andThen(() => errAsync(failure)));
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
