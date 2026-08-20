/**
 * Adapter-local OpenCode client facade.
 *
 * This module defines the narrow `OpenCodeClientFacade` interface that the
 * adapter uses to interact with a running OpenCode instance. All SDK-backed
 * agent list/create/update operations flow through this interface so that the
 * exact SDK method names and shapes remain adapter-local and can evolve
 * without changing engine-facing contracts.
 *
 * Boundary rule: this module imports SDK types only through `./sdk-types`.
 * It must not import directly from `@opencode-ai/sdk`.
 */

import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";

import type {
  OpenCodeAgent,
  OpenCodeAgentConfig,
  OpencodeClient,
} from "./sdk-types.js";

// ---------------------------------------------------------------------------
// Durable identity and projection limits
// ---------------------------------------------------------------------------

/** The OpenCode `options` key that stores Weave's durable resource identity. */
export const WEAVE_AGENT_IDENTITY_KEY = "weave";

/** The versioned identity kind stored in an OpenCode agent's options. */
export const WEAVE_AGENT_IDENTITY_KIND = "weave-agent";

/** Maximum number of agents accepted from one SDK list response. */
export const MAX_OPEN_CODE_AGENT_SUMMARIES = 512;

/** Maximum length of a projected OpenCode agent name. */
export const MAX_OPEN_CODE_AGENT_NAME_LENGTH = 128;

/** Maximum length of a projected OpenCode agent description. */
export const MAX_OPEN_CODE_AGENT_DESCRIPTION_LENGTH = 4_096;

/** Maximum number of own properties accepted on one SDK resource. */
const MAX_AGENT_RESOURCE_PROPERTIES = 64;

/** Maximum number of own properties accepted in an agent options object. */
const MAX_AGENT_OPTIONS_PROPERTIES = 32;

/** Maximum number of own properties accepted in the Weave identity object. */
const MAX_AGENT_IDENTITY_PROPERTIES = 3;

/**
 * Versioned, adapter-controlled identity persisted in OpenCode's agent
 * `options` object.
 *
 * The description tag remains human-readable presentation metadata. This
 * identity is the authority used for update authorization.
 */
export interface OpenCodeAgentIdentity {
  readonly kind: typeof WEAVE_AGENT_IDENTITY_KIND;
  readonly version: 1;
  readonly agentName: string;
}

/** Creates the durable identity written into a materialized OpenCode agent. */
export function createWeaveAgentIdentity(
  agentName: string,
): OpenCodeAgentIdentity {
  return {
    kind: WEAVE_AGENT_IDENTITY_KIND,
    version: 1,
    agentName,
  };
}

// ---------------------------------------------------------------------------
// Strict SDK-resource projection
// ---------------------------------------------------------------------------

type ProjectionErrorReason =
  | "not-an-object"
  | "array-not-allowed"
  | "not-an-array"
  | "invalid-prototype"
  | "property-introspection-failed"
  | "accessor-property"
  | "symbol-property"
  | "property-disappeared"
  | "too-many-properties"
  | "invalid-array-length"
  | "sparse-array"
  | "missing-name"
  | "invalid-name"
  | "oversize-name"
  | "invalid-description"
  | "oversize-description"
  | "invalid-options"
  | "invalid-identity";

/** Typed failure returned by the strict SDK-resource projection seam. */
export interface OpenCodeAgentProjectionError {
  readonly type: "InvalidAgentResource";
  readonly reason: ProjectionErrorReason;
}

/** A concrete recursive record shape for raw external JSON-like values. */
type OpenCodeExternalRecord = {
  readonly [key: string]: OpenCodeExternalValue;
};

/** Raw values admitted at the OpenCode SDK boundary before projection. */
export type OpenCodeExternalValue =
  | OpenCodeExternalRecord
  | OpenCodeAgent
  | readonly OpenCodeExternalValue[]
  | string
  | number
  | boolean
  | null
  | undefined;

type OpenCodeExternalObject = OpenCodeExternalRecord | OpenCodeAgent;

type DataProperty =
  | { readonly present: false }
  | { readonly present: true; readonly value: OpenCodeExternalValue };

type ProjectedAgentSummary = {
  name: string;
  description?: string;
  weaveIdentity?: OpenCodeAgentIdentity;
};

type SafeDataRecord = {
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>;
};

function projectionError(
  reason: ProjectionErrorReason,
): OpenCodeAgentProjectionError {
  return { type: "InvalidAgentResource", reason };
}

function isExternalObject(
  value: OpenCodeExternalValue,
): value is OpenCodeExternalObject {
  return value !== null && Object(value) === value;
}

