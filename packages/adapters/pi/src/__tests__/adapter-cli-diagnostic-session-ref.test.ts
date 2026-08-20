/**
 * Adversarial coverage for the `children.show` diagnostic session ref
 * (Spec 33 path-session design §15.2–15.3).
 *
 * `stripPathsUnlessDiagnostic` deliberately leaves diagnostic output
 * untouched, so a `sessionRef` reaching the handler from a corrupted cache
 * row or a hostile port would be serialized verbatim - including an absolute
 * path. Two independent defences are proven here: the store's own bounded,
 * contained, root-relative ref grammar, and the `children.show` projection,
 * which reports path-free identity diagnostics and never a ref at all.
 */

import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import {
  createPiAdapterCommandHandlers,
  PI_ADAPTER_COMMAND_NAMES,
  type PiAdapterChildListItem,
  type PiAdapterChildrenPort,
  safeDiagnosticSessionRef,
} from "../adapter-cli-commands.js";

const PARENT = "parent-session-1";
const REF = "child-1/session.jsonl";

const HOSTILE_REFS: string[] = [
  "/data/weave/sessions/child-1/session.jsonl",
  "/etc/passwd",
  "../../etc/passwd",
  "child-1/../../escape.jsonl",
  "child-1\\session.jsonl",
  "C:\\sessions\\child-1.jsonl",
  "child-1/session.jsonl\0/etc/passwd",
  "session.jsonl",
  "child-1/",
  "",
  `${"a".repeat(2_048)}/session.jsonl`,
  "child 1/session.jsonl",
];

const LIST_ITEM: PiAdapterChildListItem = {
  childId: "child-1",
  threadId: "thread-1",
  title: "child-1",
  status: "settled",
  createdAt: 0,
  updatedAt: 0,
  originParentSessionId: PARENT,
  tombstoned: false,
  stale: false,
};

function showHandlerFor(_sessionRef: string) {
  const children: PiAdapterChildrenPort = {
    list: () => okAsync({ children: [] }),
    show: () =>
      okAsync({
        child: LIST_ITEM,
        entries: [],
        diagnostics: {
          nativeSessionId: "native-session-1",
          originParentSessionId: PARENT,
          sessionHeader: "verified" as const,
          sessionHealth: "available" as const,
        },
      }),
    result: () =>
      errAsync({ type: "Unavailable" as const, message: "not used" }),
    resolve: () => okAsync({ matches: [] }),
    delete: () =>
      errAsync({ type: "Unavailable" as const, message: "not used" }),
  };
  const handlers = createPiAdapterCommandHandlers({ children });
  const handler = handlers[PI_ADAPTER_COMMAND_NAMES.childrenShow];
  if (handler === undefined) throw new Error("children.show handler missing");
  return handler;
}

describe("children.show never serializes an unproven session ref", () => {
  test("the ref grammar accepts only bounded, contained, relative refs", () => {
    expect(safeDiagnosticSessionRef(REF)).toBe(REF);
    for (const hostile of HOSTILE_REFS) {
      expect(safeDiagnosticSessionRef(hostile)).toBeUndefined();
    }
    expect(safeDiagnosticSessionRef(undefined)).toBeUndefined();
    expect(safeDiagnosticSessionRef(42)).toBeUndefined();
  });

  test("even a valid ref is never reported under --diagnostic", async () => {
    const output = (
      await showHandlerFor(REF)(
        JSON.stringify({
          workspaceKey: "workspace-1",
          childId: "child-1",
          diagnostic: true,
        }),
      )
    )._unsafeUnwrap();

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.sessionRef).toBeUndefined();
    expect(parsed.diagnostics).toEqual({
      nativeSessionId: "native-session-1",
      originParentSessionId: PARENT,
      sessionHeader: "verified",
      sessionHealth: "available",
    });
  });

  test.each(
    HOSTILE_REFS,
  )("a hostile ref is omitted and no path is printed (%p)", async (hostile) => {
    const output = (
      await showHandlerFor(hostile)(
        JSON.stringify({
          workspaceKey: "workspace-1",
          childId: "child-1",
          diagnostic: true,
        }),
      )
    )._unsafeUnwrap();

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.sessionRef).toBeUndefined();
    expect(output).not.toContain("/data/weave");
    expect(output).not.toContain("/etc/passwd");
    expect(output).not.toContain("..");
    expect(output).not.toContain("\\\\");
  });

  test("no ref is reported without --diagnostic", async () => {
    const output = (
      await showHandlerFor(REF)(
        JSON.stringify({ workspaceKey: "workspace-1", childId: "child-1" }),
      )
    )._unsafeUnwrap();

    expect(
      (JSON.parse(output) as Record<string, unknown>).sessionRef,
    ).toBeUndefined();
  });
});
