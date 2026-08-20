/**
 * The search rail may never report a verdict about a query it did not search.
 *
 * A real Pi 0.84.2 inspector printed
 *
 *     query    bash
 *     match    0/0
 *     kinds    no match in this transcript
 *
 * while `⚙ bash(...)` rows were plainly on screen. The rail prints the query
 * the reader is TYPING but counted the matches of the query the controller had
 * last been given, which until the commit key is `""`. The two facts therefore
 * described different queries, and the rail stated a definitive negative about
 * a transcript nobody had searched.
 *
 * These cases drive the real mounted component over the real
 * `readSessionEntryPage` overlay source, replaying entries captured from a real
 * Pi 0.84.2 child session, and assert on the RENDERED rail rows rather than on
 * controller state, because the rendered rows are the defect.
 */
import { describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { okAsync } from "neverthrow";
import type {
  PiNativeSessionEntryPage,
  PiNativeSessionEntryPageOptions,
} from "../child-native-sessions.js";
import {
  createChildOverlayController,
  createChildOverlayCustomComponent,
  createReadSessionEntryPageOverlaySource,
} from "../child-overlay.js";
import type { ChildOverlayChild } from "../child-overlay-types.js";

initTheme("default");

const CHILD_ID = "8fecda58-13a4-4a5a-a63e-8425459f8c52";

/**
 * Entries captured from a real Pi 0.84.2 Weave child session, trimmed to the
 * shapes the overlay reads. The `|`-joined `toolCallId` and the empty
 * `thinking` string are exactly as the host wrote them.
 */
const CAPTURED_ENTRIES: readonly unknown[] = [
  {
    type: "message",
    id: "6483a3ef",
    parentId: "58734e90",
    timestamp: "2026-08-18T07:06:54.769Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Run these bash commands each as its own separate bash tool call, in this order: (1) echo LIVEDX-ALPHA (2) sleep 60 (3) echo LIVEDX-BRAVO.",
        },
      ],
      timestamp: 1_787_036_814_768,
    },
  },
  {
    type: "message",
    id: "602d86fd",
    parentId: "6483a3ef",
    timestamp: "2026-08-18T07:06:58.537Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Planning sequential bash calls" },
        {
          type: "toolCall",
          id: "call_tO8hjyg6LTe32HIgilUJDaUf|fc_0f87b3348cb48b57",
          name: "bash",
          arguments: { command: "echo LIVEDX-ALPHA", timeout: 60 },
        },
      ],
    },
  },
  {
    type: "message",
    id: "231fe8fb",
    parentId: "602d86fd",
    timestamp: "2026-08-18T07:06:58.543Z",
    message: {
      role: "toolResult",
      toolCallId: "call_tO8hjyg6LTe32HIgilUJDaUf|fc_0f87b3348cb48b57",
      toolName: "bash",
      content: [{ type: "text", text: "LIVEDX-ALPHA\n" }],
      isError: false,
      timestamp: 1_787_036_818_542,
    },
  },
  {
    type: "message",
    id: "0d1a6f77",
    parentId: "231fe8fb",
    timestamp: "2026-08-18T07:08:20.101Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "LIVEDX-FINAL-DONE." }],
    },
  },
];

const describedChild = (
  status: ChildOverlayChild["status"],
): ChildOverlayChild =>
  ({
    childId: CHILD_ID,
    threadId: CHILD_ID,
    status,
    ...(status === "settled" ? { outcome: "completed" as const } : {}),
    generationId: "gen-1",
    runs: [{ run: 1, action: "start" as const }],
    branchIds: ["main"],
    descendantChildIds: [],
    agentName: "shuttle-tests",
  }) as ChildOverlayChild;

/** The production source, fed one bounded page of the captured entries. */
function capturedSource(status: ChildOverlayChild["status"]) {
  return createReadSessionEntryPageOverlaySource({
    describe: () => okAsync(describedChild(status)),
    readSessionEntryPage: (
      _childId: string,
      _options: PiNativeSessionEntryPageOptions,
    ) =>
      okAsync<PiNativeSessionEntryPage, never>({
        entries: CAPTURED_ENTRIES.map((value, offset) => ({
          kind: "entry" as const,
          offset,
          value,
        })),
        bytesRead: 0,
        linesScanned: CAPTURED_ENTRIES.length,
      }),
  });
}

/** The overlay as Pi mounts it, with a render host that never paints back. */
function mountedOverlay(
  controller: ReturnType<typeof createChildOverlayController>,
) {
  return createChildOverlayCustomComponent(
    { requestRender: () => undefined } as never,
    {} as never,
    getKeybindings() as never,
    controller,
    () => undefined,
    () => undefined,
    { cwd: "/workspace" },
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips real ANSI.
const ANSI = /\x1b\[[0-9;]*m/gu;
const plainRows = (rows: readonly string[]): string =>
  rows.map((row) => row.replace(ANSI, "")).join("\n");

/** Mount, paint once, then type `/` and the query WITHOUT committing. */
async function railAfterTyping(
  status: ChildOverlayChild["status"],
  query: string,
): Promise<string> {
  const controller = createChildOverlayController(capturedSource(status));
  (await controller.open(CHILD_ID))._unsafeUnwrap();
  const component = mountedOverlay(controller);
  component.render(200);
  component.handleInput("/");
  component.render(200);
  for (const character of query) {
    component.handleInput(character);
    component.render(200);
  }
  await Promise.resolve();
  return plainRows(component.render(200));
}

describe("the search rail never reports an unsearched verdict", () => {
  for (const status of ["settled", "live"] as const) {
    it(`counts a visible query while typing in a ${status} child`, async () => {
      const rail = await railAfterTyping(status, "LIVEDX");

      // The query is plainly on screen: this is the reader's own premise.
      expect(rail).toContain("LIVEDX");
      expect(rail).toContain("query    LIVEDX");

      // The defect, stated exactly as the live proof read it.
      expect(rail).not.toContain("match    0/0");
      expect(rail).not.toContain("no match in this transcript");
      expect(rail).toContain("match    1/");
    });
  }

  it("still reports a real absence honestly", async () => {
    const rail = await railAfterTyping("settled", "zzqqxx");
    expect(rail).toContain("query    zzqqxx");
    expect(rail).toContain("match    0/0");
    expect(rail).toContain("no match in this transcript");
  });

  it("commits with Enter and walks the matches with n and N", async () => {
    const controller = createChildOverlayController(capturedSource("settled"));
    (await controller.open(CHILD_ID))._unsafeUnwrap();
    const component = mountedOverlay(controller);
    component.render(200);
    for (const character of "/LIVEDX") component.handleInput(character);
    component.render(200);

    // Enter commits: the historical search runs and the ordinal latches at 1.
    component.handleInput("\r");
    await Promise.resolve();
    const committed = plainRows(component.render(200));
    expect(committed).toContain("query    LIVEDX");
    expect(committed).toContain("match    1/");

    const total = Number(/match {4}\d+\/(\d+)/u.exec(committed)?.[1] ?? "0");
    expect(total).toBeGreaterThan(1);

    // `n` advances, `N` walks back to where it started.
    component.handleInput("n");
    expect(plainRows(component.render(200))).toContain(`match    2/${total}`);
    component.handleInput("N");
    expect(plainRows(component.render(200))).toContain(`match    1/${total}`);

    // `n` past the end wraps rather than running off the list.
    for (let step = 0; step < total; step += 1) component.handleInput("n");
    expect(plainRows(component.render(200))).toContain(`match    1/${total}`);
  });
});