function inspectSafeDataRecord(
  value: OpenCodeExternalObject,
  maxProperties: number,
  allowArray: boolean,
): Result<SafeDataRecord, OpenCodeAgentProjectionError> {
  const arrayResult = Result.fromThrowable(
    () => Array.isArray(value),
    () => projectionError("property-introspection-failed"),
  )();
  if (arrayResult.isErr()) return err(arrayResult.error);
  const isArray = arrayResult.value;
  if (!allowArray && isArray) {
    return err(projectionError("array-not-allowed"));
  }

  const prototypeResult = Result.fromThrowable(
    () => Object.getPrototypeOf(value),
    () => projectionError("property-introspection-failed"),
  )();

  return prototypeResult.andThen((prototype) => {
    const validPrototype = allowArray
      ? (prototype === Array.prototype || prototype === null) && isArray
      : (prototype === Object.prototype || prototype === null) && !isArray;

    if (!validPrototype) return err(projectionError("invalid-prototype"));

    const namesResult = Result.fromThrowable(
      () => Object.getOwnPropertyNames(value),
      () => projectionError("property-introspection-failed"),
    )();
    const symbolsResult = Result.fromThrowable(
      () => Object.getOwnPropertySymbols(value),
      () => projectionError("property-introspection-failed"),
    )();

    return namesResult.andThen((names) =>
      symbolsResult.andThen((symbols) => {
        if (symbols.length > 0) return err(projectionError("symbol-property"));
        if (names.length > maxProperties) {
          return err(projectionError("too-many-properties"));
        }

        const descriptors = new Map<string, PropertyDescriptor>();
        for (const name of names) {
          const descriptorResult = Result.fromThrowable(
            () => Object.getOwnPropertyDescriptor(value, name),
            () => projectionError("property-introspection-failed"),
          )();
          if (descriptorResult.isErr()) return err(descriptorResult.error);

          const descriptor = descriptorResult.value;
          if (descriptor === undefined) {
            return err(projectionError("property-disappeared"));
          }
          if (!("value" in descriptor)) {
            return err(projectionError("accessor-property"));
          }
          descriptors.set(name, descriptor);
        }

        return ok({ descriptors });
      }),
    );
  });
}

function readDataProperty(record: SafeDataRecord, key: string): DataProperty {
  const descriptor = record.descriptors.get(key);
  if (descriptor === undefined) return { present: false };
  return { present: true, value: descriptor.value };
}

function parseBoundedName(
  value: OpenCodeExternalValue,
  missingReason: "missing-name" | "invalid-identity",
): Result<string, OpenCodeAgentProjectionError> {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || parsed.data.length === 0) {
    return err(
      projectionError(
        missingReason === "missing-name" ? "missing-name" : "invalid-identity",
      ),
    );
  }
  if (parsed.data.length > MAX_OPEN_CODE_AGENT_NAME_LENGTH) {
    return err(
      projectionError(
        missingReason === "missing-name" ? "oversize-name" : "invalid-identity",
      ),
    );
  }
  return ok(parsed.data);
}

function parseDescription(
  property: DataProperty,
): Result<string | null, OpenCodeAgentProjectionError> {
  if (!property.present || property.value === undefined) return ok(null);
  const parsed = z.string().safeParse(property.value);
  if (!parsed.success) return err(projectionError("invalid-description"));
  if (parsed.data.length > MAX_OPEN_CODE_AGENT_DESCRIPTION_LENGTH) {
    return err(projectionError("oversize-description"));
  }
  return ok(parsed.data);
}

function parseIdentity(
  property: DataProperty,
  resourceName: string,
): Result<OpenCodeAgentIdentity | null, OpenCodeAgentProjectionError> {
  if (!property.present || property.value === undefined) return ok(null);
  if (!isExternalObject(property.value)) {
    return err(projectionError("invalid-identity"));
  }

  const identityRecordResult = inspectSafeDataRecord(
    property.value,
    MAX_AGENT_IDENTITY_PROPERTIES,
    false,
  );
  if (identityRecordResult.isErr()) {
    return err(projectionError("invalid-identity"));
  }

  const identityRecord = identityRecordResult.value;
  if (identityRecord.descriptors.size !== MAX_AGENT_IDENTITY_PROPERTIES) {
    return err(projectionError("invalid-identity"));
  }

  const kind = readDataProperty(identityRecord, "kind");
  const version = readDataProperty(identityRecord, "version");
  const agentName = readDataProperty(identityRecord, "agentName");
  if (!kind.present || !version.present || !agentName.present) {
    return err(projectionError("invalid-identity"));
  }

  const validKind = z.literal(WEAVE_AGENT_IDENTITY_KIND).safeParse(kind.value);
  const validVersion = z.literal(1).safeParse(version.value);
  if (!validKind.success || !validVersion.success) {
    return err(projectionError("invalid-identity"));
  }

  const nameResult = parseBoundedName(agentName.value, "invalid-identity");
  if (nameResult.isErr() || nameResult.value !== resourceName) {
    return err(projectionError("invalid-identity"));
  }

  return ok({
    kind: WEAVE_AGENT_IDENTITY_KIND,
    version: 1,
    agentName: nameResult.value,
  });
}

