import { describe, expect, it } from "bun:test";
import {
  _cacheKeysEqual,
  _clipToWidth,
  _computeCacheKey,
  _sanitizeText,
  _visualWidth,
  createChildInspectionRenderer,
  MARKER_INTERRUPTED,
  MARKER_READONLY,
  MARKER_RECOVERABLE,
  MARKER_RECOVERY,
  MARKER_TRIMMED,
  type PiChildInspectionRenderInput,
  renderChildInspection,
} from "../child-inspection-render.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import {
  EMPTY_PI_CHILD_TRANSCRIPT_STATE,
  PiChildTranscriptReducer,
  type PiTranscriptComponent,
  type PiTranscriptComponentFactory,
  type PiTranscriptComponentRequest,
} from "../child-transcript.js";
import type { PiChildUsageAggregate } from "../child-tree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USAGE: PiChildUsageAggregate = {
  inputTokens: 1200,
  outputTokens: 400,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.0042,
};

function baseInput(
  overrides: Partial<PiChildInspectionRenderInput> = {},
): PiChildInspectionRenderInput {
  return {
    topologyPath: [{ name: "root" }],
    childName: "shuttle-worker",
    status: "running",
    interventionCount: 0,
    summary: { queueSize: 0, turnCount: 1, usage: USAGE },
    generationId: "gen-1",
    trimmed: false,
    recoveryContinuation: false,
    recoverableInterruption: false,
    interruptedHistory: false,
    readOnlyCompletion: false,
    transcriptState: EMPTY_PI_CHILD_TRANSCRIPT_STATE,
    ...overrides,
  };
}

function transcriptWithEntries(): ReturnType<
  PiChildTranscriptReducer["getState"]
> {
  const reducer = new PiChildTranscriptReducer();
  reducer.addTask("implement the feature");
  reducer.applyEvent({
    type: "message_start",
    message: { id: "msg-1", role: "assistant" },
  } as unknown as PiChildSessionEvent);
  reducer.applyEvent({
    type: "message_update",
    delta: { messageId: "msg-1", text: "I will implement this." },
  } as unknown as PiChildSessionEvent);
  reducer.applyEvent({
    type: "message_end",
    message: { id: "msg-1", role: "assistant", stopReason: "stop" },
  } as unknown as PiChildSessionEvent);
  return reducer.getState();
}

/** A trivial native component factory for parity testing. */
function testComponentFactory(): PiTranscriptComponentFactory {
  return {
    create(request: PiTranscriptComponentRequest): PiTranscriptComponent {
      return {
        render(width: number): string[] {
          return [
            _clipToWidth(`[native:${request.kind}] ${request.content}`, width),
          ];
        },
        invalidate(): void {},
      };
    },
  };
}

