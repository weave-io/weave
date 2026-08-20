import { err, ok, type Result } from "neverthrow";
import {
  CHILD_TASK,
  CHILD_TOOL_CALL_ID,
  FALLBACK_SUCCESS,
  FIXTURE_CREDENTIAL,
  FOLLOW_UP_USER,
  FOLLOW_UP_USER_ID,
  failure,
  MAX_CAPTURE_BYTES,
  MAX_CONTEXT_DESCRIPTOR_COUNT,
  NATIVE_RECOVERY_MARKER_TYPE,
  ORIGINAL_TASK_ID,
  ORIGINAL_USER,
  ORIGINAL_USER_ID,
  PARENT_TASK,
  PARENT_TOOL_CALL_ID,
  QUEUED_USER,
  QUEUED_USER_ID,
  RECOVERY_MARKER,
  ROLLBACK_DISABLED_SURFACE,
  ROLLBACK_REQUIRED_DELEGATION_SURFACES,
  ROLLBACK_SHIM_BOUNDARY,
  ROLLBACK_SHIM_FILENAME,
  ROLLBACK_TASK,
  type SmokeFailure,
  STEERING_USER,
  STEERING_USER_ID,
  UNRELATED_CUSTOM_TYPE,
} from "./contract.js";

function fixtureDescriptorSource(): string {
  const encoded = (value: string): string => JSON.stringify(value);
  return `
const MAX_DESCRIPTOR_COUNT = ${MAX_CONTEXT_DESCRIPTOR_COUNT};
const RECOVERY_MARKER = ${encoded(RECOVERY_MARKER)};
const NATIVE_RECOVERY_MARKER_TYPE = ${encoded(NATIVE_RECOVERY_MARKER_TYPE)};
const PARENT_TASK = ${encoded(PARENT_TASK)};
const ROLLBACK_TASK = ${encoded(ROLLBACK_TASK)};
const CHILD_TASK = ${encoded(CHILD_TASK)};
const ORIGINAL_USER = ${encoded(ORIGINAL_USER)};
const STEERING_USER = ${encoded(STEERING_USER)};
const FOLLOW_UP_USER = ${encoded(FOLLOW_UP_USER)};
const QUEUED_USER = ${encoded(QUEUED_USER)};
const FALLBACK_SUCCESS = ${encoded(FALLBACK_SUCCESS)};
const UNRELATED_CUSTOM_TYPE = ${encoded(UNRELATED_CUSTOM_TYPE)};
const ORIGINAL_TASK_ID = ${encoded(ORIGINAL_TASK_ID)};
const ORIGINAL_USER_ID = ${encoded(ORIGINAL_USER_ID)};
const STEERING_USER_ID = ${encoded(STEERING_USER_ID)};
const FOLLOW_UP_USER_ID = ${encoded(FOLLOW_UP_USER_ID)};
const QUEUED_USER_ID = ${encoded(QUEUED_USER_ID)};
const PARENT_TOOL_CALL_ID = ${encoded(PARENT_TOOL_CALL_ID)};
const CHILD_TOOL_CALL_ID = ${encoded(CHILD_TOOL_CALL_ID)};
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const descriptorDigest = (namespace, value) => digest(namespace + ":" + value);
const descriptorCorrelation = (fact) => descriptorDigest("fixture-correlation", fact);
const markerTokenDigest = (token) => descriptorDigest("marker-token", token);
const descriptorRoleDigest = (role) => descriptorDigest("fixture-role", role);
const descriptorCustomTypeDigest = (customType) => descriptorDigest("fixture-custom-type", customType);
const serializedDescriptorValue = (value) => {
  try { return JSON.stringify(value); } catch { return ""; }
};
const boundedText = (value) => value.length > 4096 ? value.slice(0, 4096) : value;
const textOf = (value) => {
  const values = Array.isArray(value) ? value : [value];
  let text = "";
  for (const item of values.slice(0, 64)) {
    if (typeof item === "string") text += item;
    else if (item && typeof item === "object" && typeof item.text === "string") text += item.text;
  }
  return boundedText(text);
};
const shapeOf = (value, depth = 0) => {
  if (depth > 5) return "depth";
  if (value === null) return "null";
  if (Array.isArray(value)) return {
    kind: "array",
    length: Math.min(value.length, 256),
    items: value.slice(0, 16).map((item) => shapeOf(item, depth + 1))
  };
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value).sort().slice(0, 64);
  return {
    kind: "object",
    keys: keys.map((key) => [key, shapeOf(value[key], depth + 1)])
  };
};
const classifyDescriptor = (entry, role, toolCallCount) => {
  const contentText = textOf(entry?.content);
  const contentBlocks = Array.isArray(entry?.content) ? entry.content : [entry?.content];
  const fixtureToolCall = contentBlocks.some((block) =>
    block && typeof block === "object" &&
    block.type === "toolCall" &&
    (block.id === PARENT_TOOL_CALL_ID || block.id === CHILD_TOOL_CALL_ID)
  );
  if (role === "user") {
    // Pi converts custom_message entries into provider-level user messages.
    // The fixture-issued marker in the content keeps that real entry
    // distinguishable from a synthetic user message after conversion.
    if (contentText.includes(UNRELATED_CUSTOM_TYPE)) return "unrelated-custom";
    if (contentText.includes(PARENT_TASK) || contentText.includes(ROLLBACK_TASK) || contentText.includes(CHILD_TASK) || entry?.id === ORIGINAL_TASK_ID) return "original-task-user";
    if (contentText.includes(ORIGINAL_USER) || entry?.id === ORIGINAL_USER_ID) return "original-user";
    if (contentText.includes(STEERING_USER) || entry?.id === STEERING_USER_ID) return "steering-user";
    if (contentText.includes(FOLLOW_UP_USER) || entry?.id === FOLLOW_UP_USER_ID) return "follow-up-user";
    if (contentText.includes(QUEUED_USER) || entry?.id === QUEUED_USER_ID) return "queued-user";
    return undefined;
  }
  if (role === "assistant") {
    if (entry?.stopReason === "error") return "failed-assistant";
    if (toolCallCount > 0 && fixtureToolCall) return "tool-call";
    if (contentText.includes(FALLBACK_SUCCESS)) return "successful-assistant";
    return undefined;
  }
  if (
    role === "toolResult" &&
    (entry?.toolCallId === PARENT_TOOL_CALL_ID ||
      entry?.toolCallId === CHILD_TOOL_CALL_ID)
  ) return "tool-result";
  if (role === "custom" && entry?.customType === UNRELATED_CUSTOM_TYPE) return "unrelated-custom";
  return undefined;
};
const describeEntry = (entry, ordinal, entryType = "message") => {
  const role = entry && typeof entry.role === "string"
    ? entry.role
    : entryType === "message" ? "unknown" : "custom";
  const content = entry?.content;
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
  const toolCallCount = blocks.filter((block) => block && typeof block === "object" && block.type === "toolCall").length;
  const toolResultCount = role === "toolResult" ? 1 : 0;
  const customType = typeof entry?.customType === "string" ? entry.customType : undefined;
  const markerToken = (customType === NATIVE_RECOVERY_MARKER_TYPE || customType === RECOVERY_MARKER) && entry?.details && typeof entry.details.token === "string"
    ? entry.details.token
    : undefined;
  const fact = classifyDescriptor(entry, role, toolCallCount);
  const correlationHash = markerToken === undefined
    ? (fact === undefined ? undefined : descriptorCorrelation(fact))
    : markerTokenDigest(markerToken);
  return {
    ordinal,
    roleHash: descriptorRoleDigest(role),
    ...(customType === undefined ? {} : { customTypeHash: descriptorCustomTypeDigest(customType) }),
    contentShapeHash: descriptorDigest("fixture-shape", serializedDescriptorValue({
      content: shapeOf(typeof content === "string" ? [{ type: "text", text: content }] : content),
      stopReason: entry?.stopReason,
      toolCallCount,
      toolResultCount
    })),
    contentFingerprintHash: descriptorDigest("fixture-fingerprint", boundedText(serializedDescriptorValue(entry))),
    contentBlockCount: Math.min(blocks.length, 256),
    toolCallCount: Math.min(toolCallCount, 256),
    toolResultCount,
    ...(correlationHash === undefined ? {} : { correlationHash })
  };
};
const descriptorCounts = (descriptors) => ({
  descriptorCount: descriptors.length,
  userCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("user")).length,
  assistantCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("assistant")).length,
  toolResultCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("toolResult")).length,
  customCount: descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("custom")).length
});
const descriptorFacts = (descriptors) => {
  const knownUsers = new Set(["original-task-user", "original-user", "steering-user", "follow-up-user", "unrelated-custom", "queued-user"].map(descriptorCorrelation));
  const userDescriptors = descriptors.filter((descriptor) => descriptor.roleHash === descriptorRoleDigest("user"));
  const facts = descriptorCounts(descriptors);
  return {
    ...facts,
    originalUserPresent: facts.userCount > 0,
    taskPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("original-task-user")),
    toolCallPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("tool-call")),
    toolResultPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("tool-result")),
    failedAssistantPresent: descriptors.some((descriptor) => descriptor.correlationHash === descriptorCorrelation("failed-assistant")),
    recoveryMarkerPresent: descriptors.some((descriptor) => descriptor.customTypeHash === descriptorCustomTypeDigest(NATIVE_RECOVERY_MARKER_TYPE)),
    syntheticProviderUserMessagePresent: userDescriptors.some((descriptor) => descriptor.correlationHash === undefined || !knownUsers.has(descriptor.correlationHash))
  };
};
`;
}

