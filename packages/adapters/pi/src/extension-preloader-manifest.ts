import {
  EXTENSION_BUILD_BINDING_PLACEHOLDER,
  EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  MAX_EXTENSION_BUILD_INPUTS,
  MAX_EXTENSION_BUILD_MANIFEST_BYTES,
  MAX_EXTENSION_BUILD_OUTPUTS,
  MAX_EXTENSION_ENTRY_PATH_LENGTH,
} from "./extension-build-identity-types.js";
import {
  hasEveryRuntimeOutput,
  isGitSubject,
  isRecord,
  isSafeTimestamp,
  isSha256,
  parseOutputDigestList,
  parseSha256List,
} from "./extension-build-identity-validation.js";
import {
  type PreloadManifest,
  RUNTIME_OUTPUTS,
  type RuntimeDigest,
  type RuntimeOutputName,
} from "./extension-preloader-contract.js";

export function isSafeAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTENSION_ENTRY_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  const components = value.split("/");
  return !components.some(
    (component, index) =>
      index > 0 && (component === "." || component === ".."),
  );
}

export function modulePathFor(artifactPath: string, fileName: string): string {
  const slash = artifactPath.lastIndexOf("/");
  return `${artifactPath.slice(0, slash + 1)}${fileName}`;
}

export function digestBytes(bytes: Uint8Array): string | undefined {
  try {
    const digest = new Bun.CryptoHasher("sha256");
    digest.update(bytes);
    const value = digest.digest("hex");
    return isSha256(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function encodeUtf8(value: string): Uint8Array | undefined {
  try {
    return new TextEncoder().encode(value);
  } catch {
    return undefined;
  }
}

export async function readBytes(
  path: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  try {
    const file = Bun.file(path);
    const expectedBytes = file.size;
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > maxBytes
    ) {
      return undefined;
    }
    // Limit the Blob read as well as the preflight size check. A file can be
    // replaced between those operations; never allocate an unbounded result.
    const contents = await file.slice(0, maxBytes).arrayBuffer();
    if (contents.byteLength !== expectedBytes || file.size !== expectedBytes) {
      return undefined;
    }
    return new Uint8Array(contents);
  } catch {
    return undefined;
  }
}

export async function readPreloadManifest(
  path: string,
): Promise<PreloadManifest | undefined> {
  const bytes = await readBytes(path, MAX_EXTENSION_BUILD_MANIFEST_BYTES);
  return bytes === undefined ? undefined : parseManifest(bytes);
}

function parseManifest(bytes: Uint8Array): PreloadManifest | undefined {
  if (bytes.byteLength > MAX_EXTENSION_BUILD_MANIFEST_BYTES) return undefined;
  const text = decodeUtf8(bytes);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.schemaVersion !== EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION) {
    return undefined;
  }
  const git = parsed.git;
  if (
    !isRecord(git) ||
    !isGitSubject(git.subject) ||
    typeof git.dirty !== "boolean"
  ) {
    return undefined;
  }
  const buildInputs = parseSha256List(
    parsed.buildInputs,
    MAX_EXTENSION_BUILD_INPUTS,
  );
  if (buildInputs === undefined) return undefined;
  if (!isSafeTimestamp(parsed.buildCompletedAt)) return undefined;
  if (!isSha256(parsed.buildBinding)) return undefined;

  const parsedOutputs = parseOutputDigestList(parsed.outputs);
  if (
    parsedOutputs === undefined ||
    parsedOutputs.length > MAX_EXTENSION_BUILD_OUTPUTS ||
    !hasEveryRuntimeOutput(parsedOutputs)
  ) {
    return undefined;
  }
  const outputs = new Map<string, string>();
  for (const output of parsedOutputs) outputs.set(output.name, output.sha256);
  return {
    buildBinding: parsed.buildBinding,
    buildCompletedAt: parsed.buildCompletedAt,
    buildInputs,
    dirty: git.dirty,
    outputs,
    subject: git.subject,
  };
}

function embeddedBindingFromSource(
  source: string,
): { readonly binding: string; readonly normalized: string } | undefined {
  const pattern =
    /(?:const|var)\s+WEAVE_PI_EMBEDDED_BUILD_BINDING\s*=\s*"([0-9a-f]{64})"\s*;/gu;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const binding = match?.[1];
  if (binding === undefined || match.index === undefined) return undefined;
  const whole = match[0];
  const bindingOffset = whole.indexOf(binding);
  if (bindingOffset < 0) return undefined;
  const normalizedMatch = `${whole.slice(0, bindingOffset)}${EXTENSION_BUILD_BINDING_PLACEHOLDER}${whole.slice(bindingOffset + binding.length)}`;
  const normalized =
    source.slice(0, match.index) +
    normalizedMatch +
    source.slice(match.index + whole.length);
  return { binding, normalized };
}

export function normalizedEntryDigest(
  entryBytes: Uint8Array | undefined,
  manifest: PreloadManifest,
  embeddedBinding: unknown,
): string | undefined {
  if (entryBytes === undefined) return undefined;
  const entrySource = decodeUtf8(entryBytes);
  if (
    entrySource === undefined ||
    !isSha256(embeddedBinding) ||
    embeddedBinding === EXTENSION_BUILD_BINDING_PLACEHOLDER ||
    embeddedBinding !== manifest.buildBinding
  ) {
    return undefined;
  }
  const embedded = embeddedBindingFromSource(entrySource);
  if (
    embedded === undefined ||
    embedded.binding !== manifest.buildBinding ||
    embedded.binding !== embeddedBinding
  ) {
    return undefined;
  }
  const normalizedEntryBytes = encodeUtf8(embedded.normalized);
  return normalizedEntryBytes === undefined
    ? undefined
    : digestBytes(normalizedEntryBytes);
}

function runtimeOutputDigest(
  outputs: readonly RuntimeDigest[],
  name: RuntimeOutputName,
): string | undefined {
  return outputs.find((output) => output.name === name)?.sha256;
}

function canonicalBuildBindingInput(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly RuntimeDigest[];
  readonly subject: string;
}): string {
  return JSON.stringify({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    git: { subject: input.subject, dirty: input.dirty },
    buildInputs: [...input.buildInputs],
    buildCompletedAt: input.buildCompletedAt,
    runtimeOutputs: RUNTIME_OUTPUTS.map((output) => ({
      name: output.name,
      sha256: runtimeOutputDigest(input.runtimeOutputs, output.name),
    })),
  });
}

export function computeBuildBinding(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly RuntimeDigest[];
  readonly subject: string;
}): string | undefined {
  if (
    input.runtimeOutputs.length !== EXTENSION_RUNTIME_OUTPUT_NAMES.length ||
    input.runtimeOutputs.some(
      (output, index) =>
        output.name !== EXTENSION_RUNTIME_OUTPUT_NAMES[index] ||
        !isSha256(output.sha256),
    )
  ) {
    return undefined;
  }
  const canonical = canonicalBuildBindingInput(input);
  const encoded = encodeUtf8(canonical);
  return encoded === undefined ? undefined : digestBytes(encoded);
}

export function runtimeModulePaths(
  entryPath: string,
): ReadonlyMap<RuntimeOutputName, string> {
  const modulePaths = new Map<RuntimeOutputName, string>();
  for (const output of RUNTIME_OUTPUTS) {
    const path =
      output.name === "extension"
        ? entryPath
        : modulePathFor(entryPath, output.fileName);
    modulePaths.set(output.name, path);
  }
  return modulePaths;
}
