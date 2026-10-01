/**
 * The bounded model recommendations refresh `weave compose --adapter
 * claude-code` runs after composing (Spec 39, item 6b). The refresher is a
 * stub: no network, no cache files.
 */

import { describe, expect, it } from "bun:test";
import type {
  RefreshError,
  RefreshOutcome,
  RefreshRequest,
} from "@weaveio/weave-config";
import type { ModelUpdatesSettings } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  ComposeModelRefresh,
  type ModelRecommendationsRefresher,
} from "../compose-refresh.js";

class StubRefresher implements ModelRecommendationsRefresher {
  readonly requests: RefreshRequest[] = [];
  constructor(
    private readonly answer: () => ResultAsync<RefreshOutcome, RefreshError>,
  ) {}
  refresh(request: RefreshRequest): ResultAsync<RefreshOutcome, RefreshError> {
    this.requests.push(request);
    return this.answer();
  }
}

const AUTO: ModelUpdatesSettings = { mode: "auto" };

describe("ComposeModelRefresh", () => {
  it("does not call refresh without a model_updates block", async () => {
    const refresher = new StubRefresher(() => okAsync({ type: "Off" }));

    const result = await new ComposeModelRefresh(refresher).run(undefined);

    expect(result).toEqual({ type: "Off" });
    expect(refresher.requests).toEqual([]);
  });

  it("does not call refresh with mode off", async () => {
    const refresher = new StubRefresher(() => okAsync({ type: "Off" }));

    const result = await new ComposeModelRefresh(refresher).run({
      mode: "off",
    });

    expect(result).toEqual({ type: "Off" });
    expect(refresher.requests).toEqual([]);
  });

  it("calls refresh once with the merged settings when opted in", async () => {
    const outcome: RefreshOutcome = {
      type: "Downloaded",
      channel: "stable",
      issued: "2026-10-01T00:00:00Z",
      promoted: { issued: "2026-10-01T00:00:00Z" },
    };
    const refresher = new StubRefresher(() => okAsync(outcome));

    const result = await new ComposeModelRefresh(refresher).run(AUTO);

    expect(refresher.requests).toEqual([{ settings: AUTO }]);
    expect(result).toEqual({ type: "Refreshed", outcome });
  });

  it("returns a failed check as a result instead of throwing", async () => {
    const refresher = new StubRefresher(() =>
      errAsync({
        type: "CheckFailed",
        channel: "stable",
        failure: { type: "Network", message: "offline" },
      }),
    );

    const result = await new ComposeModelRefresh(refresher).run(AUTO);

    expect(result.type).toBe("Failed");
  });

  it("returns a refresher that throws as a failure", async () => {
    const refresher = new StubRefresher(() => {
      throw new Error("boom");
    });

    const result = await new ComposeModelRefresh(refresher).run(AUTO);

    expect(result).toEqual({
      type: "Failed",
      error: { type: "NotStarted", message: "boom" },
    });
  });

  it("returns a refresher whose promise rejects as a failure", async () => {
    const refresher = new StubRefresher(
      () =>
        new ResultAsync<RefreshOutcome, RefreshError>(
          Promise.reject(new Error("rejected")),
        ),
    );

    const result = await new ComposeModelRefresh(refresher).run(AUTO);

    expect(result).toEqual({
      type: "Failed",
      error: { type: "NotStarted", message: "rejected" },
    });
  });

  it("stops waiting once the budget is spent", async () => {
    const refresher = new StubRefresher(
      () =>
        new ResultAsync<RefreshOutcome, RefreshError>(
          new Promise(() => undefined),
        ),
    );
    const started = Date.now();

    const result = await new ComposeModelRefresh(refresher, 30).run(AUTO);

    expect(result).toEqual({ type: "StillRunning", budgetMs: 30 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