export function fixtureSource(): string {
  return `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const childId = Bun.env.WEAVE_CHILD_ID;
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const fileName = role === "child"
  ? "provider-child-" + (childId ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_") + ".json"
  : "provider-parent.json";
const capturePath = captureDir.length === 0 ? "" : captureDir + "/" + fileName;
const fixturePidPath = captureDir.length === 0 ? "" : captureDir + "/fixture-" + role + ".pid";
if (fixturePidPath.length > 0) await Bun.write(fixturePidPath, String(process.pid) + "\\n");
let requestCount = 0;
const requests = [];
let pendingPersist = Promise.resolve();
const digest = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const serialized = (value) => { try { return JSON.stringify(value); } catch { return ""; } };
${fixtureDescriptorSource()}
const messagesFacts = (messages, model) => {
  const list = Array.isArray(messages) ? messages : [];
  const body = serialized(list);
  const descriptors = list.slice(0, MAX_DESCRIPTOR_COUNT).map((entry, index) => describeEntry(entry, index));
  const facts = descriptorFacts(descriptors);
  return {
    requestNumber: requestCount,
    provider: String(model?.provider ?? ""),
    model: String(model?.id ?? ""),
    messageCount: Math.min(list.length, 256),
    contextHash: digest(body),
    descriptors,
    ...facts
  };
};
const persist = () => {
  if (capturePath.length === 0) return pendingPersist;
  const snapshot = {
    schemaVersion: 1,
    kind: "provider",
    role,
    requestCount,
    requests: requests.slice(-8)
  };
  const body = JSON.stringify(snapshot);
  if (body.length <= ${MAX_CAPTURE_BYTES}) {
    pendingPersist = pendingPersist.then(() => Bun.write(capturePath, body + "\\n").then(() => undefined));
  }
  return pendingPersist;
};
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (model, content, stopReason, errorMessage) => ({
  role: "assistant", content, api: "openai-completions", provider: model.provider, model: model.id,
  usage: usage(), stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now()
});
const streamFor = (model, facts) => {
  const stream = createAssistantMessageEventStream();
  const pending = assistant(model, [], "pending");
  stream.push({ type: "start", partial: pending });
  if (facts.kind === "tool") {
    const toolCall = { type: "toolCall", id: facts.id, name: facts.name, arguments: facts.arguments };
    const partial = assistant(model, [toolCall], "pending");
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    stream.push({ type: "done", reason: "toolUse", message: assistant(model, [toolCall], "toolUse") });
    return stream;
  }
  if (facts.kind === "error") {
    const failed = assistant(model, [], "error", "provider unavailable");
    failed.status = 503;
    stream.push({ type: "error", reason: "error", error: failed });
    return stream;
  }
  const content = [{ type: "text", text: facts.text }];
  const partial = assistant(model, content, "pending");
  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: facts.text, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: facts.text, partial });
  stream.push({ type: "done", reason: "stop", message: assistant(model, content, "stop") });
  return stream;
};
const providerRequest = (model, requestContext) => {
  requestCount += 1;
  const contextMessages = Array.isArray(requestContext?.messages) ? requestContext.messages : [];
  const rollbackTaskPresent = contextMessages.some((entry) => textOf(entry?.content).includes(ROLLBACK_TASK));
  requests.push(messagesFacts(contextMessages, model));
  void persist();
  if (role === "parent" && requestCount === 1) {
    if (rollbackTaskPresent) return streamFor(model, { kind: "error" });
    return streamFor(model, { kind: "tool", id: "smoke-parent-tool-call", name: "weave_delegate", arguments: { agent: "shuttle", task: CHILD_TASK } });
  }
  if (role === "child" && requestCount === 1) {
    return streamFor(model, { kind: "tool", id: "smoke-child-tool-call", name: "read", arguments: { path: "README.md" } });
  }
  if (role === "child" && requestCount === 2) {
    return streamFor(model, { kind: "error" });
  }
  return streamFor(model, { kind: "text", text: role === "child" ? FALLBACK_SUCCESS : "PI_MODEL_FAILOVER_SMOKE_PARENT_SUCCESS" });
};

export default function smokeFixture(pi) {
  pi.registerProvider("smoke", {
    name: "Pi model-fallback smoke fixture",
    api: "openai-completions",
    baseUrl: "https://pi-model-fallback.invalid",
    apiKey: ${JSON.stringify(FIXTURE_CREDENTIAL)},
    models: [
      { id: "first", name: "Smoke first", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 },
      { id: "second", name: "Smoke second", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }
    ],
    streamSimple: providerRequest
  });
}
`;
}

