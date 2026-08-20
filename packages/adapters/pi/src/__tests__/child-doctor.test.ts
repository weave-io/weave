import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  createPiDoctorPort,
  createSkippedDoctorCheckPorts,
  createStoreBackedDoctorCheckPorts,
  doctorCapabilitiesFromProbes,
  doctorOrphanCheckFromRows,
  failedDoctorCheck,
  passedDoctorCheck,
  PI_DOCTOR_BOUNDS,
  PI_DOCTOR_CHECK_IDS,
  runChildDoctor,
  skippedDoctorCheck,
  type PiDoctorCheckPorts,
} from "../child-doctor.js";
import { PiDoctorResultSchema } from "../adapter-cli-commands.js";
import { sanitizeDiagnosticValue } from "../telemetry.js";

function allPassPorts(
  overrides: Partial<PiDoctorCheckPorts> = {},
): PiDoctorCheckPorts {
  const pass = (detail: string) => okAsync(passedDoctorCheck(detail));
  return {
    capabilities: overrides.capabilities ?? (() => pass("ok=1")),
    permissions: overrides.permissions ?? (() => pass("mode=ok")),
    sessions: overrides.sessions ?? (() => pass("available=1")),
    refs: overrides.refs ?? (() => pass("usable=1")),
    cache: overrides.cache ?? (() => pass("cache mode active")),
    stale: overrides.stale ?? (() => pass("stale=0")),
    orphans: overrides.orphans ?? (() => pass("orphans=0")),
  };
}

