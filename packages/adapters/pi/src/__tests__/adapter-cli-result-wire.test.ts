/**
 * Wire-budget proof for the authoritative `children.result` page.
 *
 * The engine's opaque command envelope caps `resultJson` at 256,000
 * characters. Raw JSON string escaping has no bounded expansion factor, so a
 * 128 KiB page of C0 bytes would serialize to 786,432 characters and the whole
 * command would fail - for content the command exists to return byte-exactly.
 * Base64 costs a fixed `4 * ceil(n / 3)` for any bytes at all.
 *
 * Every case here goes through the real dispatch path and reconstructs the
 * original bytes from what the handler actually emitted.
 */

import { describe, expect, it } from "bun:test";
import { dispatchAdapterCommand } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  createPiAdapterCommandRegistry,
  decodeResultPageBase64,
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  PI_RESULT_CONTENT_ENCODING,
  type PiAdapterChildEntrySummary,
  type PiAdapterChildListItem,
  type PiAdapterChildrenPort,
  type PiChildResultPage,
  PiChildrenResultResultSchema,
} from "../adapter-cli-commands.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The engine's opaque envelope ceiling, mirrored so the math is explicit. */
const ENGINE_RESULT_ENVELOPE_CHARACTERS = 256_000;

const CHILD: PiAdapterChildListItem = {
  childId: "child-1",
  threadId: "thread-1",
  title: "Title",
  status: "completed",
  createdAt: 1_000,
  updatedAt: 2_000,
  originParentSessionId: "parent-1",
  tombstoned: false,
  stale: false,
};

function unsupported(): never {
  throw new Error("unused port method");
}

/** A port that serves a fixed set of exact pages, one per cursor step. */
function pagingPort(
  pages: readonly PiChildResultPage[],
  entries: readonly PiAdapterChildEntrySummary[] = [],
): PiAdapterChildrenPort {
  return {
    list: () => okAsync({ children: [CHILD] }),
    show: () =>
      okAsync({ child: CHILD, entries, contentIncluded: entries.length > 0 }),
    result: (input) => {
      const index = input.cursor === undefined ? 0 : Number(input.cursor);
      const page = pages[index];
      if (page === undefined) {
        return errAsync({
          type: "NotFound" as const,
          message: "no such page",
        });
      }
      return okAsync(page);
    },
    resolve: () => okAsync({ matches: [CHILD] }),
    delete: unsupported,
  };
}

/** Builds one complete exact page over `content`, with real digests. */
function exactPage(
  content: string,
  options: {
    readonly offset?: number;
    readonly total?: number;
    readonly nextCursor?: string;
    readonly wholeResult?: string;
  } = {},
): PiChildResultPage {
  const whole = options.wholeResult ?? content;
  const wholeBytes = encoder.encode(whole);
  return {
    exact: true,
    status: "complete",
    resultId: "44444444-4444-4444-8444-444444444444",
    total: options.total ?? 1,
    byteLength: wholeBytes.byteLength,
    digest: new Bun.CryptoHasher("sha256").update(wholeBytes).digest("hex"),
    content,
    contentByteOffset: options.offset ?? 0,
    ...(options.nextCursor === undefined
      ? {}
      : { nextCursor: options.nextCursor }),
  };
}

async function dispatchResult(
  port: PiAdapterChildrenPort,
  cursor?: string,
): Promise<{ readonly json: string; readonly page: unknown }> {
  const registry = createPiAdapterCommandRegistry({ children: port });
  const dispatched = await dispatchAdapterCommand(registry, {
    adapter: "pi",
    command: PI_ADAPTER_COMMAND_NAMES.childrenResult,
    payloadJson: JSON.stringify({
      workspaceKey: "ws",
      childId: "child-1",
      ...(cursor === undefined ? {} : { cursor }),
    }),
  });
  const json = dispatched._unsafeUnwrap().resultJson;
  return { json, page: JSON.parse(json) as unknown };
}