/**
 * Projects one raw SDK agent resource into the adapter-owned summary.
 *
 * The parser never retains the SDK object. It reads own data descriptors only,
 * rejects accessors and custom prototypes, applies bounded string/property
 * limits, and constructs a fresh summary containing only controller-owned
 * data.
 */
export function projectOpenCodeAgentSummary(
  resource: OpenCodeExternalValue,
): Result<OpenCodeAgentSummary, OpenCodeAgentProjectionError> {
  if (!isExternalObject(resource)) {
    return err(projectionError("not-an-object"));
  }

  const recordResult = inspectSafeDataRecord(
    resource,
    MAX_AGENT_RESOURCE_PROPERTIES,
    false,
  );
  if (recordResult.isErr()) return err(recordResult.error);

  const record = recordResult.value;
  const nameProperty = readDataProperty(record, "name");
  if (!nameProperty.present) return err(projectionError("missing-name"));

  const nameResult = parseBoundedName(nameProperty.value, "missing-name");
  if (nameResult.isErr()) return err(nameResult.error);

  const descriptionResult = parseDescription(
    readDataProperty(record, "description"),
  );
  if (descriptionResult.isErr()) return err(descriptionResult.error);

  const optionsProperty = readDataProperty(record, "options");
  let identityProperty: DataProperty = { present: false };
  if (optionsProperty.present && optionsProperty.value !== undefined) {
    const optionsValue = optionsProperty.value;
    if (!isExternalObject(optionsValue)) {
      return err(projectionError("invalid-options"));
    }

    const optionsRecordResult = inspectSafeDataRecord(
      optionsValue,
      MAX_AGENT_OPTIONS_PROPERTIES,
      false,
    );
    if (optionsRecordResult.isErr()) {
      return err(projectionError("invalid-options"));
    }
    identityProperty = readDataProperty(
      optionsRecordResult.value,
      WEAVE_AGENT_IDENTITY_KEY,
    );
  }

  const identityResult = parseIdentity(identityProperty, nameResult.value);
  if (identityResult.isErr()) return err(identityResult.error);

  const summary: ProjectedAgentSummary = { name: nameResult.value };
  if (descriptionResult.value !== null) {
    summary.description = descriptionResult.value;
  }
  if (identityResult.value !== null) {
    summary.weaveIdentity = identityResult.value;
  }
  return ok(summary);
}

