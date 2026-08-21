import { isRecord } from "./extension-build-identity-validation.js";
import {
  type GlobalLoaderState,
  type LoadSlot,
  PIN_QUERY_PREFIX,
  type PinnedRuntime,
  type TrustedIdentityModule,
  type TrustedImplementationModule,
  type TrustedModuleLoader,
} from "./extension-preloader-contract.js";
import {
  beginLoad,
  disposePinnedRuntime,
  finishLoad,
  loaderState,
  pinRuntime,
  recordPreloaderFailure,
  recordPreloaderLoaded,
} from "./extension-preloader-pinned-runtime.js";

async function runExtensionLoad(
  pi: unknown,
  entryPath: unknown,
  embeddedBinding: unknown,
  state: GlobalLoaderState,
  slot: LoadSlot,
): Promise<void> {
  let pinned: PinnedRuntime | undefined;
  try {
    const preload = await pinRuntime(entryPath, embeddedBinding, state, slot);
    if (!preload.ok) {
      recordPreloaderFailure(state, preload.reason);
      return;
    }
    pinned = preload;

    const identityPath = pinned.modulePaths.get("extension-build-identity");
    const hostLoaderPath = pinned.modulePaths.get("host-module-loader");
    const implementationPath = pinned.modulePaths.get("extension-impl");
    if (
      identityPath === undefined ||
      hostLoaderPath === undefined ||
      implementationPath === undefined
    ) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "module-path-missing");
      return;
    }

    const identityModule = (await import(
      `${identityPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedIdentityModule;
    const hostModule = (await import(
      `${hostLoaderPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedModuleLoader;

    const processStartMs = identityModule.extensionProcessStartMs();
    if (!Number.isSafeInteger(processStartMs) || processStartMs < 0) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "extension-start-failed");
      return;
    }
    const loadedIdentity = {
      artifactPath: typeof entryPath === "string" ? entryPath : undefined,
      artifactSha256: pinned.loadedOutputs.find(
        (output) => output.name === "extension",
      )?.sha256,
      loadedOutputs: pinned.loadedOutputs,
      buildBinding: pinned.buildBinding,
      loadTimeMs: Date.now(),
      processStartMs,
    };
    identityModule.maybeWriteExtensionBuildIdentityProofLine(loadedIdentity);
    hostModule.recordPiExtensionEntryPath(entryPath);

    // Host resolution imports the host's own absolute modules. Keep the
    // verified registry live until that host graph and the attested graph have
    // both settled; disposal still happens before extension activation.
    const hostOutcome = await hostModule.resolveHostModules(
      new hostModule.BunPiHostModuleEnvironment(),
    );
    const outcome = isRecord(hostOutcome)
      ? (hostOutcome as {
          readonly isOk?: () => boolean;
          readonly value?: unknown;
        })
      : undefined;
    if (outcome?.isOk?.() === true) {
      hostModule.recordHostModuleOutcome(outcome.value);
    }

    let implementation: TrustedImplementationModule;
    try {
      implementation = (await import(
        `${implementationPath}${PIN_QUERY_PREFIX}${pinned.token}`
      )) as unknown as TrustedImplementationModule;
    } catch {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "module-evaluation-failed");
      return;
    }

    // All static module evaluation has settled. The module objects are now
    // sufficient for activation; release every pinned byte and registry entry
    // before calling any exported function.
    disposePinnedRuntime(state, pinned.token, slot);
    recordPreloaderLoaded(state, pinned);
    pinned = undefined;

    if (typeof implementation.default !== "function") {
      recordPreloaderFailure(state, "module-evaluation-failed");
      return;
    }
    implementation.setLoadedPiExtensionIdentity?.(loadedIdentity);
    await implementation.default(pi);
  } catch {
    if (pinned !== undefined) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
    }
    recordPreloaderFailure(state, "module-evaluation-failed");
  }
}

export function createWeaveAdapterExtension(
  pi: unknown,
  embeddedBinding: unknown,
  entryPath: unknown,
): Promise<void> {
  const state = loaderState();
  const slot = beginLoad(state);
  if (slot === undefined) return Promise.resolve();
  return runExtensionLoad(pi, entryPath, embeddedBinding, state, slot).finally(
    () => {
      finishLoad(state, slot);
    },
  );
}