/**
 * This extension is a read-only control observer. It does not return replacement
 * context, call a Pi control method, or write native history. The smoke process
 * reads this bounded event capture only as evidence of events emitted by Pi.
 */
export function controlObserverSource(): string {
  return `
const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const childId = Bun.env.WEAVE_CHILD_ID;
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const capturePath = captureDir.length === 0
  ? ""
  : captureDir + "/control-" + (role === "child" ? "child-" + (Bun.env.WEAVE_CHILD_ID ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_") : "parent") + ".json";
const piPidPath = captureDir.length === 0 ? "" : captureDir + "/pi-" + role + ".pid";
if (piPidPath.length > 0) await Bun.write(piPidPath, String(process.pid) + "\\n");
const digest = (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
${fixtureDescriptorSource()}
let beforeAgentStartCount = 0;
let messageStartCount = 0;
let messageEndCount = 0;
let contextCount = 0;
let contextRepairCount = 0;
let modelSelectCount = 0;
let settlementCount = 0;
let recoveryMarkerCount = 0;
let recoveryMarkerObserved = false;
let markerMessageStartSeen = false;
let processIdBeforeHash;
let processIdAfterHash;
let childIdBeforeHash;
let childIdAfterHash;
let appliedIdentity;
let modelSelectTimesMs = [];
let contextRepairTimesMs = [];
let markerMessageStartTimesMs = [];
let settlementTimesMs = [];
let parentToolCallId;
let parentToolEndCallId;
let parentToolStartedAtMs;
let parentToolEndedAtMs;
let parentToolPendingMs;
let parentToolStartCount = 0;
let parentToolEndCount = 0;
let parentToolStartTimesMs = [];
let parentToolEndTimesMs = [];
let pendingMessageHelperPresent;
let adapterPackageVersion;
let adapterExtensionSha256;
let adapterPackageSourceProven = false;
let adapterPackageRootMatched = false;
let adapterExtensionHashMatched = false;
let markerTokenHash;
let failedAssistantFingerprintHash;
let failedAssistantShapeHash;
let pendingPersist = Promise.resolve();
let piApi;
const now = () => Date.now();
const inspectAdapterProvenance = async () => {
  try {
    const expectedRoot = Bun.env.PI_MODEL_SMOKE_EXPECTED_PACKAGE_ROOT ?? "";
    const expectedHash = Bun.env.PI_MODEL_SMOKE_EXPECTED_EXTENSION_SHA256 ?? "";
    const expectedVersion = Bun.env.PI_MODEL_SMOKE_EXPECTED_PACKAGE_VERSION ?? "";
    const commands = typeof piApi?.getCommands === "function" ? piApi.getCommands() : [];
    const command = Array.isArray(commands)
      ? commands.find((entry) => entry?.name === "weave:health")
      : undefined;
    const info = command?.sourceInfo;
    if (
      !info ||
      typeof info.path !== "string" ||
      !info.path.startsWith("/") ||
      typeof info.source !== "string" ||
      typeof info.origin !== "string"
    ) return;
    const sourcePath = info.path.replaceAll("\\\\", "/");
    const expectedExtensionPath = expectedRoot.replaceAll("\\\\", "/") + "/dist/extension.js";
    const expectedShimPath = expectedRoot.replaceAll("\\\\", "/") + "/dist/${ROLLBACK_SHIM_FILENAME}";
    if (sourcePath !== expectedExtensionPath && sourcePath !== expectedShimPath) return;
    const packageRoot = expectedRoot.replaceAll("\\\\", "/");
    const bytes = await Bun.file(expectedExtensionPath).bytes();
    const sourceHash = digest(bytes);
    const manifest = await Bun.file(packageRoot + "/package.json").json();
    const manifestRecord = manifest && typeof manifest === "object" ? manifest : {};
    adapterPackageVersion = typeof manifestRecord.version === "string" ? manifestRecord.version : undefined;
    adapterExtensionSha256 = sourceHash;
    adapterPackageRootMatched = packageRoot === expectedRoot.replaceAll("\\\\", "/");
    adapterPackageSourceProven =
      info.origin === "package" &&
      /^npm:@weaveio\\/weave-adapter-pi(?:@|$)/u.test(info.source) &&
      manifestRecord.name === "@weaveio/weave-adapter-pi" &&
      adapterPackageRootMatched;
    adapterExtensionHashMatched = sourceHash === expectedHash && expectedVersion === adapterPackageVersion;
  } catch {
    adapterPackageVersion = undefined;
    adapterExtensionSha256 = undefined;
    adapterPackageSourceProven = false;
    adapterPackageRootMatched = false;
    adapterExtensionHashMatched = false;
  }
};
const observeIdentityBefore = () => {
  if (processIdBeforeHash === undefined) processIdBeforeHash = digest(String(process.pid));
  if (role === "child" && typeof childId === "string" && childId.length > 0 && childIdBeforeHash === undefined) {
    childIdBeforeHash = digest(childId);
  }
};
const observeIdentityAfter = () => {
  processIdAfterHash = digest(String(process.pid));
  if (role === "child" && typeof childId === "string" && childId.length > 0) {
    childIdAfterHash = digest(childId);
  }
};
const markerValue = (value) => {
  if (value && typeof value === "object" && value.message && typeof value.message === "object") {
    return markerValue(value.message);
  }
  return value;
};
const markerToken = (value) => {
  const message = markerValue(value);
  return message && typeof message === "object" &&
    (message.customType === NATIVE_RECOVERY_MARKER_TYPE || message.customType === RECOVERY_MARKER) &&
    message.details && typeof message.details.token === "string" &&
    UUID_V4.test(message.details.token)
    ? message.details.token
    : undefined;
};
const isMarker = (value) => markerToken(value) !== undefined;
const observeModel = (event) => {
  const model = event?.model;
  if (model?.provider && model?.id) appliedIdentity = { provider: String(model.provider), id: String(model.id) };
};
const persist = () => {
  if (capturePath.length === 0) return pendingPersist;
  const snapshot = {
    schemaVersion: 1,
    kind: "control",
    role,
    ...(markerTokenHash === undefined ? {} : { markerTokenHash }),
    ...(failedAssistantFingerprintHash === undefined ? {} : { failedAssistantFingerprintHash }),
    ...(failedAssistantShapeHash === undefined ? {} : { failedAssistantShapeHash }),
    processIdHash: digest(String(process.pid)),
    ...(processIdBeforeHash === undefined ? {} : { processIdBeforeHash }),
    ...(processIdAfterHash === undefined ? {} : { processIdAfterHash }),
    ...(role === "child" && childIdBeforeHash === undefined ? {} : { childIdBeforeHash }),
    ...(role === "child" && childIdAfterHash === undefined ? {} : { childIdAfterHash }),
    ...(role === "child" && typeof childId === "string" && childId.length > 0
      ? { childIdHash: digest(childId) }
      : {}),
    lifecycle: {
      beforeAgentStartCount,
      messageStartCount,
      messageEndCount,
      contextCount,
      contextRepairCount,
      contextRepairTimesMs,
      modelSelectCount,
      modelSelectTimesMs,
      settlementCount,
      settlementTimesMs,
      markerMessageStartCount: recoveryMarkerCount,
      markerMessageStartTimesMs,
      recoveryMarkerCount,
      recoveryMarkerObserved,
      ...(appliedIdentity === undefined ? {} : { appliedIdentity })
    },
    ...(parentToolCallId === undefined ? {} : { parentToolCallIdHash: digest(parentToolCallId) }),
    ...(parentToolEndCallId === undefined ? {} : { parentToolEndCallIdHash: digest(parentToolEndCallId) }),
    ...(parentToolStartedAtMs === undefined ? {} : { parentToolStartedAtMs }),
    ...(parentToolEndedAtMs === undefined ? {} : { parentToolEndedAtMs }),
    ...(parentToolPendingMs === undefined ? {} : { parentToolPendingMs }),
    ...(role === "parent" ? { parentToolStartCount, parentToolEndCount, parentToolStartTimesMs, parentToolEndTimesMs } : {}),
    ...(pendingMessageHelperPresent === undefined ? {} : { pendingMessageHelperPresent }),
    ...(adapterPackageVersion === undefined ? {} : { adapterPackageVersion }),
    ...(adapterExtensionSha256 === undefined ? {} : { adapterExtensionSha256 }),
    ...(adapterPackageSourceProven === undefined ? {} : { adapterPackageSourceProven }),
    ...(adapterPackageRootMatched === undefined ? {} : { adapterPackageRootMatched }),
    ...(adapterExtensionHashMatched === undefined ? {} : { adapterExtensionHashMatched })
  };
  const body = JSON.stringify(snapshot);
  if (body.length <= ${MAX_CAPTURE_BYTES}) {
    pendingPersist = pendingPersist.then(() => Bun.write(capturePath, body + "\\n").then(() => undefined));
  }
  return pendingPersist;
};
export default function controlObserver(pi) {
  piApi = pi;
  pi.on("before_agent_start", () => {
    beforeAgentStartCount += 1;
    observeIdentityBefore();
    void persist();
  });
  pi.on("message_start", (event) => {
    messageStartCount += 1;
    if (isMarker(event)) {
      const token = markerToken(event);
      if (token !== undefined) markerTokenHash = digest("marker-token:" + token);
      recoveryMarkerCount += 1;
      markerMessageStartTimesMs.push(now());
      markerMessageStartSeen = true;
      recoveryMarkerObserved = true;
    }
    void persist();
  });
  pi.on("message_end", (event) => {
    messageEndCount += 1;
    const message = event?.message;
    const descriptor = describeEntry(message, 0);
    if (descriptor.correlationHash === descriptorCorrelation("failed-assistant")) {
      failedAssistantFingerprintHash = descriptor.contentFingerprintHash;
      failedAssistantShapeHash = descriptor.contentShapeHash;
    }
    void persist();
  });
  pi.on("context", () => {
    contextCount += 1;
    if (markerMessageStartSeen) {
      contextRepairCount += 1;
      contextRepairTimesMs.push(now());
    }
    void persist();
  });
  pi.on("model_select", (event) => {
    modelSelectCount += 1;
    modelSelectTimesMs.push(now());
    observeModel(event);
    void persist();
  });
  pi.on("tool_execution_start", (event) => {
    if (
      role === "parent" &&
      event?.toolName === "weave_delegate" &&
      typeof event.toolCallId === "string" &&
      event.toolCallId.length > 0
    ) {
      parentToolStartCount += 1;
      parentToolStartTimesMs.push(now());
      if (parentToolCallId === undefined) {
        parentToolCallId = event.toolCallId;
        parentToolStartedAtMs = parentToolStartTimesMs.at(-1);
      }
    }
    void persist();
  });
  pi.on("tool_execution_end", (event) => {
    if (
      role === "parent" &&
      event?.toolName === "weave_delegate" &&
      typeof event.toolCallId === "string" &&
      event.toolCallId.length > 0
    ) {
      parentToolEndCount += 1;
      parentToolEndTimesMs.push(now());
      if (parentToolEndCallId === undefined) {
        parentToolEndCallId = event.toolCallId;
        parentToolEndedAtMs = parentToolEndTimesMs.at(-1);
      }
      if (parentToolStartedAtMs !== undefined && parentToolEndedAtMs !== undefined) {
        parentToolPendingMs = parentToolEndedAtMs - parentToolStartedAtMs;
      }
    }
    void persist();
  });
  pi.on("session_start", async (_event, session) => {
    observeIdentityBefore();
    pendingMessageHelperPresent = typeof session?.hasPendingMessages === "function";
    await inspectAdapterProvenance();
    await persist();
  });
  pi.on("agent_settled", async (_event, session) => {
    settlementCount += 1;
    settlementTimesMs.push(now());
    observeIdentityAfter();
    await persist();
    if (role === "parent") session?.ui?.notify?.("PI_MODEL_FAILOVER_SMOKE_DONE", "info");
  });
}
`;
}

