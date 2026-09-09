import {
  err,
  type Result as NeverthrowResult,
  ok,
  Result,
  ResultAsync,
} from "neverthrow";

export type ProofProviderError = {
  readonly type: "StartFailed" | "InvalidRequest";
  readonly message: string;
};

export interface ProofProviderRequest {
  readonly body: Record<string, unknown>;
  readonly receivedAt: number;
}

const MAX_CAPTURED_REQUESTS = 128;

function jsonRecord(
  value: unknown,
): NeverthrowResult<Record<string, unknown>, ProofProviderError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({
      type: "InvalidRequest",
      message: "provider body must be an object",
    });
  }
  return ok(Object.fromEntries(Object.entries(value)));
}

function event(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(parts: readonly string[]): Response {
  return new Response(`${parts.join("")}data: [DONE]\n\n`, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}

function contentResponse(content: string): Response {
  return streamResponse([
    event({
      id: "proof-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "proof-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    }),
    event({
      id: "proof-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "proof-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  ]);
}

function subagentResponse(background: boolean): Response {
  const marker = background ? "CHILD_BACKGROUND" : "CHILD_FOREGROUND";
  const description = background ? "background proof" : "foreground proof";
  return streamResponse([
    event({
      id: "proof-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "proof-model",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: background ? "call-background" : "call-foreground",
                type: "function",
                function: {
                  name: "subagent",
                  arguments: JSON.stringify({
                    agent: "shuttle",
                    description,
                    prompt: marker,
                    background,
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    event({
      id: "proof-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "proof-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
  ]);
}

function includesToolResult(serialized: string): boolean {
  return (
    serialized.includes('"role":"tool"') || serialized.includes("tool_call_id")
  );
}

export class ProofProviderFixture {
  readonly url: string;
  private readonly requests: ProofProviderRequest[] = [];

  private constructor(private readonly server: ReturnType<typeof Bun.serve>) {
    this.url = `http://${server.hostname}:${server.port}`;
  }

  static start(): Result<ProofProviderFixture, ProofProviderError> {
    return Result.fromThrowable(
      () => {
        let fixture: ProofProviderFixture | undefined;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) =>
            fixture?.handle(request) ??
            new Response("fixture unavailable", { status: 503 }),
        });
        fixture = new ProofProviderFixture(server);
        return fixture;
      },
      (): ProofProviderError => ({
        type: "StartFailed",
        message: "local proof provider could not start",
      }),
    )();
  }

  captured(): readonly ProofProviderRequest[] {
    return [...this.requests];
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const parsed = await ResultAsync.fromPromise(
      request.json(),
      (): ProofProviderError => ({
        type: "InvalidRequest",
        message: "provider request was not valid JSON",
      }),
    ).andThen(jsonRecord);
    if (parsed.isErr())
      return Response.json({ error: parsed.error.message }, { status: 400 });
    if (this.requests.length >= MAX_CAPTURED_REQUESTS) {
      return Response.json(
        { error: "request capture limit exceeded" },
        { status: 429 },
      );
    }
    this.requests.push({ body: parsed.value, receivedAt: Date.now() });
    const serialized = JSON.stringify(parsed.value);
    if (serialized.includes("CASE_INTERRUPT")) {
      await Bun.sleep(3_000);
      return contentResponse("INTERRUPT_TOO_LATE");
    }
    if (serialized.includes("CHILD_FOREGROUND"))
      return contentResponse("CHILD_FOREGROUND_DONE");
    if (serialized.includes("CHILD_BACKGROUND"))
      return contentResponse("CHILD_BACKGROUND_DONE");
    if (
      serialized.includes("CASE_FOREGROUND") &&
      !includesToolResult(serialized)
    )
      return subagentResponse(false);
    if (serialized.includes("CASE_FOREGROUND"))
      return contentResponse("PARENT_FOREGROUND_DONE");
    if (
      serialized.includes("CASE_BACKGROUND") &&
      !includesToolResult(serialized)
    )
      return subagentResponse(true);
    if (serialized.includes("CASE_BACKGROUND"))
      return contentResponse("PARENT_BACKGROUND_DONE");
    return contentResponse("PROOF_OK");
  }
}
