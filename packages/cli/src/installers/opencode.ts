import { dirname, join } from "node:path";
import { okAsync, type ResultAsync } from "neverthrow";
import type { FileSystem } from "../fs/file-system.js";
import type {
  AdapterModule,
  HarnessInstaller,
  InstallError,
  InstallRequest,
  InstallResult,
} from "./index.js";

const WEAVE_ENTRY = "weave:init";

export class OpenCodeInstaller implements HarnessInstaller {
  readonly id = "opencode" as const;
  readonly supported = true;
  readonly optionalModules: AdapterModule[] = [
    {
      id: "agents",
      label: "Weave agent descriptors",
      description:
        "Install an adapter module that points OpenCode at Weave agents.",
    },
  ];

  constructor(private readonly fs: FileSystem) {}

  install(request: InstallRequest): ResultAsync<InstallResult, InstallError> {
    return this.fs
      .exists(request.configPath)
      .mapErr((error) => ({
        type: "InstallFailed" as const,
        harness: this.id,
        path: request.configPath,
        cause: error,
      }))
      .andThen((exists) => {
        if (!exists) {
          return this.writeFreshConfig(request, []);
        }

        return this.fs
          .readText(request.configPath)
          .mapErr((error) => ({
            type: "InstallFailed" as const,
            harness: this.id,
            path: request.configPath,
            cause: error,
          }))
          .andThen((content) => this.writeConfig(request, content));
      });
  }

  private writeFreshConfig(
    request: InstallRequest,
    messages: string[],
  ): ResultAsync<InstallResult, InstallError> {
    return this.writeConfig(request, "{}", messages);
  }

  private writeConfig(
    request: InstallRequest,
    existingContent: string,
    initialMessages: string[] = [],
  ): ResultAsync<InstallResult, InstallError> {
    const hasEntry = existingContent.includes(WEAVE_ENTRY);
    const messages = [...initialMessages];

    if (hasEntry && !request.force) {
      messages.push(
        "OpenCode already contains a Weave entry; no changes made.",
      );
      return this.installModules(request, false, messages);
    }

    const nextContent = this.renderConfig(existingContent, request.force);
    return this.fs
      .writeText(request.configPath, nextContent)
      .mapErr((error) => ({
        type: "InstallFailed" as const,
        harness: this.id,
        path: request.configPath,
        cause: error,
      }))
      .andThen(() => {
        messages.push("Installed Weave OpenCode integration entry.");
        return this.installModules(request, true, messages);
      });
  }

  private installModules(
    request: InstallRequest,
    changed: boolean,
    messages: string[],
  ): ResultAsync<InstallResult, InstallError> {
    if (!request.selectedModules.includes("agents")) {
      return okAsync({ harness: this.id, changed, messages });
    }

    const modulePath = join(dirname(request.configPath), "weave-agents.json");
    const content = `${JSON.stringify({ source: WEAVE_ENTRY, generatedBy: "@weave/cli" }, null, 2)}\n`;
    return this.fs
      .writeText(modulePath, content)
      .mapErr((error) => ({
        type: "InstallFailed" as const,
        harness: this.id,
        path: modulePath,
        cause: error,
      }))
      .map(() => ({
        harness: this.id,
        changed: true,
        messages: [
          ...messages,
          "Installed optional OpenCode Weave agent module.",
        ],
      }));
  }

  private renderConfig(existingContent: string, force: boolean): string {
    const existing =
      existingContent.trim().length > 0 ? existingContent.trim() : "{}";
    const marker = force ? "force" : "install";
    return `${existing}\n\n// ${WEAVE_ENTRY}:${marker}\n`;
  }
}
