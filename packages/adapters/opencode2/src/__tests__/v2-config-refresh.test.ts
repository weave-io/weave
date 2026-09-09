import { describe, expect, it } from "bun:test";
import { errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type { OpenCode2CatalogCandidate } from "../v2/catalog.js";
import { OpenCode2CatalogController } from "../v2/config-refresh.js";
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
});