describe("children.result serialized wire budget", () => {
  it("keeps a 48 KiB C0 page inside the engine envelope and reconstructs it byte-exactly", async () => {
    // 48 KiB of NUL: the worst case for JSON escaping, and content a
    // sanitizing projection would destroy outright.
    const content = "\u0000".repeat(48 * 1_024);
    const contentBytes = encoder.encode(content);
    expect(contentBytes.byteLength).toBe(49_152);

    // What raw JSON escaping would have cost, and why it could not be used.
    const rawSerialized = JSON.stringify(content).length;
    expect(rawSerialized).toBe(2 + 6 * 49_152);
    expect(rawSerialized).toBeGreaterThan(ENGINE_RESULT_ENVELOPE_CHARACTERS);

    const { json, page } = await dispatchResult(
      pagingPort([exactPage(content)]),
    );
    expect(json.length).toBeLessThanOrEqual(ENGINE_RESULT_ENVELOPE_CHARACTERS);

    const parsed = PiChildrenResultResultSchema.safeParse(page);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.exact).toBe(true);
    expect(parsed.data.contentEncoding).toBe(PI_RESULT_CONTENT_ENCODING);
    expect(parsed.data.contentByteOffset).toBe(0);
    expect(parsed.data.contentByteLength).toBe(contentBytes.byteLength);
    // Base64 is exactly 4/3, always.
    expect(parsed.data.content?.length).toBe(
      4 * Math.ceil(contentBytes.byteLength / 3),
    );

    const decoded = decodeResultPageBase64(parsed.data.content ?? "");
    expect(decoded).toEqual(contentBytes);
    expect(decoder.decode(decoded)).toBe(content);
    expect(parsed.data.contentDigest).toBe(
      new Bun.CryptoHasher("sha256").update(decoded).digest("hex"),
    );
  });

  it("preserves path-like and control-sequence bytes without sanitizing them", async () => {
    const content = [
      "wrote /home/user/secret.txt",
      "\u001b[31mred\u001b[0m",
      "C:\\Users\\jose\\notes.txt",
      "session-abc/session.jsonl",
      'quotes " and \\ backslashes',
      "\u0007\u001f\u007f",
      "multibyte é → 🙂",
    ].join("\n");
    const contentBytes = encoder.encode(content);

    const { json, page } = await dispatchResult(
      pagingPort([exactPage(content)]),
    );
    expect(json.length).toBeLessThanOrEqual(ENGINE_RESULT_ENVELOPE_CHARACTERS);
    const parsed = PiChildrenResultResultSchema.parse(page);

    const decoded = decodeResultPageBase64(parsed.content ?? "");
    expect(decoded).toEqual(contentBytes);
    // Byte-exact means every one of these survives verbatim.
    expect(decoder.decode(decoded)).toBe(content);
    expect(decoder.decode(decoded)).toContain("/home/user/secret.txt");
    expect(decoder.decode(decoded)).toContain("session-abc/session.jsonl");
    expect(decoder.decode(decoded)).toContain("\u001b[31m");
    // The base64 text itself carries no path-shaped or control bytes, so the
    // envelope never has to choose between exactness and path stripping.
    expect(parsed.content).toMatch(/^[A-Za-z0-9+/]*={0,2}$/u);
  });

  it("reconstructs a multi-page escape-heavy result byte-exactly with bounded cursors", async () => {
    const whole = `${"\u0000\u001b[2J".repeat(4_096)}TAIL 🙂`;
    const wholeBytes = encoder.encode(whole);
    // Split on a code-point boundary the way the store's chunk reader does.
    const cut = 20_000;
    const first = decoder.decode(wholeBytes.slice(0, cut));
    const firstBytes = encoder.encode(first);
    const second = decoder.decode(wholeBytes.slice(firstBytes.byteLength));

    const port = pagingPort([
      exactPage(first, {
        total: 2,
        nextCursor: "1",
        wholeResult: whole,
      }),
      exactPage(second, {
        total: 2,
        offset: firstBytes.byteLength,
        wholeResult: whole,
      }),
    ]);

    const rebuilt: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { json, page } = await dispatchResult(port, cursor);
      expect(json.length).toBeLessThanOrEqual(
        ENGINE_RESULT_ENVELOPE_CHARACTERS,
      );
      const parsed = PiChildrenResultResultSchema.parse(page);
      expect(parsed.contentByteOffset).toBe(rebuilt.length);
      rebuilt.push(...decodeResultPageBase64(parsed.content ?? ""));
      expect(parsed.nextCursor?.length ?? 0).toBeLessThanOrEqual(
        PI_ADAPTER_COMMAND_BOUNDS.maxResultCursorLength,
      );
      pages += 1;
      cursor = parsed.nextCursor;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(10);
    }

    expect(pages).toBe(2);
    expect(new Uint8Array(rebuilt)).toEqual(wholeBytes);
    expect(decoder.decode(new Uint8Array(rebuilt))).toBe(whole);
  });

  it("bounds the base64 field at the largest page the port may return", () => {
    expect(PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBase64Length).toBe(
      4 * Math.ceil(PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBytes / 3),
    );
    expect(PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBase64Length).toBeLessThan(
      ENGINE_RESULT_ENVELOPE_CHARACTERS,
    );
    // Envelope headroom after the largest possible page plus its metadata.
    expect(
      ENGINE_RESULT_ENVELOPE_CHARACTERS -
        PI_ADAPTER_COMMAND_BOUNDS.maxResultContentBase64Length,
    ).toBeGreaterThan(64 * 1_024);
  });

  it("carries an incomplete group with no content and no encoding marker", async () => {
    const { page } = await dispatchResult(
      pagingPort([
        { exact: true, status: "incomplete", reason: "missing-commit" },
      ]),
    );
    const parsed = PiChildrenResultResultSchema.parse(page);
    expect({
      status: parsed.status,
      reason: parsed.reason,
      content: parsed.content,
      contentEncoding: parsed.contentEncoding,
      contentDigest: parsed.contentDigest,
    }).toEqual({
      status: "incomplete",
      reason: "missing-commit",
      content: undefined,
      contentEncoding: undefined,
      contentDigest: undefined,
    });
  });
});