describe("runChildDoctor", () => {
  it("returns a stable pass-shaped report for every check", async () => {
    const result = await runChildDoctor({ ports: allPassPorts() });
    const report = result._unsafeUnwrap();
    expect(PiDoctorResultSchema.safeParse(report).success).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.checks).toHaveLength(PI_DOCTOR_BOUNDS.checkCount);
    expect(report.checks.map((check) => check.id)).toEqual([
      PI_DOCTOR_CHECK_IDS.capabilities,
      PI_DOCTOR_CHECK_IDS.permissions,
      PI_DOCTOR_CHECK_IDS.sessions,
      PI_DOCTOR_CHECK_IDS.refs,
      PI_DOCTOR_CHECK_IDS.cache,
      PI_DOCTOR_CHECK_IDS.stale,
      PI_DOCTOR_CHECK_IDS.orphans,
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("isolates one failing check without stopping others", async () => {
    const result = await runChildDoctor({
      ports: allPassPorts({
        cache: () =>
          errAsync({
            type: "CheckFailed" as const,
            message: "cache exploded",
            code: "ChildCacheDegraded" as const,
          }),
        permissions: () => okAsync(failedDoctorCheck("bad mode", "ChildSessionPermissionError")),
      }),
    });
    const report = result._unsafeUnwrap();
    expect(report.status).toBe("degraded");
    expect(report.checks).toHaveLength(7);
    const byId = Object.fromEntries(
      report.checks.map((check) => [check.id, check.status]),
    );
    expect(byId[PI_DOCTOR_CHECK_IDS.cache]).toBe("fail");
    expect(byId[PI_DOCTOR_CHECK_IDS.permissions]).toBe("fail");
    expect(byId[PI_DOCTOR_CHECK_IDS.capabilities]).toBe("pass");
    expect(byId[PI_DOCTOR_CHECK_IDS.orphans]).toBe("pass");
  });

  it("sanitizes seeded transcript text and paths out of the report", async () => {
    const secret = "SECRET_TRANSCRIPT_LINE_do_not_leak";
    const result = await runChildDoctor({
      ports: allPassPorts({
        sessions: () =>
          okAsync({
            status: "fail",
            detail: `${secret} and path /tmp/weave/sessions/child.jsonl`,
          }),
      }),
    });
    const report = result._unsafeUnwrap();
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("/tmp/weave/sessions/child.jsonl");
    expect(encoded).not.toMatch(/prompt|transcript|assistant/i);
  });

  it("strips forbidden keys via sanitizeDiagnosticValue", () => {
    const cleaned = sanitizeDiagnosticValue({
      id: "doctor.sessions",
      status: "pass",
      prompt: "should vanish",
      transcript: [{ role: "assistant", content: "nope" }],
      message: "nope",
      detail: "ok",
      path: "/secret",
    }) as Record<string, unknown>;
    expect(cleaned.prompt).toBeUndefined();
    expect(cleaned.transcript).toBeUndefined();
    expect(cleaned.message).toBeUndefined();
    expect(cleaned.path).toBeUndefined();
    expect(cleaned.detail).toBe("ok");
  });

  it("remains available in health-only mode", async () => {
    const port = createPiDoctorPort({
      ports: allPassPorts(),
      healthOnly: () => true,
    });
    const report = (
      await port.run({ diagnostic: true })
    )._unsafeUnwrap();
    expect(report.kind).toBe("doctor");
    expect(report.status).toBe("ok");
    expect(report.diagnostics?.healthOnly).toBe("true");
  });

  it("bounds the orphan scan page", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      childId: `child-${index}`,
      originParentSessionId: index % 2 === 0 ? "parent-live" : "parent-gone",
    }));
    const outcome = (
      await doctorOrphanCheckFromRows({
        liveParentSessionId: "parent-live",
        rows,
      })
    )._unsafeUnwrap();
    expect(outcome.status).toBe("pass");
    expect(outcome.detail).toContain(`bound=${PI_DOCTOR_BOUNDS.orphanPageSize}`);
    expect(outcome.detail).toContain(
      `scanned=${PI_DOCTOR_BOUNDS.orphanPageSize}`,
    );
    expect(outcome.detail).toContain("orphans=25");
  });

  it("maps capability probes to pass/fail shapes", async () => {
    const ok = (
      await doctorCapabilitiesFromProbes([
        { capabilityId: "a", probeStatus: "ok" },
      ])
    )._unsafeUnwrap();
    expect(ok.status).toBe("pass");
    const bad = (
      await doctorCapabilitiesFromProbes([
        { capabilityId: "a", probeStatus: "unavailable" },
      ])
    )._unsafeUnwrap();
    expect(bad.status).toBe("fail");
    expect(bad.code).toBe("RequiredCapabilityUnavailable");
  });

  it("skips unbound store checks and reports unavailable when all skip", async () => {
    const report = (
      await runChildDoctor({ ports: createSkippedDoctorCheckPorts() })
    )._unsafeUnwrap();
    expect(report.status).toBe("unavailable");
    expect(report.checks.every((check) => check.status === "skip")).toBe(true);
  });

  it("store-backed ports surface cache degrade and session integrity", async () => {
    const ports = createStoreBackedDoctorCheckPorts({
      capabilities: () => okAsync(passedDoctorCheck("ok=1")),
      permissions: () => okAsync(passedDoctorCheck("mode=ok")),
      cacheMode: "degraded",
      readRefs: () =>
        okAsync({
          counts: {
            scannedEntries: 2,
            malformedEntries: 0,
            conflictingChildren: 0,
            originMismatchedChildren: 0,
            usableRefs: 1,
            unusableSourceChildren: 1,
          },
          refs: [
            {
              childId: "c1",
              sessionRef: "c1/session.jsonl",
              originParentSessionId: "p1",
              status: "completed",
            },
          ],
        }),
      listSessionsByRef: () =>
        okAsync([{ state: "missing" as const }]),
      listMetadata: () =>
        okAsync([
          {
            childId: "c1",
            originParentSessionId: "p1",
            stale: true,
            tombstoned: false,
          },
        ]),
      liveParentSessionId: "p1",
    });
    const report = (await runChildDoctor({ ports }))._unsafeUnwrap();
    const byId = Object.fromEntries(
      report.checks.map((check) => [check.id, check]),
    );
    expect(byId[PI_DOCTOR_CHECK_IDS.cache]?.status).toBe("fail");
    expect(byId[PI_DOCTOR_CHECK_IDS.sessions]?.status).toBe("fail");
    expect(byId[PI_DOCTOR_CHECK_IDS.stale]?.status).toBe("fail");
    expect(byId[PI_DOCTOR_CHECK_IDS.orphans]?.status).toBe("pass");
    expect(skippedDoctorCheck("x").status).toBe("skip");
  });
});
