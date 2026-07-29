import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../host-compatibility-matrix.js";
import {
  DefaultPiHostSurfaceReader,
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceReader,
  readHostSurfaceReport,
  readValidatedCommands,
  safeReadHostSurfaceReport,
} from "../host-inventory.js";

describe("readValidatedCommands", () => {
  it("passes through a well-formed inventory", () => {
    const api = {
      getCommands: () => [
        {
          name: "weave:health",
          source: "extension" as const,
          sourceInfo: {
            path: "/node_modules/@weaveio/weave-adapter-pi/dist/extension.js",
            source: "npm:@weaveio/weave-adapter-pi",
            scope: "user" as const,
            origin: "package" as const,
          },
        },
      ],
    };
    const result = readValidatedCommands(api);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it("converts a throwing host call into InvariantViolation", () => {
    const api = {
      getCommands: () => {
        throw new Error("host exploded");
      },
    };
    const result = readValidatedCommands(api);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });

  it("converts a malformed payload into InvariantViolation instead of trusting the shape", () => {
    const api = { getCommands: () => [{ name: 42 }] as unknown as [] };
    const result = readValidatedCommands(api);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("InvariantViolation");
  });
});

describe("host surface inventory", () => {
  it("normalizes malformed, duplicate, missing, and unknown rows to the exact contract", () => {
    const report = readHostSurfaceReport([
      { surfaceId: "rpc-steer", status: "bad", details: { secret: "x" } },
      { surfaceId: "rpc-steer", status: "native", details: "duplicate" },
      {
        surfaceId: "assistant-rendering",
        status: "unavailable",
        details: "bad",
      },
      { surfaceId: "unknown", status: "native", details: "ignored" },
    ]);
    expect(report.probes.map((probe) => probe.surfaceId)).toEqual([
      ...PI_HOST_SURFACE_IDS,
    ]);
    expect(report.probes).toHaveLength(PI_HOST_SURFACE_IDS.length);
    expect(
      report.probes.find((probe) => probe.surfaceId === "rpc-steer")?.status,
    ).toBe("unavailable");
    expect(
      report.probes.find((probe) => probe.surfaceId === "assistant-rendering")
        ?.status,
    ).toBe("fallback");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.probes)).toBe(true);
  });

  it("returns all thirteen native rows when the public namespace is complete", async () => {
    const reader = new DefaultPiHostSurfaceReader();
    const result = await reader.read({
      api: {} as never,
      ui: {
        setStatus: () => undefined,
        setEditorComponent: () => undefined,
      } as never,
      rootExports: {
        VERSION: "0.81.1",
        AssistantMessageComponent: () => undefined,
        ToolExecutionComponent: () => undefined,
        Markdown: () => undefined,
        Image: () => undefined,
        FooterComponent: () => undefined,
        BorderedLoader: () => undefined,
        CustomEditor: () => undefined,
      },
    });
    const report = readHostSurfaceReport(result._unsafeUnwrap());
    expect(report.probes).toHaveLength(13);
    expect(report.probes.every((probe) => probe.status === "native")).toBe(
      true,
    );
    expect(report.probes.map((probe) => probe.surfaceId)).toEqual([
      ...PI_HOST_SURFACE_IDS,
    ]);
  });

  it("uses fallback status for every optional rendering surface when exports are absent", async () => {
    const result = await new DefaultPiHostSurfaceReader().read({
      api: {} as never,
      ui: {
        setStatus: () => undefined,
        setEditorComponent: () => undefined,
      } as never,
      rootExports: { VERSION: "0.81.1", CustomEditor: () => undefined },
    });
    const report = readHostSurfaceReport(result._unsafeUnwrap());
    expect(
      report.probes.slice(0, 6).every((probe) => probe.status === "fallback"),
    ).toBe(true);
    expect(report.probes[6]?.status).toBe("native");
    expect(report.requiredGaps).toEqual([]);
  });

  it("makes each required surface unavailable when it is missing", () => {
    for (const requiredSurface of PI_HOST_COMPATIBILITY_MATRIX.surfaces.filter(
      (surface) => surface.required,
    )) {
      const rows = PI_HOST_SURFACE_IDS.map((surfaceId) => ({
        surfaceId,
        status: "native" as const,
        details: "ok",
      })).filter((row) => row.surfaceId !== requiredSurface.id);
      const report = readHostSurfaceReport(rows);
      expect(report.requiredGaps).toEqual([requiredSurface.id]);
      expect(
        report.probes.find((probe) => probe.surfaceId === requiredSurface.id),
      ).toEqual({
        surfaceId: requiredSurface.id,
        status: "unavailable",
        details: "surface-missing",
      });
    }
  });

  it("falls back safely for malformed reader outcomes and never throws", async () => {
    const input = { api: {} as never, ui: {} as never };
    const readers: PiHostSurfaceReader[] = [
      {
        read: () => {
          throw new Error("sync");
        },
      },
      { read: () => Promise.reject(new Error("reject")) as never },
      { read: () => errAsync({ type: "ReaderRejected" as const }) },
      { read: () => okAsync(null) as never },
      { read: () => okAsync([{ surfaceId: "rpc-steer" }]) as never },
    ];
    for (const reader of readers) {
      const result = await safeReadHostSurfaceReport(reader, input);
      expect(result.isOk()).toBe(true);
      const report = result._unsafeUnwrap();
      expect(report.probes).toHaveLength(13);
      expect(report.requiredGaps).toEqual(
        PI_HOST_COMPATIBILITY_MATRIX.surfaces
          .filter((surface) => surface.required)
          .map((surface) => surface.id),
      );
      expect(Object.isFrozen(report.probes)).toBe(true);
    }
  });

  it("uses only public VERSION and matrix facts for required protocol surfaces", async () => {
    const reader = new DefaultPiHostSurfaceReader();
    const result = await reader.read({
      api: {
        sendUserMessage: () => undefined,
        appendEntry: () => undefined,
      } as never,
      ui: {
        custom: () => undefined,
        setStatus: () => undefined,
        setEditorComponent: () => undefined,
      } as never,
      rootExports: {
        VERSION: "0.81.1",
        AssistantMessageComponent: () => undefined,
        CustomEditor: () => undefined,
      },
    });
    const report = readHostSurfaceReport(result._unsafeUnwrap());
    expect(report.requiredGaps).toEqual([]);
    expect(
      report.probes.find((probe) => probe.surfaceId === "assistant-rendering")
        ?.status,
    ).toBe("native");
    expect(
      report.probes.find((probe) => probe.surfaceId === "tool-rendering")
        ?.status,
    ).toBe("fallback");
  });
});