function allLinesFitWidth(lines: readonly string[], width: number): boolean {
  return lines.every((line) => _visualWidth(line) <= width);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Pi child inspection render", () => {
  // -- AC1: Typed input/model --
  describe("typed input model", () => {
    it("accepts all required fields and produces a valid output", () => {
      const input = baseInput();
      const result = renderChildInspection(input, 80);
      expect(result.isOk()).toBe(true);
      const out = result._unsafeUnwrap();
      expect(out.lines.length).toBeGreaterThan(0);
      expect(out.width).toBe(80);
      expect(typeof out.breadcrumb).toBe("string");
      expect(typeof out.statusLine).toBe("string");
      expect(Array.isArray(out.markers)).toBe(true);
      expect(Array.isArray(out.taskPreviewLines)).toBe(true);
    });

    it("accepts optional workflow/step metadata for direct dispatch", () => {
      const input = baseInput({
        workflowMeta: { workflowName: "deploy", stepName: "build" },
      });
      const result = renderChildInspection(input, 120);
      expect(result.isOk()).toBe(true);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toContain("deploy");
      expect(out.breadcrumb).toContain("build");
    });
  });

  // -- AC2: Breadcrumb rendering --
  describe("breadcrumb", () => {
    it("renders parent › child topology", () => {
      const input = baseInput({
        topologyPath: [{ name: "parent" }],
        childName: "child",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toBe("parent › child");
    });

    it("renders nested path parent › middle › child", () => {
      const input = baseInput({
        topologyPath: [{ name: "root" }, { name: "middle" }],
        childName: "leaf",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toBe("root › middle › leaf");
    });

    it("appends workflow/step for direct dispatch", () => {
      const input = baseInput({
        topologyPath: [{ name: "parent" }],
        childName: "worker",
        workflowMeta: { workflowName: "deploy-pipeline", stepName: "lint" },
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toContain("parent › worker");
      expect(out.breadcrumb).toContain("[deploy-pipeline/lint]");
    });

    it("appends workflow without step when stepName is absent", () => {
      const input = baseInput({
        workflowMeta: { workflowName: "ci" },
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toContain("[ci]");
      expect(out.breadcrumb).not.toContain("/");
    });

    it("never uses child event payloads — only topology path and childName", () => {
      // The breadcrumb only reads topologyPath and childName from the input model,
      // not from transcriptState or any event payload
      const input = baseInput({
        topologyPath: [{ name: "trusted-parent" }],
        childName: "trusted-child",
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toBe("trusted-parent › trusted-child");
      expect(out.breadcrumb).not.toContain("implement");
    });

    it("truncates safely at narrow widths", () => {
      const input = baseInput({
        topologyPath: [{ name: "grandparent" }, { name: "parent" }],
        childName: "child-with-a-very-long-name",
      });
      const result = renderChildInspection(input, 15);
      const out = result._unsafeUnwrap();
      expect(_visualWidth(out.breadcrumb)).toBeLessThanOrEqual(15);
      expect(out.breadcrumb.length).toBeGreaterThan(0);
    });

    it("handles Unicode names safely", () => {
      const input = baseInput({
        topologyPath: [{ name: "親" }],
        childName: "子タスク",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.breadcrumb).toContain("親");
      expect(out.breadcrumb).toContain("子タスク");
      expect(_visualWidth(out.breadcrumb)).toBeLessThanOrEqual(80);
    });

    it("elides middle segments when path is too long for width", () => {
      const input = baseInput({
        topologyPath: [
          { name: "grandparent" },
          { name: "parent" },
          { name: "uncle" },
        ],
        childName: "deeply-nested-child",
      });
      const result = renderChildInspection(input, 30);
      const out = result._unsafeUnwrap();
      expect(_visualWidth(out.breadcrumb)).toBeLessThanOrEqual(30);
    });
  });

  // -- AC3: Status line --
  describe("status line", () => {
    it("renders status, tool, and numeric data", () => {
      const input = baseInput({
        status: "running",
        currentTool: "bash",
        interventionCount: 2,
        summary: { queueSize: 3, turnCount: 5, usage: USAGE },
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.statusLine).toContain("[running]");
      expect(out.statusLine).toContain("tool:bash");
      expect(out.statusLine).toContain("interventions:2");
      expect(out.statusLine).toContain("turn:5");
      expect(out.statusLine).toContain("queue:3");
      expect(out.statusLine).toContain("in:1200");
      expect(out.statusLine).toContain("out:400");
    });

    it("omits tool when currentTool is undefined", () => {
      const input = baseInput({ currentTool: undefined });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.statusLine).not.toContain("tool:");
    });

    it("never leaks raw task text into the status line", () => {
      const input = baseInput({
        taskPreview: "implement all the things with SECRET_TOKEN",
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.statusLine).not.toContain("SECRET_TOKEN");
      expect(out.statusLine).not.toContain("implement");
    });

    it("renders at every width including width=1", () => {
      for (const w of [1, 2, 5, 10, 15, 20, 40, 80, 120, 240]) {
        const input = baseInput({
          currentTool: "read",
          summary: { queueSize: 1, turnCount: 3, usage: USAGE },
        });
        const result = renderChildInspection(input, w);
        expect(result.isOk()).toBe(true);
        const out = result._unsafeUnwrap();
        expect(_visualWidth(out.statusLine)).toBeLessThanOrEqual(w);
        expect(out.lines.length).toBeGreaterThan(0);
      }
    });

    it("renders all terminal statuses", () => {
      for (const status of [
        "queued",
        "spawning",
        "handshaking",
        "bootstrapping",
        "running",
        "cancelling",
        "completed",
        "cancelled",
        "failed",
      ] as const) {
        const input = baseInput({ status });
        const result = renderChildInspection(input, 80);
        expect(result.isOk()).toBe(true);
        const out = result._unsafeUnwrap();
        expect(out.statusLine).toContain(`[${status}]`);
      }
    });
  });

  // -- AC4: Fixed markers --
  describe("markers", () => {
    it("renders trimmed marker", () => {
      const input = baseInput({ trimmed: true });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toContain(MARKER_TRIMMED);
    });

    it("renders recovery continuation marker", () => {
      const input = baseInput({ recoveryContinuation: true });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toContain(MARKER_RECOVERY);
    });

    it("renders recoverable interruption marker", () => {
      const input = baseInput({ recoverableInterruption: true });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toContain(MARKER_RECOVERABLE);
    });

    it("renders interrupted history marker", () => {
      const input = baseInput({ interruptedHistory: true });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toContain(MARKER_INTERRUPTED);
    });

    it("renders read-only completion marker", () => {
      const input = baseInput({ readOnlyCompletion: true });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toContain(MARKER_READONLY);
    });

    it("renders no markers when none are active", () => {
      const input = baseInput();
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.markers).toEqual([]);
    });

    it("renders all markers simultaneously", () => {
      const input = baseInput({
        trimmed: true,
        recoveryContinuation: true,
        recoverableInterruption: true,
        interruptedHistory: true,
        readOnlyCompletion: true,
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();
      expect(out.markers).toHaveLength(5);
      expect(out.markers).toContain(MARKER_TRIMMED);
      expect(out.markers).toContain(MARKER_RECOVERY);
      expect(out.markers).toContain(MARKER_RECOVERABLE);
      expect(out.markers).toContain(MARKER_INTERRUPTED);
      expect(out.markers).toContain(MARKER_READONLY);
    });

    it("markers are visible in composed lines", () => {
      const input = baseInput({
        trimmed: true,
        readOnlyCompletion: true,
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      const joined = out.lines.join("\n");
      expect(joined).toContain("▲");
      expect(joined).toContain("●");
    });
  });

  // -- AC5: Task preview --
  describe("task preview", () => {
    it("renders task preview with label, sanitized of ANSI", () => {
      const input = baseInput({
        taskPreview: "implement \x1b[31mred\x1b[0m feature",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.taskPreviewLines).toHaveLength(1);
      expect(out.taskPreviewLines[0]).toContain("task:");
      expect(out.taskPreviewLines[0]).toContain("implement");
      expect(out.taskPreviewLines[0]).toContain("red");
      expect(out.taskPreviewLines[0]).toContain("feature");
      expect(out.taskPreviewLines[0]).not.toContain("\x1b");
    });

    it("strips control characters from task preview", () => {
      const input = baseInput({
        taskPreview: "hello\x00\x01\x02world\x07\x08test",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.taskPreviewLines[0]).toContain("helloworld");
      expect(out.taskPreviewLines[0]).toContain("test");
      for (let c = 0; c <= 8; c++) {
        expect(out.taskPreviewLines[0]).not.toContain(String.fromCharCode(c));
      }
    });

    it("width-bounds task preview", () => {
      const input = baseInput({
        taskPreview: "a".repeat(200),
      });
      const result = renderChildInspection(input, 30);
      const out = result._unsafeUnwrap();
      expect(out.taskPreviewLines).toHaveLength(1);
      expect(_visualWidth(out.taskPreviewLines[0] ?? "")).toBeLessThanOrEqual(
        30,
      );
    });

    it("does not leak task preview into status line or errors", () => {
      const input = baseInput({
        taskPreview: "SECRET implementation details",
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.statusLine).not.toContain("SECRET");
      // Task preview should only appear in taskPreviewLines
      expect(out.taskPreviewLines.some((l) => l.includes("SECRET"))).toBe(true);
    });

    it("omits task preview when undefined", () => {
      const input = baseInput({ taskPreview: undefined });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.taskPreviewLines).toEqual([]);
    });

    it("omits task preview when empty after sanitization", () => {
      const input = baseInput({ taskPreview: "\x1b[31m\x1b[0m" });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.taskPreviewLines).toEqual([]);
    });
  });

  // -- AC6: Native/fallback parity --
  describe("native/fallback transcript parity", () => {
    it("composes fallback transcript into inspection view", () => {
      const input = baseInput({
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();
      expect(out.transcript.rows.length).toBeGreaterThan(0);
      expect(out.transcript.lines.length).toBeGreaterThan(0);
      // Verify transcript lines appear in composed output
      const composedJoined = out.lines.join("\n");
      for (const tl of out.transcript.lines) {
        if (tl.length > 0) expect(composedJoined).toContain(tl);
      }
    });

    it("composes native transcript with identical shown facts", () => {
      const ts = transcriptWithEntries();
      const factory = testComponentFactory();
      const fallbackInput = baseInput({ transcriptState: ts });
      const nativeInput = baseInput({
        transcriptState: ts,
        transcriptInput: { componentFactory: factory },
      });

      const fallbackResult = renderChildInspection(fallbackInput, 80);
      const nativeResult = renderChildInspection(nativeInput, 80);
      const fallbackOut = fallbackResult._unsafeUnwrap();
      const nativeOut = nativeResult._unsafeUnwrap();

      // Same number of transcript rows (same facts shown)
      expect(nativeOut.transcript.rows.length).toBe(
        fallbackOut.transcript.rows.length,
      );
      // Same fact IDs
      const fallbackFacts = fallbackOut.transcript.rows.map((r) => r.factId);
      const nativeFacts = nativeOut.transcript.rows.map((r) => r.factId);
      expect(nativeFacts).toEqual(fallbackFacts);

      // Provenance differs
      for (const row of nativeOut.transcript.rows) {
        expect(row.provenance).toBe("native");
      }
      for (const row of fallbackOut.transcript.rows) {
        expect(row.provenance).toBe("fallback");
      }
    });

    it("all composed lines fit visible width in both modes", () => {
      const ts = transcriptWithEntries();
      for (const w of [10, 20, 40, 80]) {
        const fallbackResult = renderChildInspection(
          baseInput({ transcriptState: ts }),
          w,
        );
        const nativeResult = renderChildInspection(
          baseInput({
            transcriptState: ts,
            transcriptInput: { componentFactory: testComponentFactory() },
          }),
          w,
        );
        expect(allLinesFitWidth(fallbackResult._unsafeUnwrap().lines, w)).toBe(
          true,
        );
        expect(allLinesFitWidth(nativeResult._unsafeUnwrap().lines, w)).toBe(
          true,
        );
      }
    });
  });

  // -- AC7: Cache invalidation --
  describe("cache invalidation", () => {
    it("returns cached output for identical inputs", () => {
      const renderer = createChildInspectionRenderer();
      const input = baseInput({ transcriptState: transcriptWithEntries() });
      const first = renderer.render(input, 80);
      const second = renderer.render(input, 80);
      expect(first.isOk()).toBe(true);
      expect(second.isOk()).toBe(true);
      // Object identity — same cached reference
      expect(second._unsafeUnwrap()).toBe(first._unsafeUnwrap());
    });

    it("invalidates on width change", () => {
      const renderer = createChildInspectionRenderer();
      const input = baseInput();
      const at80 = renderer.render(input, 80)._unsafeUnwrap();
      const at120 = renderer.render(input, 120)._unsafeUnwrap();
      expect(at80).not.toBe(at120);
      expect(at80.width).toBe(80);
      expect(at120.width).toBe(120);
    });

    it("invalidates on status change", () => {
      const renderer = createChildInspectionRenderer();
      const running = renderer.render(baseInput({ status: "running" }), 80);
      const completed = renderer.render(baseInput({ status: "completed" }), 80);
      expect(running._unsafeUnwrap()).not.toBe(completed._unsafeUnwrap());
    });

    it("invalidates on transcript state change", () => {
      const renderer = createChildInspectionRenderer();
      const empty = renderer.render(baseInput(), 80);
      const withEntries = renderer.render(
        baseInput({ transcriptState: transcriptWithEntries() }),
        80,
      );
      expect(empty._unsafeUnwrap()).not.toBe(withEntries._unsafeUnwrap());
    });

    it("invalidates on marker changes", () => {
      const renderer = createChildInspectionRenderer();
      const noMarkers = renderer.render(baseInput(), 80);
      const withTrimmed = renderer.render(baseInput({ trimmed: true }), 80);
      expect(noMarkers._unsafeUnwrap()).not.toBe(withTrimmed._unsafeUnwrap());
    });

    it("invalidates on theme change", () => {
      const renderer = createChildInspectionRenderer();
      const theme1 = { accent: "#ff0000" };
      const theme2 = { accent: "#00ff00" };
      const first = renderer.render(
        baseInput({ transcriptInput: { theme: theme1 } }),
        80,
      );
      const second = renderer.render(
        baseInput({ transcriptInput: { theme: theme2 } }),
        80,
      );
      expect(first._unsafeUnwrap()).not.toBe(second._unsafeUnwrap());
    });

    it("invalidates when displayed topology, workflow, or usage changes", () => {
      const renderer = createChildInspectionRenderer();
      const first = renderer.render(baseInput(), 80)._unsafeUnwrap();
      const topology = renderer
        .render(baseInput({ topologyPath: [{ name: "other-root" }] }), 80)
        ._unsafeUnwrap();
      const workflow = renderer
        .render(
          baseInput({
            workflowMeta: { workflowName: "deploy", stepName: "build" },
          }),
          80,
        )
        ._unsafeUnwrap();
      const usage = renderer
        .render(
          baseInput({
            summary: {
              ...baseInput().summary,
              usage: { ...USAGE, outputTokens: 401 },
            },
          }),
          80,
        )
        ._unsafeUnwrap();
      expect(topology).not.toBe(first);
      expect(workflow).not.toBe(topology);
      expect(usage).not.toBe(workflow);
    });

    it("invalidates on generation change (child restart)", () => {
      const renderer = createChildInspectionRenderer();
      const gen1 = renderer.render(baseInput({ generationId: "gen-1" }), 80);
      const gen2 = renderer.render(baseInput({ generationId: "gen-2" }), 80);
      expect(gen1._unsafeUnwrap()).not.toBe(gen2._unsafeUnwrap());
    });

    it("manual invalidate() forces recompute", () => {
      const renderer = createChildInspectionRenderer();
      const input = baseInput();
      const first = renderer.render(input, 80)._unsafeUnwrap();
      renderer.invalidate();
      const second = renderer.render(input, 80)._unsafeUnwrap();
      expect(first).not.toBe(second);
      // But structurally equal
      expect(first.lines).toEqual(second.lines);
    });

    it("deterministic cache key comparison", () => {
      const input = baseInput();
      const key1 = _computeCacheKey(input, 80, undefined);
      const key2 = _computeCacheKey(input, 80, undefined);
      expect(_cacheKeysEqual(key1, key2)).toBe(true);

      const key3 = _computeCacheKey(
        baseInput({ status: "completed" }),
        80,
        undefined,
      );
      expect(_cacheKeysEqual(key1, key3)).toBe(false);
    });
  });

  // -- AC8: Golden tests --
  describe("golden views", () => {
    it("ordinary child view", () => {
      const input = baseInput({
        topologyPath: [{ name: "parent" }],
        childName: "shuttle-worker",
        status: "running",
        currentTool: "edit",
        summary: { queueSize: 0, turnCount: 3, usage: USAGE },
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();

      expect(out.breadcrumb).toBe("parent › shuttle-worker");
      expect(out.statusLine).toContain("[running]");
      expect(out.statusLine).toContain("tool:edit");
      expect(out.statusLine).toContain("turn:3");
      expect(out.lines.length).toBeGreaterThan(2);
      expect(allLinesFitWidth(out.lines, 80)).toBe(true);
    });

    it("nested child view with deep topology", () => {
      const input = baseInput({
        topologyPath: [
          { name: "root" },
          { name: "orchestrator" },
          { name: "worker-pool" },
        ],
        childName: "task-7",
        status: "running",
        summary: { queueSize: 1, turnCount: 8 },
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 100);
      const out = result._unsafeUnwrap();

      expect(out.breadcrumb).toContain("root");
      expect(out.breadcrumb).toContain("task-7");
      expect(out.statusLine).toContain("queue:1");
      expect(out.statusLine).toContain("turn:8");
    });

    it("workflow view with step metadata", () => {
      const input = baseInput({
        topologyPath: [{ name: "orchestrator" }],
        childName: "build-step",
        workflowMeta: { workflowName: "ci-pipeline", stepName: "typecheck" },
        status: "running",
        currentTool: "bash",
        summary: { queueSize: 0, turnCount: 2, usage: USAGE },
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 120);
      const out = result._unsafeUnwrap();

      expect(out.breadcrumb).toContain("orchestrator › build-step");
      expect(out.breadcrumb).toContain("[ci-pipeline/typecheck]");
      expect(out.statusLine).toContain("tool:bash");
    });

    it("completed child with all markers", () => {
      const input = baseInput({
        status: "completed",
        trimmed: true,
        recoveryContinuation: true,
        recoverableInterruption: true,
        interruptedHistory: true,
        readOnlyCompletion: true,
        taskPreview: "Implement feature X",
        interventionCount: 3,
        summary: { queueSize: 0, turnCount: 12, usage: USAGE },
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();

      expect(out.statusLine).toContain("[completed]");
      expect(out.statusLine).toContain("interventions:3");
      expect(out.markers).toHaveLength(5);
      expect(out.taskPreviewLines).toHaveLength(1);
      expect(out.taskPreviewLines[0]).toContain("task:");
      expect(out.taskPreviewLines[0]).toContain("Implement feature X");
    });

    it("failed child with no transcript", () => {
      const input = baseInput({
        status: "failed",
        readOnlyCompletion: true,
        taskPreview: "deploy service",
        transcriptState: EMPTY_PI_CHILD_TRANSCRIPT_STATE,
      });
      const result = renderChildInspection(input, 80);
      const out = result._unsafeUnwrap();

      expect(out.statusLine).toContain("[failed]");
      expect(out.markers).toContain(MARKER_READONLY);
      expect(out.transcript.rows).toHaveLength(0);
    });
  });

  // -- Narrow widths --
  describe("narrow widths", () => {
    it("renders at width=1 without error", () => {
      const input = baseInput({
        topologyPath: [{ name: "parent" }],
        childName: "child",
        currentTool: "bash",
        taskPreview: "do something",
        trimmed: true,
        transcriptState: transcriptWithEntries(),
      });
      const result = renderChildInspection(input, 1);
      expect(result.isOk()).toBe(true);
      const out = result._unsafeUnwrap();
      expect(out.width).toBe(1);
      expect(out.lines.length).toBeGreaterThan(0);
      expect(allLinesFitWidth(out.lines, 1)).toBe(true);
    });

    for (const w of [2, 3, 5, 8, 10, 15, 20]) {
      it(`renders at width=${w} with all lines fitting`, () => {
        const input = baseInput({
          topologyPath: [{ name: "grandparent" }, { name: "parent" }],
          childName: "deeply-nested-child",
          status: "running",
          currentTool: "write",
          interventionCount: 5,
          taskPreview: "implement the full feature set with tests and docs",
          trimmed: true,
          recoveryContinuation: true,
          summary: { queueSize: 2, turnCount: 7, usage: USAGE },
          transcriptState: transcriptWithEntries(),
        });
        const result = renderChildInspection(input, w);
        expect(result.isOk()).toBe(true);
        const out = result._unsafeUnwrap();
        expect(allLinesFitWidth(out.lines, w)).toBe(true);
      });
    }
  });

  // -- Preview sanitization --
  describe("preview sanitization", () => {
    it("strips ANSI SGR sequences", () => {
      const cleaned = _sanitizeText("\x1b[1;31mbold red\x1b[0m normal");
      expect(cleaned).toBe("bold red normal");
    });

    it("strips OSC sequences", () => {
      const cleaned = _sanitizeText(
        "before\x1b]8;;https://example.com\x07link\x1b]8;;\x07after",
      );
      expect(cleaned).toBe("beforelinkafter");
    });

    it("strips C0 control characters", () => {
      const cleaned = _sanitizeText(
        "hello\x00\x01\x02\x03\x04\x05\x06\x07\x08world",
      );
      expect(cleaned).toBe("helloworld");
    });

    it("collapses newlines to spaces", () => {
      const cleaned = _sanitizeText("line1\nline2\nline3");
      expect(cleaned).toBe("line1 line2 line3");
    });

    it("preserves spaces and printable characters", () => {
      const cleaned = _sanitizeText("hello world 123 !@#");
      expect(cleaned).toBe("hello world 123 !@#");
    });

    it("preserves Unicode text", () => {
      const cleaned = _sanitizeText("こんにちは 🌍 café");
      expect(cleaned).toContain("こんにちは");
      expect(cleaned).toContain("café");
    });
  });

  // -- Width helpers --
  describe("width helpers", () => {
    it("clipToWidth handles CJK double-width", () => {
      expect(_clipToWidth("你好世界", 4)).toBe("你好");
      expect(_clipToWidth("你好世界", 5)).toBe("你好");
      expect(_clipToWidth("你好世界", 6)).toBe("你好世");
    });

    it("clipToWidth handles width=1 with ASCII", () => {
      expect(_clipToWidth("hello", 1)).toBe("h");
    });

    it("visualWidth counts CJK as double", () => {
      expect(_visualWidth("hello")).toBe(5);
      expect(_visualWidth("你好")).toBe(4);
      expect(_visualWidth("a你b好c")).toBe(7);
    });
  });
});
