import { err, ok, type Result } from "neverthrow";
import {
  EXACT_PI_VERSION,
  failure,
  HEALTH_MODE_PATTERN,
  HEALTH_ONLY_FACT_PATTERN,
  HEALTH_SURFACE_GAP_PATTERN,
  type HealthFacts,
  type HostSurfaceGapFact,
  isRecord,
  MAX_CAPTURE_BYTES,
  MAX_HEALTH_SURFACE_GAPS,
  type SmokeFailure,
} from "./contract.js";

function stripAnsi(value: string): string {
  const escapeChar = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const csi = new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, "gu");
  const osc = new RegExp(
    `${escapeChar}\\][^${bell}]*(?:${bell}|${escapeChar}\\\\)`,
    "gu",
  );
  return value.replaceAll(csi, "").replaceAll(osc, "");
}

export function normalizedTuiOutput(output: string): string {
  return stripAnsi(output).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function visibleEventCount(output: string): number {
  return (
    normalizedTuiOutput(output).match(/(?:^|\n)\s*MODEL FALLBACK\b/gm) ?? []
  ).length;
}

/** Parse only bounded mode facts emitted by `/weave:health`. */
export function parseHealthFacts(
  output: string,
): Result<HealthFacts, SmokeFailure> {
  if (new TextEncoder().encode(output).byteLength > MAX_CAPTURE_BYTES) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation exceeds the byte bound",
      ),
    );
  }
  const text = stripAnsi(output);
  const modes = [...text.matchAll(HEALTH_MODE_PATTERN)].map((match) =>
    match[1]?.trim().toLowerCase(),
  );
  if (
    modes.length === 0 ||
    modes.some((mode) => mode !== "ready" && mode !== "health-only")
  ) {
    return err(
      failure("CaptureMalformed", "real /weave:health adapter mode is invalid"),
    );
  }
  const mode = modes[0];
  if (modes.some((candidate) => candidate !== mode)) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation repeats conflicting modes",
      ),
    );
  }
  const healthOnly = mode === "health-only";
  const explicitHealthOnly = [...text.matchAll(HEALTH_ONLY_FACT_PATTERN)].map(
    (match) => match[1]?.trim().toLowerCase(),
  );
  if (
    explicitHealthOnly.some((value) => value !== "true" && value !== "false") ||
    (explicitHealthOnly.length > 0 &&
      explicitHealthOnly.some((value) => value !== explicitHealthOnly[0]))
  ) {
    return err(
      failure(
        "CaptureMalformed",
        "real health observation health-only is invalid",
      ),
    );
  }
  if (
    explicitHealthOnly.length > 0 &&
    (explicitHealthOnly[0] === "true") !== healthOnly
  ) {
    return err(
      failure("CaptureMalformed", "real health observation facts disagree"),
    );
  }
  const gaps: HostSurfaceGapFact[] = [];
  const gapLines = [...text.matchAll(HEALTH_SURFACE_GAP_PATTERN)];
  if (gapLines.length > MAX_HEALTH_SURFACE_GAPS)
    return err(
      failure("CaptureMalformed", "health surface gap bound exceeded"),
    );
  const field = (line: string, name: string): string | undefined =>
    new RegExp(`(?:^|;\\s*)${name}:\\s*([^;]+)`, "iu").exec(line)?.[1]?.trim();
  for (const match of gapLines) {
    const line = (match[1] ?? "").replace(/\s+/gu, " ").trim();
    if (line.length === 0 || line.length > 2_048)
      return err(
        failure("CaptureMalformed", "health surface gap is malformed"),
      );
    const capability = field(line, "capability");
    const hostVersion = field(line, "host version");
    const probe = field(line, "probe");
    const gapMode = field(line, "mode");
    if (
      (hostVersion !== EXACT_PI_VERSION &&
        !hostVersion?.startsWith(`${EXACT_PI_VERSION} `)) ||
      capability === undefined ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(capability) ||
      probe === undefined ||
      !/^(?:native|fallback|unavailable):[a-z0-9][a-z0-9-]{0,95}$/u.test(
        probe,
      ) ||
      (gapMode !== "health-only" &&
        gapMode !== "custom-editor-fallback" &&
        gapMode !== "feature-unavailable")
    )
      return err(failure("CaptureMalformed", "health surface gap is invalid"));
    if (gaps.some((gap) => gap.capability === capability))
      return err(
        failure("CaptureMalformed", "health surface gap is duplicated"),
      );
    gaps.push({ capability, probe, mode: gapMode });
  }
  const runtimeModelFallback = gaps.find(
    (gap) => gap.capability === "runtime-model-fallback",
  );
  return ok({
    source: "real-pi-tui",
    ready: !healthOnly,
    healthOnly,
    ...(gaps.length === 0 ? {} : { hostSurfaceGaps: gaps }),
    ...(runtimeModelFallback === undefined ? {} : { runtimeModelFallback }),
  });
}

export function validateHealthObservation(
  health: HealthFacts | undefined,
): Result<HealthFacts, SmokeFailure> {
  if (health === undefined) {
    return err(
      failure("CaptureMalformed", "real health observation is missing"),
    );
  }
  if (
    health.source !== "real-pi-tui" ||
    typeof health.ready !== "boolean" ||
    typeof health.healthOnly !== "boolean"
  ) {
    return err(
      failure("CaptureMalformed", "health observation fields are invalid"),
    );
  }
  if (health.ready === health.healthOnly) {
    return err(
      failure("CaptureMalformed", "health observation mode is ambiguous"),
    );
  }
  const gaps = health.hostSurfaceGaps;
  if (gaps !== undefined) {
    if (
      gaps.length === 0 ||
      gaps.length > MAX_HEALTH_SURFACE_GAPS ||
      gaps.some(
        (gap) =>
          !isRecord(gap) ||
          typeof gap.capability !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(gap.capability) ||
          typeof gap.probe !== "string" ||
          !/^(?:native|fallback|unavailable):[a-z0-9][a-z0-9-]{0,95}$/u.test(
            gap.probe,
          ) ||
          (gap.mode !== "health-only" &&
            gap.mode !== "custom-editor-fallback" &&
            gap.mode !== "feature-unavailable"),
      )
    )
      return err(
        failure("CaptureMalformed", "health surface gaps are invalid"),
      );
    if (new Set(gaps.map((gap) => gap.capability)).size !== gaps.length)
      return err(
        failure("CaptureMalformed", "health surface gap is duplicated"),
      );
  }
  const runtimeGap = gaps?.find(
    (gap) => gap.capability === "runtime-model-fallback",
  );
  if (
    (health.runtimeModelFallback === undefined) !==
      (runtimeGap === undefined) ||
    (health.runtimeModelFallback !== undefined &&
      JSON.stringify(health.runtimeModelFallback) !==
        JSON.stringify(runtimeGap))
  )
    return err(
      failure(
        "CaptureMalformed",
        "runtime-model-fallback health evidence disagrees",
      ),
    );
  return ok(health);
}