/** Projects and bounds one raw SDK agent-list response. */
export function projectOpenCodeAgentSummaries(
  resources: OpenCodeExternalValue,
): Result<OpenCodeAgentSummary[], OpenCodeAgentProjectionError> {
  if (!isExternalObject(resources)) {
    return err(projectionError("not-an-array"));
  }
  const arrayCheck = Result.fromThrowable(
    () => Array.isArray(resources),
    () => projectionError("property-introspection-failed"),
  )();
  if (arrayCheck.isErr()) return err(arrayCheck.error);
  if (!arrayCheck.value) return err(projectionError("not-an-array"));

  const arrayRecordResult = inspectSafeDataRecord(
    resources,
    MAX_OPEN_CODE_AGENT_SUMMARIES + 1,
    true,
  );
  if (arrayRecordResult.isErr()) return err(arrayRecordResult.error);

  const lengthProperty = readDataProperty(arrayRecordResult.value, "length");
  if (!lengthProperty.present) {
    return err(projectionError("invalid-array-length"));
  }
  const lengthResult = z.number().safeParse(lengthProperty.value);
  if (
    !lengthResult.success ||
    !Number.isSafeInteger(lengthResult.data) ||
    lengthResult.data < 0
  ) {
    return err(projectionError("invalid-array-length"));
  }
  if (lengthResult.data > MAX_OPEN_CODE_AGENT_SUMMARIES) {
    return err(projectionError("too-many-properties"));
  }

  const summaries: OpenCodeAgentSummary[] = [];
  for (let index = 0; index < lengthResult.data; index += 1) {
    const element = readDataProperty(arrayRecordResult.value, String(index));
    if (!element.present) return err(projectionError("sparse-array"));

    const summaryResult = projectOpenCodeAgentSummary(element.value);
    if (summaryResult.isErr()) return err(summaryResult.error);
    summaries.push(summaryResult.value);
  }
  return ok(summaries);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Operation names exposed by the adapter-owned SDK boundary. */
export type OpenCodeClientOperation =
  | "list-agents"
  | "create-agent"
  | "update-agent";

/** Bounded status values exposed by the adapter-owned SDK boundary. */
export type OpenCodeClientStatus =
  | "request-failed"
  | "sdk-error"
  | "invalid-response";

/** Returns a fixed, controller-owned diagnostic for an SDK operation. */
export function openCodeClientDiagnosticMessage(
  operation: OpenCodeClientOperation,
  status: OpenCodeClientStatus,
): string {
  return `OpenCode ${operation} failed (${status})`;
}

/**
 * Discriminated union of errors that `OpenCodeClientFacade` methods can
 * return. It contains no SDK payload or exception cause.
 */
export type OpenCodeClientError =
  | {
      type: "ListAgentsError";
      operation: "list-agents";
      status: OpenCodeClientStatus;
      message: string;
    }
  | {
      type: "CreateAgentError";
      operation: "create-agent";
      status: OpenCodeClientStatus;
      agentName: string;
      message: string;
    }
  | {
      type: "UpdateAgentError";
      operation: "update-agent";
      status: OpenCodeClientStatus;
      agentName: string;
      message: string;
    };

function listAgentsError(status: OpenCodeClientStatus): OpenCodeClientError {
  return {
    type: "ListAgentsError",
    operation: "list-agents",
    status,
    message: openCodeClientDiagnosticMessage("list-agents", status),
  };
}

function createAgentError(
  agentName: string,
  status: OpenCodeClientStatus,
): OpenCodeClientError {
  return {
    type: "CreateAgentError",
    operation: "create-agent",
    status,
    agentName,
    message: openCodeClientDiagnosticMessage("create-agent", status),
  };
}

function updateAgentError(
  agentName: string,
  status: OpenCodeClientStatus,
): OpenCodeClientError {
  return {
    type: "UpdateAgentError",
    operation: "update-agent",
    status,
    agentName,
    message: openCodeClientDiagnosticMessage("update-agent", status),
  };
}

class OpenCodeClientFailure extends Error {
  readonly status: OpenCodeClientStatus;

  constructor(status: OpenCodeClientStatus) {
    super(status);
    this.name = "OpenCodeClientFailure";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Facade interface
// ---------------------------------------------------------------------------

/**
 * The agent identity fields used by adapter-owned reconciliation.
 *
 * OpenCode returns a larger SDK resource, but reconciliation only needs the
 * canonical name, bounded display description, and parsed durable identity.
 */
export interface OpenCodeAgentSummary {
  readonly name: string;
  readonly description?: string;
  readonly weaveIdentity?: OpenCodeAgentIdentity;
}

/**
 * Narrow adapter-local interface for OpenCode agent operations.
 *
 * Implementations wrap the `OpencodeClient` SDK calls needed for agent
 * materialization. Tests provide a mock implementation without a live
 * OpenCode runtime.
 */
export interface OpenCodeClientFacade {
  /** Returns the current list of agent summaries. */
  listAgents(): ResultAsync<OpenCodeAgentSummary[], OpenCodeClientError>;

  /** Creates an agent by patching OpenCode's config agent map. */
  createAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError>;

  /** Updates a managed agent by patching OpenCode's config agent map. */
  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError>;
}

// ---------------------------------------------------------------------------
// SDK-backed implementation
// ---------------------------------------------------------------------------

/** SDK-backed implementation of `OpenCodeClientFacade`. */
export class SdkOpenCodeClient implements OpenCodeClientFacade {
  constructor(private readonly client: OpencodeClient) {}

  listAgents(): ResultAsync<OpenCodeAgentSummary[], OpenCodeClientError> {
    return ResultAsync.fromThrowable(
      async () => {
        const response = await this.client.app.agents();
        if (response.error !== undefined) {
          throw new OpenCodeClientFailure("sdk-error");
        }

        const projection = projectOpenCodeAgentSummaries(response.data);
        if (projection.isErr()) {
          throw new OpenCodeClientFailure("invalid-response");
        }
        return projection.value;
      },
      (cause) =>
        cause instanceof OpenCodeClientFailure
          ? listAgentsError(cause.status)
          : listAgentsError("request-failed"),
    )();
  }

  createAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return ResultAsync.fromThrowable(
      async () => {
        const response = await this.client.config.update({
          body: { agent: { [name]: config } },
        });
        if (response.error !== undefined) {
          throw new OpenCodeClientFailure("sdk-error");
        }
      },
      (cause) =>
        cause instanceof OpenCodeClientFailure
          ? createAgentError(name, cause.status)
          : createAgentError(name, "request-failed"),
    )();
  }

  updateAgent(
    name: string,
    config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return ResultAsync.fromThrowable(
      async () => {
        const response = await this.client.config.update({
          body: { agent: { [name]: config } },
        });
        if (response.error !== undefined) {
          throw new OpenCodeClientFailure("sdk-error");
        }
      },
      (cause) =>
        cause instanceof OpenCodeClientFailure
          ? updateAgentError(name, cause.status)
          : updateAgentError(name, "request-failed"),
    )();
  }
}
