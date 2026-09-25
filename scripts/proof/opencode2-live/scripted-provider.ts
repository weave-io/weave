/**
 * A local OpenAI-compatible model provider for the OpenCode 2 live check.
 *
 * It records every request body the host sends and answers from a fixed
 * script, so the check never needs credentials or a remote model and never
 * depends on what a model decides to say:
 *
 * - The configured subagents are called one at a time, in order. A request
 *   that offers the delegation tool and carries exactly as many tool results
 *   as calls made so far is answered with one call to that tool, targeting
 *   the next subagent. That is how the check makes Loom delegate: first to a
 *   host built-in it must not reach, then to Shuttle.
 * - Every other request (title generation, the subagent's own turn, Loom's
 *   turn after the last result comes back) is answered with "OK".
 *
 * Each call is made once only, and only from a turn that has seen every
 * earlier result, which keeps a subagent that is wrongly offered the tool
 * from looping; the `subagent_policy` check reports that case instead.
 */

import type { CapturedRequest } from "./checks.js";

export interface ScriptedProviderOptions {
  readonly delegationTool: string;
  /** Subagents to delegate to, one call each, in this order. */
  readonly delegates: readonly string[];
}

const MODEL = "proof-model";

/** The id of the scripted model's `index`th delegation call. */
export function scriptedCallId(index: number): string {
  return `call_weave_live_check_${index}`;
}

export class ScriptedProvider {
  private readonly requests: CapturedRequest[] = [];
  private calls = 0;
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
    const next = this.options.delegates[this.calls];
    if (next !== undefined && this.awaitsDelegation(body)) {
      const id = scriptedCallId(this.calls);
      this.calls += 1;
      return this.stream([
        this.chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: this.options.delegationTool,
                  arguments: JSON.stringify({
                    agent: next,
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

  /**
   * True for a turn that is offered the delegation tool and has seen the
   * result of every call made so far: the delegating agent's next turn.
   */
  private awaitsDelegation(body: unknown): boolean {
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
    const results = Array.isArray(messages)
      ? messages.filter(
          (message) => (message as { role?: unknown })?.role === "tool",
        ).length
      : 0;
    return results === this.calls;
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