export function rollbackShimSource(): string {
  const encoded = (value: unknown): string => JSON.stringify(value);
  return `
import adapterFactory from "./extension.js";

const role = typeof Bun.env.WEAVE_CHILD_ID === "string" ? "child" : "parent";
const captureDir = Bun.env.PI_MODEL_SMOKE_CAPTURE_DIR ?? "";
const nameRole = role === "child"
  ? "child-" + (Bun.env.WEAVE_CHILD_ID ?? "unknown").replaceAll(/[^A-Za-z0-9_-]/gu, "_")
  : "parent";
const capturePath = captureDir.length === 0 ? "" : captureDir + "/shim-" + nameRole;
const requiredDelegationSurfaces = ${encoded(ROLLBACK_REQUIRED_DELEGATION_SURFACES)};
const write = async (phase, adapterInitialized, pi, isolatedApi) => {
  if (capturePath.length === 0) return;
  const originalSurfacePresent = typeof pi.sendMessage === "function";
  const disabledBeforeAdapterInitialization =
    typeof isolatedApi.sendMessage !== "function";
  const requiredDelegationSurfacesIntact = requiredDelegationSurfaces.every(
    (surface) => typeof pi[surface] === "function",
  );
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: "rollback-shim",
    role,
    phase,
    boundary: ${encoded(ROLLBACK_SHIM_BOUNDARY)},
    disabledSurface: ${encoded(ROLLBACK_DISABLED_SURFACE)},
    originalSurfacePresent,
    disabledBeforeAdapterInitialization,
    requiredDelegationSurfacesIntact,
    adapterInitialized,
  });
  await Bun.write(capturePath + "-" + phase + ".json", body + "\\n");
};

export default async function rollbackShim(pi) {
  const originalSendMessage = typeof pi.sendMessage === "function";
  const delegationSurfacesIntact = requiredDelegationSurfaces.every(
    (surface) => typeof pi[surface] === "function",
  );
  const isolatedApi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "sendMessage") return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
  const disabledBeforeAdapterInitialization =
    typeof isolatedApi.sendMessage !== "function";
  if (
    !originalSendMessage ||
    !delegationSurfacesIntact ||
    !disabledBeforeAdapterInitialization
  ) {
    throw new Error("rollback shim boundary contract failed");
  }
  await write("before-adapter", false, pi, isolatedApi);
  await adapterFactory(isolatedApi);
  await write("after-adapter", true, pi, isolatedApi);
}
`;
}