describe("children.show display projection stays distinct and bounded", () => {
  it("marks sanitized projections and keeps a full content page inside the envelope", async () => {
    // Three maximum-size entries whose every character doubles under JSON
    // escaping - the display-side analogue of the escape-heavy result page.
    const entries: PiAdapterChildEntrySummary[] = [0, 1, 2].map((index) => ({
      index,
      id: `e${index}`,
      type: "message",
      content: '"'.repeat(
        (PI_ADAPTER_COMMAND_BOUNDS.maxEntryContentSerializedBytes - 2) / 2,
      ),
      contentKind: "sanitized-projection" as const,
      contentComplete: false,
      contentByteLength: 1_000_000,
      contentCursor: "abc",
    }));

    const registry = createPiAdapterCommandRegistry({
      children: pagingPort([], entries),
    });
    const dispatched = await dispatchAdapterCommand(registry, {
      adapter: "pi",
      command: PI_ADAPTER_COMMAND_NAMES.childrenShow,
      payloadJson: JSON.stringify({
        workspaceKey: "ws",
        childId: "child-1",
        content: true,
      }),
    });
    const json = dispatched._unsafeUnwrap().resultJson;
    expect(json.length).toBeLessThanOrEqual(ENGINE_RESULT_ENVELOPE_CHARACTERS);

    const body = JSON.parse(json) as {
      readonly entries: readonly {
        readonly contentKind?: string;
        readonly contentComplete?: boolean;
      }[];
    };
    // Never `exact`, always explicitly a projection, always marked incomplete
    // when it is: nothing here can be mistaken for `children.result`.
    expect(json).not.toContain('"exact"');
    expect(json).not.toContain('"contentEncoding"');
    for (const entry of body.entries) {
      expect(entry.contentKind).toBe("sanitized-projection");
      expect(entry.contentComplete).toBe(false);
    }
  });
});
