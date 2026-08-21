import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  makeHostIdentityUnknownFailure,
  type PiAdapterFailure,
} from "../../errors.js";
import type {
  HostPackageInfo,
  HostPackageReader,
} from "../../host-compatibility.js";

/** Deterministic, injectable host package reader for tests. Never touches disk/network. */
export class FakeHostPackageReader implements HostPackageReader {
  private info: HostPackageInfo | undefined;
  private failure: PiAdapterFailure | undefined;
  callCount = 0;

  static ok(info: HostPackageInfo): FakeHostPackageReader {
    const reader = new FakeHostPackageReader();
    reader.info = info;
    return reader;
  }

  static failing(
    failure: PiAdapterFailure = makeHostIdentityUnknownFailure(
      "fake-read-failure",
    ),
  ): FakeHostPackageReader {
    const reader = new FakeHostPackageReader();
    reader.failure = failure;
    return reader;
  }

  read(): ResultAsync<HostPackageInfo, PiAdapterFailure> {
    this.callCount += 1;
    if (this.failure !== undefined) return errAsync(this.failure);
    if (this.info === undefined) {
      return errAsync(
        makeHostIdentityUnknownFailure("fake-reader-not-configured"),
      );
    }
    return okAsync(this.info);
  }
}
