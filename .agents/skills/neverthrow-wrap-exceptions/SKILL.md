---
name: neverthrow-wrap-exceptions
description: Capture exceptions and promise failures with `neverthrow` instead of hand-written `try/catch` in TypeScript and JavaScript code. Use when wrapping synchronous functions that may throw, promise-returning functions that may throw before returning, existing `PromiseLike` values that may reject, or third-party APIs such as parsers, database clients, HTTP clients, file-system helpers, serializers, and SDK calls. Prefer `Result.fromThrowable` for synchronous throwers, `ResultAsync.fromThrowable` for promise-returning functions that may throw or reject, and `ResultAsync.fromPromise` when you already have a `PromiseLike` value in hand. Only keep `try/catch` when the language construct, cleanup requirement, or framework boundary truly requires it.
---

# Neverthrow Exception Wrapping

## Goal

Capture recoverable exceptions with `neverthrow` helpers instead of ad hoc `try/catch`.

This skill governs exception capture only. If the task also changes public return signatures, use `neverthrow-return-types` alongside this skill.

## Detect Exception Sources

1. Identify where failures currently enter the code.
   - Look for hand-written `try/catch`, `.catch(...)` wrappers used only for conversion, direct calls to known throwing APIs, and promise-returning functions that may reject.
   - Check third-party libraries, parsers, database clients, network clients, file-system helpers, schema validators, and serialization code.

2. Distinguish the failure shape before choosing a wrapper.
   - Use the synchronous path when the operation may throw before returning a value.
   - Use the promise-function path when the operation returns a promise but may still throw before that promise exists.
   - Use the promise-instance path when you already have a `PromiseLike` value in hand.

3. Do not wrap APIs that already return `Result` or `ResultAsync`.
   - Compose them directly with `map`, `mapErr`, `andThen`, `asyncAndThen`, or `orElse`.

## Choose the Wrapper

1. Use `Result.fromThrowable` or `fromThrowable` for synchronous throwing functions.
   - Always pass an error mapper so the `Err` side has a known type.

2. Use `ResultAsync.fromThrowable` for promise-returning functions that can throw before returning or fail during async execution.
   - Prefer this over `ResultAsync.fromPromise(fn(...), ...)` when the function call itself might throw.

3. Use `ResultAsync.fromPromise` or `fromPromise` when you already have a `PromiseLike` value.
   - Map rejected values into a concrete error type immediately.

4. Reuse narrow mapper functions when the same error shape appears repeatedly.
   - Prefer stable domain errors over `unknown`, `any`, and generic strings.

## Avoid try/catch by Default

1. Do not add new hand-written `try/catch` blocks when a `neverthrow` helper fits the job.
   - Extract the risky operation into a function if needed and wrap that function.

2. Keep `try/catch` only when the surrounding construct truly requires it.
   - Examples include cleanup flows that need `finally`, framework boundaries that must intercept and translate exceptions, or language constructs that cannot be expressed cleanly with wrapper helpers alone.

3. If `try/catch` remains necessary, keep it at the narrowest boundary.
   - Convert the caught value into `Err` or the required framework-native response immediately.
   - Do not let the caught value flow through the codebase as untyped `unknown`.

## Implementation Rules

1. Wrap once near the source of the throwable or rejecting operation.
   - Avoid nested wrappers around the same operation.

2. Keep error mapping explicit.
   - Prefer mapper functions that preserve useful context such as operation name, input identifiers, or upstream status codes when the local style allows it.

3. Replace conversion-only `.catch(...)` chains when `neverthrow` provides a clearer wrapper.
   - Do not simulate `ResultAsync` manually with `Promise.resolve`, `Promise.reject`, or custom wrapper objects.

## Example Patterns

```ts
const parseConfig = Result.fromThrowable(
  JSON.parse,
  (error) => ({ type: 'ConfigParseError', cause: error }),
)

const fetchUser = ResultAsync.fromThrowable(
  apiClient.getUser,
  (error) => ({ type: 'UserFetchError', cause: error }),
)

function readBody(): ResultAsync<RequestBody, BodyReadError> {
  return ResultAsync.fromPromise(request.json(), toBodyReadError)
}
```

## Validate Before Finishing

1. Verify new or edited failure capture uses `neverthrow` helpers where applicable.
2. Verify each wrapper choice matches the real failure shape: synchronous throw, promise-returning function, or existing promise.
3. Verify all error mappers produce explicit error types.
4. Verify any remaining `try/catch` block is documented by a real constraint instead of habit.
5. Run the normal local validation for the stack when it is safe and in scope, such as tests, linting, or type checks.

## Report the Outcome

When finishing the task:

- State which throwing or rejecting operations were wrapped.
- State which `neverthrow` helper was used and why.
- State any remaining `try/catch` blocks and why they were unavoidable.
- State how caught or rejected values are mapped into explicit error types.