const ROLLBACK_SHIM_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bglobalThis\b/u,
  /\bprocess\.env\b/u,
  /\bBun\.env(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*["'](?:[^"']|\\.)+["']\s*\])?\s*=(?!=)/u,
  /\bObject\.prototype\b/u,
  /\b(?:Object|Reflect)\.(?:assign|defineProperty|deleteProperty|set|setPrototypeOf)\s*\(/u,
  /\bpi\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'](?:[^"']|\\.)+["']\s*\])\s*=(?!=)/u,
  /\bdelete\s+pi\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*["'](?:[^"']|\\.)+["']\s*\])/u,
];

/**
 * Keep the rollback shim a narrow extension-factory boundary. It may hide one
 * property on the proxy, but it must not mutate a host/global object or use an
 * environment switch to change adapter behavior.
 */
export function validateRollbackShimSource(
  source: string,
): Result<string, SmokeFailure> {
  for (const required of [
    'import adapterFactory from "./extension.js";',
    "new Proxy",
    'property === "sendMessage"',
    "phase, adapterInitialized",
    "before-adapter",
    "after-adapter",
  ]) {
    if (!source.includes(required))
      return err(
        failure(
          "FixtureBoundaryViolation",
          "rollback shim contract is incomplete",
        ),
      );
  }
  for (const pattern of ROLLBACK_SHIM_FORBIDDEN_PATTERNS) {
    if (pattern.test(source))
      return err(
        failure(
          "FixtureBoundaryViolation",
          `rollback shim matched ${pattern.source}`,
        ),
      );
  }
  return ok(source);
}

