import { ResultAsync, type ResultAsync as ResultAsyncType } from "neverthrow";

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): ResultAsyncType<void, never>;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  sleep(milliseconds: number): ResultAsync<void, never> {
    return ResultAsync.fromSafePromise(Bun.sleep(milliseconds));
  }
}
