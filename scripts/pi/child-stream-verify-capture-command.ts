import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import {
  type CaptureSuccess,
  captureChildEvents,
  type FixtureValidationFailure,
  type ReplayFacts,
  readFixtureAndManifest,
  replayFixtureThroughAdapter,
  runFixtureRedControls,
  verifyCaptureManifest,
} from "./child-stream-capture.js";
import {
  blocked,
  type VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

export interface CaptureCommandInput {
  readonly pi: string;
  readonly requireHostVersion: string;
  readonly fixtureDir: string;
}

export type CaptureCommandSuccess = CaptureSuccess;

export function runCaptureCommand(
  input: CaptureCommandInput,
): ResultAsync<CaptureCommandSuccess, VerifyChildStreamingFailure> {
  return captureChildEvents(input).mapErr((failure) => blocked(failure.type));
}

export interface ReplayCommandInput {
  readonly fixture: string;
  readonly injectControlledReasoningInMemory: true;
  readonly verifyManifest: true;
  readonly runRedControls: true;
}

export interface ReplayCommandSuccess {
  readonly redControls: number;
  readonly replay: ReplayFacts;
}

function fixtureFailure(
  failure: FixtureValidationFailure,
): VerifyChildStreamingFailure {
  return blocked(failure.type);
}

export function runReplayCommand(
  input: ReplayCommandInput,
): ResultAsync<ReplayCommandSuccess, VerifyChildStreamingFailure> {
  return readFixtureAndManifest(input.fixture)
    .andThen(({ fixtureText, manifestText }) => {
      const result = verifyCaptureManifest(fixtureText, manifestText);
      return result.isOk()
        ? okAsync({
            fixtureText,
            manifestText,
            fixture: result.value.fixture,
          })
        : errAsync(fixtureFailure(result.error));
    })
    .andThen(({ fixtureText, manifestText, fixture }) => {
      const red = runFixtureRedControls(fixtureText, manifestText);
      if (red.isErr()) return errAsync(blocked(red.error.mutation));
      const replay = replayFixtureThroughAdapter(fixture, {
        injectControlledReasoningInMemory:
          input.injectControlledReasoningInMemory,
      });
      if (replay.isErr()) return errAsync(fixtureFailure(replay.error));
      return okAsync({
        redControls: Object.keys(red.value).length,
        replay: replay.value,
      });
    });
}
