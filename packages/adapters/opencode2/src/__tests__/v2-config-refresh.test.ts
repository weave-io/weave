/**
 * Scenarios in `tests/adapters/opencode2.scenario.test.ts` cover what a
 * user observes of this adapter.
 *
 * Kept: the refresh controller's single-flight, last-valid and
 * restore-on-reload-failure behaviour. A scenario sees a refreshed catalog and
 * a failed one, but not which of two concurrent builds won, nor that a
 * candidate is rolled back when the host's registry reload fails — the host a
 * scenario drives always reloads successfully, and a scenario cannot race the
 * controller. Also kept: the background refresh's pacing — a scenario sees an
 * edit picked up without a prompt, but not that a slow probe never overlaps
 * the next one, nor that no probe runs once it is stopped.
 */

import { describe, expect, it } from "bun:test";
import { errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import {
  OpenCode2BackgroundRefresh,
  OpenCode2CatalogController,
  type OpenCode2RefreshState,
} from "../v2/config-refresh.js";
import type { OpenCode2Error } from "../v2/errors.js";
import { catalog } from "./v2-fixtures.js";

function withRevision(revision: string) {
  return { ...catalog(), revision: revision.repeat(64).slice(0, 64) };
}

describe("OpenCode2CatalogController", () => {
  it("shares a single in-flight build", async () => {
    let resolveBuild:
      | ((value: Result<OpenCode2CatalogCandidate, OpenCode2Error>) => void)
      | undefined;
    const pending = new Promise<
      Result<OpenCode2CatalogCandidate, OpenCode2Error>
    >((resolve) => {
      resolveBuild = resolve;
    });
    let builds = 0;
    const controller = new OpenCode2CatalogController(0, {
      build: () => {
        builds += 1;
        return ResultAsync.fromSafePromise(pending).andThen((result) => result);
      },
      reload: async () => undefined,
    });
    const first = controller.initialize();
    const second = controller.refreshIfDue();
    resolveBuild?.(ok<OpenCode2CatalogCandidate, OpenCode2Error>(catalog()));
    expect((await first).isOk()).toBe(true);
    expect((await second).isOk()).toBe(true);
    expect(builds).toBe(1);
  });

  it("keeps the last valid catalog after a failed build", async () => {
    let fail = false;
    const current = withRevision("a");
    const controller = new OpenCode2CatalogController(0, {
      build: () =>
        fail
          ? errAsync({
              code: "config_unavailable",
              message: "invalid",
            } satisfies OpenCode2Error)
          : ResultAsync.fromSafePromise(Promise.resolve(current)),
      reload: async () => undefined,
    });
    await controller.initialize();
    fail = true;
    expect((await controller.refreshIfDue())._unsafeUnwrap()).toBe(current);
    expect(controller.status()).toEqual({
      state: "failed",
      lastErrorCode: "config_unavailable",
    });
  });

  it("reloads registries when the first valid catalog recovers after initialization", async () => {
    const recovered = withRevision("r");
    let builds = 0;
    let reloads = 0;
    const controller = new OpenCode2CatalogController(0, {
      build: () => {
        builds += 1;
        if (builds === 1) {
          return errAsync({
            code: "config_unavailable",
            message: "invalid",
          } satisfies OpenCode2Error);
        }
        return ResultAsync.fromSafePromise(Promise.resolve(recovered));
      },
      reload: async () => {
        reloads += 1;
      },
    });
    expect((await controller.initialize()).isErr()).toBe(true);
    expect((await controller.refreshIfDue())._unsafeUnwrap()).toBe(recovered);
    expect(controller.catalog()).toBe(recovered);
    expect(reloads).toBe(1);
  });

  it("avoids recomposition when the source manifest is unchanged", async () => {
    let builds = 0;
    let probes = 0;
    const current = withRevision("a");
    const controller = new OpenCode2CatalogController(0, {
      build: () => {
        builds += 1;
        return ResultAsync.fromSafePromise(Promise.resolve(current));
      },
      changed: () => {
        probes += 1;
        return ResultAsync.fromSafePromise(Promise.resolve(false));
      },
      reload: async () => undefined,
    });
    await controller.initialize();
    expect((await controller.refreshIfDue())._unsafeUnwrap()).toBe(current);
    expect({ builds, probes }).toEqual({ builds: 1, probes: 1 });
  });

  it("rebuilds when the host inventory changes even if sources are unchanged", async () => {
    const candidates = [withRevision("a"), withRevision("b")];
    let builds = 0;
    let probes = 0;
    let reloads = 0;
    const controller = new OpenCode2CatalogController(60_000, {
      build: () =>
        ResultAsync.fromSafePromise(
          Promise.resolve(candidates[builds++] ?? withRevision("c")),
        ),
      changed: () => {
        probes += 1;
        return ResultAsync.fromSafePromise(Promise.resolve(false));
      },
      reload: async () => {
        reloads += 1;
      },
    });
    await controller.initialize();
    expect((await controller.refreshInventory())._unsafeUnwrap()).toBe(
      candidates[1],
    );
    expect({ builds, probes, reloads }).toEqual({
      builds: 2,
      probes: 0,
      reloads: 1,
    });
  });

  it("restores the previous candidate after a registry reload failure", async () => {
    const candidates = [withRevision("a"), withRevision("b")];
    const fallback = withRevision("b");
    let builds = 0;
    let reloads = 0;
    const controller = new OpenCode2CatalogController(0, {
      build: () =>
        ResultAsync.fromSafePromise(
          Promise.resolve(candidates[builds++] ?? fallback),
        ),
      reload: async () => {
        reloads += 1;
        if (reloads === 1) throw new Error("failed");
      },
    });
    const first = (await controller.initialize())._unsafeUnwrap();
    expect((await controller.refreshIfDue())._unsafeUnwrap()).toBe(first);
    expect(controller.catalog()).toBe(first);
    expect(reloads).toBe(2);
  });

  it("does not publish a late build after disposal", async () => {
    let resolveBuild:
      | ((value: Result<OpenCode2CatalogCandidate, OpenCode2Error>) => void)
      | undefined;
    const pending = new Promise<
      Result<OpenCode2CatalogCandidate, OpenCode2Error>
    >((resolve) => {
      resolveBuild = resolve;
    });
    const controller = new OpenCode2CatalogController(0, {
      build: () =>
        ResultAsync.fromSafePromise(pending).andThen((result) => result),
      reload: async () => undefined,
    });
    const refresh = controller.initialize();
    controller.dispose();
    resolveBuild?.(ok<OpenCode2CatalogCandidate, OpenCode2Error>(catalog()));
    expect((await refresh)._unsafeUnwrapErr().code).toBe("disposed");
    expect(controller.catalog()).toBeUndefined();
    expect(controller.status().state).toBe("disposed");
  });

  it("tells its owner about each publish, and not about a rolled-back one", async () => {
    const candidates = [
      withRevision("a"),
      withRevision("b"),
      withRevision("c"),
    ];
    let builds = 0;
    let failReload = false;
    const published: Array<[string | undefined, string]> = [];
    const controller = new OpenCode2CatalogController(0, {
      build: () =>
        ResultAsync.fromSafePromise(
          Promise.resolve(candidates[builds++] ?? withRevision("d")),
        ),
      reload: async () => {
        if (failReload) throw new Error("host refused");
      },
      published: (previous, next) => {
        published.push([previous?.revision[0], next.revision[0] ?? ""]);
      },
    });
    await controller.initialize();
    await controller.refreshInventory();
    failReload = true;
    await controller.refreshInventory();
    // Same revision as the published one: nothing new to announce.
    failReload = false;
    builds = 1;
    await controller.refreshInventory();
    expect(published).toEqual([
      [undefined, "a"],
      ["a", "b"],
    ]);
  });
});

/** A promise a test settles itself, to order steps without wall-clock waits. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("OpenCode2BackgroundRefresh", () => {
  const fresh = () => okAsync<OpenCode2RefreshState, OpenCode2Error>("fresh");
  const failing = (code: OpenCode2Error["code"]) =>
    errAsync<OpenCode2RefreshState, OpenCode2Error>({ code, message: code });

  it("waits for a slow probe to settle before scheduling the next", async () => {
    const firstStarted = deferred();
    const finishFirst = deferred();
    const secondStarted = deferred();
    let ticks = 0;
    const background = new OpenCode2BackgroundRefresh(
      1,
      () => {
        ticks += 1;
        if (ticks === 1) {
          firstStarted.resolve();
          return ResultAsync.fromSafePromise(
            finishFirst.promise.then((): OpenCode2RefreshState => "fresh"),
          );
        }
        secondStarted.resolve();
        return fresh();
      },
      () => undefined,
    );
    background.start();
    await firstStarted.promise;
    // Many intervals pass while the first probe is still running.
    await Bun.sleep(20);
    const whileRunning = ticks;
    finishFirst.resolve();
    await secondStarted.promise;
    await background.stop();

    expect(whileRunning).toBe(1);
    expect(ticks).toBe(2);
  });

  it("keeps probing after a probe throws or fails", async () => {
    const thirdStarted = deferred();
    let ticks = 0;
    const warnings: string[] = [];
    const background = new OpenCode2BackgroundRefresh(
      1,
      () => {
        ticks += 1;
        if (ticks === 1) throw new Error("probe threw");
        if (ticks === 2) return failing("config_unavailable");
        thirdStarted.resolve();
        return fresh();
      },
      (failure) => warnings.push(failure.code),
    );
    background.start();
    await thirdStarted.promise;
    await background.stop();

    expect(ticks).toBe(3);
    expect(warnings).toEqual(["host_unavailable", "config_unavailable"]);
  });

  it("warns once while the same failure repeats, and again after a success", async () => {
    const outcomes = [
      () => failing("config_unavailable"),
      () => failing("config_unavailable"),
      () => failing("config_unavailable"),
      fresh,
      () => failing("config_unavailable"),
    ];
    const done = deferred();
    let ticks = 0;
    const warnings: string[] = [];
    const background = new OpenCode2BackgroundRefresh(
      1,
      () => {
        const outcome = outcomes[ticks] ?? fresh;
        ticks += 1;
        if (ticks === outcomes.length + 1) done.resolve();
        return outcome();
      },
      (failure) => warnings.push(failure.code),
    );
    background.start();
    await done.promise;
    await background.stop();

    expect(warnings).toEqual(["config_unavailable", "config_unavailable"]);
  });

  it("reports a failure the controller keeps behind its last valid catalog", async () => {
    let probeFails = false;
    const controller = new OpenCode2CatalogController(0, {
      build: () => ResultAsync.fromSafePromise(Promise.resolve(catalog())),
      changed: () =>
        probeFails
          ? errAsync({ code: "config_unavailable", message: "unreadable" })
          : okAsync(false),
      reload: async () => undefined,
    });
    await controller.initialize();
    probeFails = true;

    // refreshIfDue keeps the catalog and reports Ok; only status() says why.
    expect((await controller.refreshIfDue()).isOk()).toBe(true);
    const background = await controller.refreshInBackground();
    expect(background.isErr() && background.error.code).toBe(
      "config_unavailable",
    );
    probeFails = false;
    expect((await controller.refreshInBackground()).isOk()).toBe(true);
  });

  it("runs no probe once stopped, and waits for the one in flight", async () => {
    const firstStarted = deferred();
    const finishFirst = deferred();
    let ticks = 0;
    let settled = false;
    const background = new OpenCode2BackgroundRefresh(
      1,
      () => {
        ticks += 1;
        firstStarted.resolve();
        return ResultAsync.fromSafePromise(
          finishFirst.promise.then((): OpenCode2RefreshState => {
            settled = true;
            return "fresh";
          }),
        );
      },
      () => undefined,
    );
    background.start();
    await firstStarted.promise;
    const stopped = background.stop();
    finishFirst.resolve();
    await stopped;
    const settledWhenStopped = settled;
    await Bun.sleep(20);

    expect(settledWhenStopped).toBe(true);
    expect(ticks).toBe(1);
  });
});
