import { resolve } from "node:path";
import type { OpenCode } from "@opencode-ai/client";
import type { Service as ServiceType } from "@opencode-ai/client/service";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { WeaveRpc as WeaveRpcType } from "../../packages/adapters/opencode/src/rpc.js";
import {
  type ProofProviderError,
  ProofProviderFixture,
} from "./fixtures/provider.js";
import {
  type OpenCode2ProofCaseID,
  OpenCode2ProofCases,
  type OpenCode2ProofFailure,
  type OpenCode2ProofReport,
} from "./proof-cases.js";
import {
  OPENCODE2_PROOF_HOST_VERSION,
  OpenCode2ProofEnvironment,
  type ProofEnvironmentError,
} from "./proof-environment.js";

type Client = ReturnType<typeof OpenCode.make>;
type Service = typeof ServiceType;

type RuntimeProofError =
  | { readonly type: "Environment"; readonly error: ProofEnvironmentError }
  | { readonly type: "Provider"; readonly error: ProofProviderError }
  | { readonly type: "Host"; readonly step: string; readonly detail: string }
  | { readonly type: "Case"; readonly error: OpenCode2ProofFailure };

function hostCall<T>(
  step: string,
  operation: () => Promise<T>,
): ResultAsync<T, RuntimeProofError> {
  return ResultAsync.fromThrowable(
    operation,
    (cause): RuntimeProofError => ({
      type: "Host",
      step,
      detail:
        cause instanceof Error
          ? cause.message.slice(0, 400)
          : "host operation failed",
    }),
  )();
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function hasRequest(fixture: ProofProviderFixture, marker: string): boolean {
  return fixture
    .captured()
    .some((request) => serialized(request.body).includes(marker));
}

function findRequest(
  fixture: ProofProviderFixture,
  marker: string,
): Record<string, unknown> | undefined {
  return [...fixture.captured()]
    .reverse()
    .find((request) => serialized(request.body).includes(marker))?.body;
}

class OpenCode2RuntimeProof {
  private readonly cases = new OpenCode2ProofCases();
  private service?: Service;
  private serviceStarted = false;

  constructor(
    private readonly environment: OpenCode2ProofEnvironment,
    private readonly provider: ProofProviderFixture,
  ) {}

  run(): ResultAsync<OpenCode2ProofReport, RuntimeProofError> {
    return ResultAsync.fromSafePromise(this.runResult()).andThen(
      (result) => result,
    );
  }

  dispose(): ResultAsync<void, RuntimeProofError> {
    this.provider.stop();
    if (!this.serviceStarted || this.service === undefined) {
      return this.environment
        .cleanup()
        .mapErr((error): RuntimeProofError => ({ type: "Environment", error }));
    }
    return ResultAsync.fromSafePromise(
      (async (): Promise<Result<void, RuntimeProofError>> => {
        const stopped = await hostCall(
          "service.stop",
          () =>
            this.service?.stop({
              file: this.environment.registrationFile,
              pty: "clear",
            }) ?? Promise.resolve(),
        );
        this.serviceStarted = false;
        const cleaned = await this.environment
          .cleanup()
          .mapErr(
            (error): RuntimeProofError => ({ type: "Environment", error }),
          );
        if (stopped.isErr()) return err(stopped.error);
        if (cleaned.isErr()) return err(cleaned.error);
        return ok(undefined);
      })(),
    ).andThen((result) => result);
  }

  private async runResult(): Promise<
    Result<OpenCode2ProofReport, RuntimeProofError>
  > {
    const configured = await this.environment.configureProject(
      this.provider.url,
    );
    if (configured.isErr())
      return err({ type: "Environment", error: configured.error });
    const artifact = this.record(
      "artifact_identity",
      this.environment.tarballSha256.length === 64 &&
        this.environment.pluginSha256.length === 64,
      "packed tarball and installed server entry have recorded SHA-256 digests",
    );
    if (artifact.isErr()) return err(artifact.error);

    const modules = await hostCall("load staged public modules", async () => {
      const clientPath = resolve(
        this.environment.runtime,
        "node_modules/@opencode-ai/client/dist/promise/index.js",
      );
      const servicePath = resolve(
        this.environment.runtime,
        "node_modules/@opencode-ai/client/dist/promise/service.js",
      );
      const rpcPath = resolve(this.environment.installedAdapter, "dist/rpc.js");
      const [clientModule, serviceModule, rpcModule]: [
        typeof import("@opencode-ai/client"),
        typeof import("@opencode-ai/client/service"),
        { WeaveRpc: typeof WeaveRpcType },
      ] = await Promise.all([
        import(clientPath),
        import(servicePath),
        import(rpcPath),
      ]);
      return { clientModule, serviceModule, rpcModule };
    });
    if (modules.isErr()) return err(modules.error);
    this.service = modules.value.serviceModule.Service;
    const endpoint = await hostCall("service.ensure", () =>
      modules.value.serviceModule.Service.ensure({
        file: this.environment.registrationFile,
        version: OPENCODE2_PROOF_HOST_VERSION,
        command: [
          this.environment.binary,
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
        env: this.environment.serviceEnvironment(),
      }),
    );
    if (endpoint.isErr()) return err(endpoint.error);
    this.serviceStarted = true;
    const client = modules.value.clientModule.OpenCode.make({
      baseUrl: endpoint.value.url,
      headers: modules.value.serviceModule.Service.headers(endpoint.value),
    });
    const location = { directory: this.environment.project };

    const health = await hostCall("health.get", () => client.health.get());
    if (health.isErr()) return err(health.error);
    const host = this.record(
      "host_identity",
      health.value.healthy === true &&
        health.value.version === OPENCODE2_PROOF_HOST_VERSION,
      `isolated service reported exact host ${health.value.version}`,
    );
    if (host.isErr()) return err(host.error);

    const activation = await hostCall("plugin.awaitActivation", () =>
      client.plugin.awaitActivation({ location }),
    );
    if (activation.isErr()) return err(activation.error);
    const plugins = await hostCall("plugin.list", () =>
      client.plugin.list({ location }),
    );
    if (plugins.isErr()) return err(plugins.error);
    const activePlugin = plugins.value.data.some(
      (plugin) =>
        plugin.state.status === "active" &&
        serialized(plugin.source).includes("weave-adapter-opencode"),
    );
    const plugin = this.record(
      "plugin_activation",
      activePlugin,
      "packed package activated through the native plugin inventory",
    );
    if (plugin.isErr()) return err(plugin.error);

    const inventories = await hostCall("native inventories", () =>
      Promise.all([
        client.agent.list({ location }),
        client.model.list({ location }),
        client.skill.list({ location }),
        client.command.list({ location }),
      ]),
    );
    if (inventories.isErr()) return err(inventories.error);
    const [agents, models, skills, commands] = inventories.value;
    const agentIDs = new Set(agents.data.map((agent) => agent.id));
    const inventory = this.record(
      "native_inventory",
      ["loom", "tapestry", "shuttle", "proof-denied", "collision"].every((id) =>
        agentIDs.has(id),
      ) &&
        models.data.some(
          (model) => model.providerID === "proof" && model.id === "proof-model",
        ) &&
        skills.data.some((skill) => skill.name === "proof-skill") &&
        commands.data.some((command) => command.name === "weave:start"),
      "native agent, model, skill, and command inventories contain the proof resources",
    );
    if (inventory.isErr()) return err(inventory.error);

    const collision = agents.data.find((agent) => agent.id === "collision");
    const collisionProof = this.record(
      "foreign_collision",
      collision?.system === "FOREIGN_COLLISION_SYSTEM",
      "foreign same-ID agent retained its native system prompt",
    );
    if (collisionProof.isErr()) return err(collisionProof.error);

    const session = await this.createSession(client, "loom");
    if (session.isErr()) return err(session.error);
    const prompted = await hostCall("session.prompt", () =>
      client.session.prompt({
        sessionID: session.value.id,
        text: "CASE_PROMPT",
      }),
    );
    if (prompted.isErr()) return err(prompted.error);
    const waited = await hostCall("session.wait", () =>
      client.session.wait({ sessionID: session.value.id }),
    );
    if (waited.isErr()) return err(waited.error);
    const request = findRequest(this.provider, "CASE_PROMPT");
    const requestText = serialized(request);
    const promptCase = this.record(
      "prompt_request",
      requestText.includes("WEAVE_REVISION_ONE") &&
        requestText.includes("CASE_PROMPT"),
      "captured request contains the composed role prompt and user marker",
    );
    if (promptCase.isErr()) return err(promptCase.error);
    const variantCase = this.record(
      "model_variant",
      request?.model === "proof-model" &&
        request?.weave_variant_probe === "proof-variant" &&
        request?.temperature === 0.42,
      "captured request contains model, native variant body, and declared temperature",
    );
    if (variantCase.isErr()) return err(variantCase.error);
    const skillCase = this.record(
      "skill_attachment",
      requestText.includes("PROOF_SKILL_CONTENT"),
      "captured request contains the configured available skill content once",
    );
    if (skillCase.isErr()) return err(skillCase.error);
    const toolsCase = this.record(
      "tool_policy",
      requestText.includes('"subagent"') &&
        !requestText.includes('"shell"') &&
        !requestText.includes('"edit"'),
      "captured request exposes eligible native delegation without denied write or shell tools",
    );
    if (toolsCase.isErr()) return err(toolsCase.error);

    const weave = client.rpc(modules.value.rpcModule.WeaveRpc);
    const status = await hostCall("weave.status", () =>
      weave.status(
        {
          sessionID: session.value.id,
          directory: this.environment.project,
          workspaceID: session.value.location.workspaceID,
          scopeToken: "runtime-proof",
        },
        { location },
      ),
    );
    if (status.isErr()) return err(status.error);
    const command = await hostCall("session.command", () =>
      client.session.command({
        sessionID: session.value.id,
        command: "weave:start",
        text: "active",
        delivery: "queue",
      }),
    );
    if (command.isErr()) return err(command.error);
    const commandWait = await hostCall("session.wait command", () =>
      client.session.wait({ sessionID: session.value.id }),
    );
    if (commandWait.isErr()) return err(commandWait.error);
    const plan = await hostCall("weave.plan", () =>
      weave.plan(
        {
          sessionID: session.value.id,
          directory: this.environment.project,
          workspaceID: session.value.location.workspaceID,
          scopeToken: "runtime-proof",
        },
        { location },
      ),
    );
    if (plan.isErr()) return err(plan.error);
    const commandCase = this.record(
      "command_and_plan_rpc",
      status.value.readiness.durableWorkflows === false &&
        status.value.readiness.foregroundPlans &&
        plan.value.state === "ready" &&
        plan.value.plan?.name === "active" &&
        plan.value.plan.current?.id === "1",
      "reserved command selected one plan and read-only RPC reported active task 1",
    );
    if (commandCase.isErr()) return err(commandCase.error);

    const foreground = await this.proveSubagent(
      client,
      "CASE_FOREGROUND",
      false,
    );
    if (foreground.isErr()) return err(foreground.error);
    const background = await this.proveSubagent(
      client,
      "CASE_BACKGROUND",
      true,
    );
    if (background.isErr()) return err(background.error);

    const validWrite =
      await this.environment.writeValidWeaveConfig("WEAVE_REVISION_TWO");
    if (validWrite.isErr())
      return err({ type: "Environment", error: validWrite.error });
    await Bun.sleep(300);
    const refreshedSession = await this.createSession(client, "loom");
    if (refreshedSession.isErr()) return err(refreshedSession.error);
    const refreshed = await this.promptAndWait(
      client,
      refreshedSession.value.id,
      "CASE_VALID_REFRESH",
    );
    if (refreshed.isErr()) return err(refreshed.error);
    const validRefresh = this.record(
      "valid_refresh",
      serialized(findRequest(this.provider, "CASE_VALID_REFRESH")).includes(
        "WEAVE_REVISION_TWO",
      ),
      "a later request used the valid second source revision",
    );
    if (validRefresh.isErr()) return err(validRefresh.error);

    const invalidWrite = await this.environment.writeInvalidWeaveConfig();
    if (invalidWrite.isErr())
      return err({ type: "Environment", error: invalidWrite.error });
    await Bun.sleep(300);
    const invalidRefresh = await this.promptAndWait(
      client,
      refreshedSession.value.id,
      "CASE_INVALID_REFRESH",
    );
    if (invalidRefresh.isErr()) return err(invalidRefresh.error);
    const invalidCase = this.record(
      "invalid_refresh",
      serialized(findRequest(this.provider, "CASE_INVALID_REFRESH")).includes(
        "WEAVE_REVISION_TWO",
      ),
      "malformed source kept the last valid catalog active",
    );
    if (invalidCase.isErr()) return err(invalidCase.error);

    const missingPromptWrite =
      await this.environment.writeMissingPromptWeaveConfig();
    if (missingPromptWrite.isErr())
      return err({ type: "Environment", error: missingPromptWrite.error });
    await Bun.sleep(300);
    const missingPlanRequests = this.provider.captured().length;
    const missingPlan = await hostCall("missing plan command", () =>
      client.session.command({
        sessionID: refreshedSession.value.id,
        command: "weave:start",
        text: "missing",
        delivery: "queue",
      }),
    );
    if (missingPlan.isErr()) return err(missingPlan.error);
    await Bun.sleep(100);
    const afterMissing = this.provider.captured().length;
    const negative = this.record(
      "negative_resources",
      !agentIDs.has("unavailable-model") &&
        status.value.issues.some(
          (issue) => issue.code === "skill_unavailable",
        ) &&
        missingPlanRequests === afterMissing,
      "missing model, skill, prompt, and plan paths stayed bounded and started no placeholder work",
    );
    if (negative.isErr()) return err(negative.error);

    const wrongLocation = await hostCall(
      "wrong location expected error",
      async () => {
        const result = await ResultAsync.fromThrowable(
          () =>
            weave.status(
              {
                sessionID: session.value.id,
                directory: resolve(this.environment.root, "wrong-location"),
                workspaceID: session.value.location.workspaceID,
                scopeToken: "wrong-location",
              },
              { location },
            ),
          () => undefined,
        )();
        return result.isErr();
      },
    );
    if (wrongLocation.isErr()) return err(wrongLocation.error);
    const wrongCase = this.record(
      "wrong_location",
      wrongLocation.value,
      "read-only RPC rejected a mismatched requested Location",
    );
    if (wrongCase.isErr()) return err(wrongCase.error);

    const deniedSession = await this.createSession(client, "proof-denied");
    if (deniedSession.isErr()) return err(deniedSession.error);
    const denied = await this.promptAndWait(
      client,
      deniedSession.value.id,
      "CASE_DENIED_DELEGATION",
    );
    if (denied.isErr()) return err(denied.error);
    const deniedText = serialized(
      findRequest(this.provider, "CASE_DENIED_DELEGATION"),
    );
    const deniedCase = this.record(
      "denied_delegation",
      !deniedText.includes('"subagent"'),
      "delegate-denied agent request did not expose the native subagent tool",
    );
    if (deniedCase.isErr()) return err(deniedCase.error);

    const concurrentOne = await this.createSession(client, "loom");
    if (concurrentOne.isErr()) return err(concurrentOne.error);
    const concurrentTwo = await this.createSession(client, "loom");
    if (concurrentTwo.isErr()) return err(concurrentTwo.error);
    const parallel = await hostCall("concurrent admission", () =>
      Promise.all([
        this.promptAndWaitUnsafe(
          client,
          concurrentOne.value.id,
          "CASE_CONCURRENT_ONE",
        ),
        this.promptAndWaitUnsafe(
          client,
          concurrentTwo.value.id,
          "CASE_CONCURRENT_TWO",
        ),
      ]),
    );
    if (parallel.isErr()) return err(parallel.error);
    const concurrentCase = this.record(
      "concurrent_admission",
      hasRequest(this.provider, "CASE_CONCURRENT_ONE") &&
        hasRequest(this.provider, "CASE_CONCURRENT_TWO"),
      "parallel admissions both completed against one valid catalog generation",
    );
    if (concurrentCase.isErr()) return err(concurrentCase.error);

    const interruptSession = await this.createSession(client, "loom");
    if (interruptSession.isErr()) return err(interruptSession.error);
    const interruptPrompt = await hostCall("interrupt prompt", () =>
      client.session.prompt({
        sessionID: interruptSession.value.id,
        text: "CASE_INTERRUPT",
      }),
    );
    if (interruptPrompt.isErr()) return err(interruptPrompt.error);
    await Bun.sleep(100);
    const interrupted = await hostCall("session.interrupt", () =>
      client.session.interrupt({
        sessionID: interruptSession.value.id,
      }),
    );
    if (interrupted.isErr()) return err(interrupted.error);
    const interruptionCase = this.record(
      "interruption",
      interrupted.value.interrupted,
      "public session interrupt stopped the deterministic in-flight request",
    );
    if (interruptionCase.isErr()) return err(interruptionCase.error);

    const noRuntimeStore = !(await Bun.file(
      resolve(this.environment.project, ".weave/runtime/weave.db"),
    ).exists());
    const cleanupCase = this.record(
      "cleanup",
      noRuntimeStore,
      "proof created no unexpected Weave Runtime Store database",
    );
    if (cleanupCase.isErr()) return err(cleanupCase.error);
    return this.cases
      .complete({
        adapterVersion: this.environment.adapterVersion,
        tarballSha256: this.environment.tarballSha256,
        pluginSha256: this.environment.pluginSha256,
      })
      .mapErr((error): RuntimeProofError => ({ type: "Case", error }));
  }

  private createSession(client: Client, agent: string) {
    return hostCall("session.create", () =>
      client.session.create({
        location: { directory: this.environment.project },
        agent,
        model: {
          providerID: "proof",
          id: "proof-model",
          variant: "proof-variant",
        },
      }),
    );
  }

  private promptAndWait(
    client: Client,
    sessionID: string,
    text: string,
  ): ResultAsync<void, RuntimeProofError> {
    return hostCall("session.prompt", () =>
      this.promptAndWaitUnsafe(client, sessionID, text),
    );
  }

  private async promptAndWaitUnsafe(
    client: Client,
    sessionID: string,
    text: string,
  ): Promise<void> {
    await client.session.prompt({ sessionID, text });
    await client.session.wait({ sessionID });
  }

  private proveSubagent(
    client: Client,
    marker: "CASE_FOREGROUND" | "CASE_BACKGROUND",
    background: boolean,
  ): ResultAsync<void, RuntimeProofError> {
    return hostCall(
      `native ${background ? "background" : "foreground"} subagent`,
      async () => {
        const parent = await client.session.create({
          location: { directory: this.environment.project },
          agent: "loom",
          model: {
            providerID: "proof",
            id: "proof-model",
            variant: "proof-variant",
          },
        });
        await client.session.prompt({ sessionID: parent.id, text: marker });
        await client.session.wait({ sessionID: parent.id });
        const children = await client.session.list({
          parentID: parent.id,
          directory: this.environment.project,
        });
        const child = children.data.find(
          (candidate) =>
            candidate.parentID === parent.id && candidate.agent === "shuttle",
        );
        if (child === undefined)
          throw new Error("native child session was not created");
        await client.session.wait({ sessionID: child.id });
        const childContext = await client.session.context({
          sessionID: child.id,
        });
        const childText = serialized(childContext);
        const expected = background
          ? "CHILD_BACKGROUND_DONE"
          : "CHILD_FOREGROUND_DONE";
        if (!childText.includes(expected))
          throw new Error("native child result was not visible");
        const id: OpenCode2ProofCaseID = background
          ? "background_subagent"
          : "foreground_subagent";
        const verdict = this.record(
          id,
          child.model?.providerID === "proof" &&
            child.model.id === "proof-model" &&
            child.model.variant === "proof-variant",
          `${background ? "background" : "foreground"} native child used its registered model and returned a result`,
        );
        if (verdict.isErr()) throw new Error(verdict.error.type);
      },
    );
  }

  private record(
    id: OpenCode2ProofCaseID,
    condition: boolean,
    evidence: string,
  ): Result<void, RuntimeProofError> {
    const result = condition
      ? this.cases.pass(id, evidence)
      : this.cases.fail(id, evidence);
    if (result.isErr()) return err({ type: "Case", error: result.error });
    if (!condition)
      return err({ type: "Case", error: { type: "FailedCase", caseID: id } });
    return ok(undefined);
  }
}

async function main(): Promise<void> {
  const prepared = await OpenCode2ProofEnvironment.prepare();
  if (prepared.isErr()) {
    await Bun.write(
      Bun.stderr,
      `${JSON.stringify({ status: "failed", error: prepared.error })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const provider = ProofProviderFixture.start();
  if (provider.isErr()) {
    await prepared.value.cleanup();
    await Bun.write(
      Bun.stderr,
      `${JSON.stringify({ status: "failed", error: provider.error })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const proof = new OpenCode2RuntimeProof(prepared.value, provider.value);
  const result = await proof.run();
  const disposed = await proof.dispose();
  if (result.isErr() || disposed.isErr()) {
    await Bun.write(
      Bun.stderr,
      `${JSON.stringify({
        status: "failed",
        error: result.isErr() ? result.error : disposed._unsafeUnwrapErr(),
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({ status: "passed", report: result.value }, null, 2)}\n`,
  );
}

await main();
