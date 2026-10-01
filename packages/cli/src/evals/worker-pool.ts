/**
 * A bounded worker pool for independent units of eval work.
 *
 * `weave eval run --concurrency <n>` (Spec 39, gap G7) runs the units of a
 * run — one suite on one model in one repeat — through this pool, at most
 * `n` at a time. The pool owns only scheduling:
 *
 * - Items start in their order, so a concurrency of 1 runs them one after
 *   another exactly as a plain loop would.
 * - Results come back in the order of the items, never in the order they
 *   finished, so whatever is built from them (score files, usage rows,
 *   reports, bundles) does not depend on timing.
 * - One item's failure never cancels another: every item runs and gets its
 *   own `Result`. Work that throws or rejects, which a `ResultAsync` should
 *   never do, becomes that item's error through `onDefect`.
 */

import { err, Result, type ResultAsync } from "neverthrow";

export class WorkerPool {
  private readonly concurrency: number;

  /** @param concurrency - Most items in flight at once; below 1 means 1. */
  constructor(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  /**
   * Run `work` over `items`, at most `concurrency` at a time.
   *
   * @param items - The units of work, in the order results are returned.
   * @param work - Runs one item; `index` is its position in `items`.
   * @param onDefect - Turns work that threw or rejected into its error.
   * @returns One result per item, in the order of `items`.
   */
  async run<T, R, E>(
    items: readonly T[],
    work: (item: T, index: number) => ResultAsync<R, E>,
    onDefect: (cause: unknown, item: T) => E,
  ): Promise<Array<Result<R, E>>> {
    const results = new Array<Result<R, E>>(items.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index] as T;
        results[index] = await this.runOne(item, index, work, onDefect);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, items.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  /** Run one item, turning a throw or a rejection into its error. */
  private async runOne<T, R, E>(
    item: T,
    index: number,
    work: (item: T, index: number) => ResultAsync<R, E>,
    onDefect: (cause: unknown, item: T) => E,
  ): Promise<Result<R, E>> {
    const started = Result.fromThrowable(
      () => work(item, index),
      (cause) => onDefect(cause, item),
    )();
    if (started.isErr()) return err(started.error);
    return started.value.then(
      (result) => result,
      (cause: unknown) => err(onDefect(cause, item)),
    );
  }
}
