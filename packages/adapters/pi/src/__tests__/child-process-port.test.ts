/**
 * Port-level regression test for the exact-host live smoke bug (Pi adapter contract
 * §11.5): `PiRpcChild.terminateResources()` previously used only
 * `PiSpawnedChildProcess.kill()`, which `BunPiChildProcessPort` mapped to
 * `subprocess.kill()` with no explicit signal - the runtime's own default,
 * `SIGTERM`. A stopped (`SIGSTOP`'d) or otherwise non-cooperative child can
 * leave a `SIGTERM` pending indefinitely instead of acting on it, which is
 * exactly what the live smoke evidence showed: a delegated child SIGSTOP'd
 * to simulate non-cooperation, cancelled, and left `T+` in `ps` well past
 * the bounded cancellation grace, never actually reaped.
 *
 * `BunPiChildProcessPort` itself calls the real `Bun.spawn` and is
 * deliberately never exercised by an automated test (Pi adapter contract:
 * "no automated test may spawn a real process" - see `child-process-port.ts`).
 * `resolveKillSignal` is the one piece of "which signal do we actually ask
 * for" logic pulled out into a pure, synchronous function specifically so
 * it can be proven here without spawning anything real.
 */
import { describe, expect, it } from "bun:test";
import { FORCE_KILL_SIGNAL, resolveKillSignal } from "../child-process-port.js";

describe("resolveKillSignal", () => {
  it("resolves force-kill to the mandatory SIGKILL-equivalent signal", () => {
    expect(resolveKillSignal("force")).toBe(FORCE_KILL_SIGNAL);
    expect(FORCE_KILL_SIGNAL).toBe(9);
  });

  it("resolves cooperative/default termination to no explicit signal at all", () => {
    // `undefined` here means "let `Bun.spawn`'s own `Subprocess.kill()`
    // apply its own default (SIGTERM)" - never a stand-in for SIGKILL.
    expect(resolveKillSignal("cooperative")).toBeUndefined();
  });

  it("never conflates the two modes - force always differs from cooperative", () => {
    expect(resolveKillSignal("force")).not.toBe(
      resolveKillSignal("cooperative"),
    );
  });
});