const FIXTURE_BOUNDARY_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bpi\.on\s*\(/u,
  /\bpi\.sendMessage\b/u,
  /\bsessionManager\b/u,
  /\bappendCustomMessageEntry\b/u,
  /\bObject\.defineProperty\b/u,
  /\bcrypto\.randomUUID\s*=/u,
  /\b(?:before_agent_start|message_start|message_end|model_select|agent_settled|tool_execution_start|tool_execution_end|session_start)\b/u,
  /\b(?:beforeAgentStartCount|messageStartCount|messageEndCount|contextCount|modelSelectCount|settlementCount|parentToolPendingMs|optionalSurfaceDisabled|legacySettlement|appliedIdentity)\b/u,
  /\b(?:markerFromHistory|augmentContext|recoveryMarkerMessage|contextRepairInjected|contextFailedAssistantFound)\b/u,
  /\bPI_MODEL_SMOKE_CASE\b/u,
  /\bhasPendingMessages\b/u,
  /\.messages\s*=/u,
];

/** Reject a provider fixture that can manufacture host lifecycle evidence. */
export function validateFixtureSourceBoundary(
  source: string,
): Result<string, SmokeFailure> {
  if (!source.includes("registerProvider")) {
    return err(
      failure("FixtureBoundaryViolation", "provider registration is missing"),
    );
  }
  for (const pattern of FIXTURE_BOUNDARY_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return err(
        failure(
          "FixtureBoundaryViolation",
          `provider fixture matched ${pattern.source}`,
        ),
      );
    }
  }
  return ok(source);
}

const CONTROL_OBSERVER_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bpi\.sendMessage\b/u,
  /\bpi\.setModel\b/u,
  /\bregisterProvider\b/u,
  /\bsessionManager\b/u,
  /\bappendCustomMessageEntry\b/u,
  /\bObject\.defineProperty\b/u,
  /\.messages\s*=/u,
  /\bmessages\s*:/u,
];

/** Keep the event observer read-only: it may observe and notify, but not inject. */
export function validateControlObserverSource(
  source: string,
): Result<string, SmokeFailure> {
  if (!source.includes("pi.on")) {
    return err(
      failure(
        "FixtureBoundaryViolation",
        "control observer registration is missing",
      ),
    );
  }
  for (const pattern of CONTROL_OBSERVER_FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return err(
        failure(
          "FixtureBoundaryViolation",
          `control observer matched ${pattern.source}`,
        ),
      );
    }
  }
  return ok(source);
}
