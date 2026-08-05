import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  ChildProcessError,
  PiChildProcessPort,
  PiChildSpawnInput,
  PiSpawnedChildProcess,
} from "../../child-process-port.js";

/**
 * A fully scripted stand-in for a real child process (Pi adapter contract:
 * no automated test may spawn a real process). The test drives every byte
 * the "child" ever sends via {@link FakeSpawnedProcess.emitLine}/`emit`,
 * and inspects every byte the parent ever wrote via `writtenText`.
 */
export class FakeSpawnedProcess implements PiSpawnedChildProcess {
  readonly writtenChunks: Uint8Array[] = [];
  killed = false;
  /**
   * Set only by {@link forceKill}, never by the cooperative {@link kill}.
   * Lets tests assert the mandatory-force-kill path was actually taken
   * (Pi adapter contract), not merely that *some* kill happened.
   */
  forceKilled = false;
  private dataHandlers: Array<(chunk: Uint8Array) => void> = [];
  private endHandlers: Array<() => void> = [];
  private errorHandlers: Array<(reason: string) => void> = [];
  private exitResolve: ((code: number | null) => void) | undefined;
  readonly exited: Promise<number | null>;
  private nextWriteError: ChildProcessError | undefined;
  private resolveWriteCalled!: () => void;
  readonly writeCalled: Promise<void>;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    this.writeCalled = new Promise((resolve) => {
      this.resolveWriteCalled = resolve;
    });
  }

  get writtenText(): string {
    const total = this.writtenChunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.writtenChunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  /** Every complete `{...}\n` line the parent has written so far, parsed as JSON. */
  writtenLines(): unknown[] {
    return this.writtenText
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  failNextWrite(error: ChildProcessError): void {
    this.nextWriteError = error;
  }

  writeStdin(bytes: Uint8Array): ResultAsync<void, ChildProcessError> {
    if (this.nextWriteError !== undefined) {
      const error = this.nextWriteError;
      this.nextWriteError = undefined;
      return errAsync(error);
    }
    this.writtenChunks.push(bytes);
    this.resolveWriteCalled();
    return okAsync(undefined);
  }

  readonly stdout = {
    onData: (cb: (chunk: Uint8Array) => void) => {
      this.dataHandlers.push(cb);
    },
    onEnd: (cb: () => void) => {
      this.endHandlers.push(cb);
    },
    onError: (cb: (reason: string) => void) => {
      this.errorHandlers.push(cb);
    },
  };

  /** Simulates a broken-pipe/stream-read failure, mirroring the real port's `onError` + fall-through `onEnd`. */
  failStdoutRead(reason: string): void {
    for (const handler of this.errorHandlers) handler(reason);
    for (const handler of this.endHandlers) handler();
  }

  /** Simulates the child writing one raw JSON value as a complete LF-terminated line. */
  emitLine(json: unknown): void {
    this.emit(new TextEncoder().encode(`${JSON.stringify(json)}\n`));
  }

  emit(bytes: Uint8Array): void {
    for (const handler of this.dataHandlers) handler(bytes);
  }

  endStdout(): void {
    for (const handler of this.endHandlers) handler();
  }

  exit(code: number | null): void {
    this.exitResolve?.(code);
  }

  kill(): void {
    this.killed = true;
  }

  forceKill(): void {
    this.killed = true;
    this.forceKilled = true;
  }
}

export class FakeChildProcessPort implements PiChildProcessPort {
  readonly spawnedProcesses: FakeSpawnedProcess[] = [];
  readonly spawnInputs: PiChildSpawnInput[] = [];
  private nextSpawnError: ChildProcessError | undefined;
  private readonly spawnResolvers: ((process: FakeSpawnedProcess) => void)[] =
    [];
  readonly spawnCalled: Promise<FakeSpawnedProcess>;
  readonly spawnPromises: Promise<FakeSpawnedProcess>[] = [];

  constructor() {
    this.spawnCalled = this.createSpawnPromise();
  }

  private createSpawnPromise(): Promise<FakeSpawnedProcess> {
    const promise = new Promise<FakeSpawnedProcess>((resolve) => {
      this.spawnResolvers.push(resolve);
    });
    this.spawnPromises.push(promise);
    return promise;
  }

  failNextSpawn(error: ChildProcessError): void {
    this.nextSpawnError = error;
  }

  spawn(
    input: PiChildSpawnInput,
  ): ResultAsync<PiSpawnedChildProcess, ChildProcessError> {
    this.spawnInputs.push(input);
    if (this.nextSpawnError !== undefined) {
      const error = this.nextSpawnError;
      this.nextSpawnError = undefined;
      return errAsync(error);
    }
    const process = new FakeSpawnedProcess();
    this.spawnedProcesses.push(process);
    this.spawnResolvers.shift()?.(process);
    this.createSpawnPromise();
    return okAsync(process);
  }
}
