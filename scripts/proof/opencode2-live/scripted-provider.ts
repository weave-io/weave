/**
 * A local OpenAI-compatible model provider for the OpenCode 2 live check.
 *
 * It records every request body the host sends and answers from a fixed
 * script, so the check never needs credentials or a remote model and never
 * depends on what a model decides to say:
 *
 * - The first request that offers the delegation tool, and does not yet carry
 *   a tool result, is answered with one call to that tool, targeting the
 *   configured subagent. That is how the check makes Loom delegate.
 * - Every other request (title generation, the subagent's own turn, Loom's
 *   turn after the result comes back) is answered with "OK".
 *
 * Delegating once only keeps a subagent that is wrongly offered the tool from
 * looping; the `subagent_policy` check reports that case instead.
 */

import type { CapturedRequest } from "./checks.js";

export interface ScriptedProviderOptions {
  readonly delegationTool: string;
  readonly delegate: string;
}

const MODEL = "proof-model";

export class ScriptedProvider {
  private readonly requests: CapturedRequest[] = [];
  private delegated = false;
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(private readonly options: ScriptedProviderOptions) {}

  start(): number {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.respond(request),
    });
    return this.server.port ?? 0;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  captured(): readonly CapturedRequest[] {
    return [...this.requests];
  }

  /** Visible for tests: the reply the script gives to one request body. */
  reply(body: unknown): Response {
    this.requests.push({ body });
    if (!this.delegated && this.offersDelegation(body)) {
      this.delegated = true;
      return this.stream([
        this.chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_weave_live_check",
                type: "function",
                function: {
                  name: this.options.delegationTool,
                  arguments: JSON.stringify({
                    agent: this.options.delegate,
                    description: "live check delegation",
                    prompt: "Reply with OK.",
                  }),
                },
              },
            ],
          },
          null,
        ),
        this.chunk({}, "tool_calls"),
      ]);
    }
    return this.stream([
      this.chunk({ role: "assistant", content: "OK" }, "stop"),
    ]);
  }

  private async respond(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    return this.reply(body);
  }

  private offersDelegation(body: unknown): boolean {
    if (typeof body !== "object" || body === null) return false;
    const { tools, messages } = body as {
      tools?: unknown;
      messages?: unknown;
    };
    const offered =
      Array.isArray(tools) &&
      tools.some(
        (tool) =>
          (tool as { function?: { name?: unknown } })?.function?.name ===
          this.options.delegationTool,
      );
    if (!offered) return false;
    const answered =
      Array.isArray(messages) &&
      messages.some(
        (message) => (message as { role?: unknown })?.role === "tool",
      );
    return !answered;
  }

  private chunk(delta: object, finishReason: string | null): object {
    return {
      id: "weave-live-check",
      object: "chat.completion.chunk",
      created: 1,
      model: MODEL,
      usage: { prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 },
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  private stream(chunks: readonly object[]): Response {
    const events = chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("");
    return new Response(`${events}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
}

/** Host config naming the scripted provider as the default model. */
export function scriptedProviderConfig(port: number): object {
  return {
    model: `proof/${MODEL}`,
    providers: {
      proof: {
        name: "Weave live-check provider",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "fixture-only",
        },
        models: {
          [MODEL]: {
            name: "Proof Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 1_000_000, output: 4096 },
          },
        },
      },
    },
  };
}
