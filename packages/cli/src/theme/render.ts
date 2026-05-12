/**
 * Banner and help rendering helpers for the Weave CLI.
 */

import packageJson from "../../package.json";
import { renderLogo } from "./ascii-logo.js";
import type { ThemeColors } from "./colors.js";

export interface VersionSource {
  version?: string;
}

export class ThemeRenderer {
  constructor(private readonly versionSource: VersionSource = packageJson) {}

  renderBanner(theme: ThemeColors): string[] {
    const logo = this.renderLogo(theme);
    const versionLine = theme.dim(`{weave} v${this.getVersion()}`);
    return ["", ...logo, "", `  ${versionLine}`, ""];
  }

  renderHelp(theme: ThemeColors): string[] {
    return [
      ...this.renderBanner(theme),
      `  ${theme.bold("Weave")} ${theme.dim("— structure your AI coding workflow")}`,
      "",
      `  ${theme.boldCyan("USAGE")}`,
      "",
      `    ${theme.dim("$")} weave ${theme.cyan("<command>")} ${theme.dim("[options]")}`,
      "",
      `  ${theme.boldCyan("COMMANDS")}`,
      "",
      `    ${theme.cyan("init")}        ${theme.dim("Create Weave config and install into harnesses")}`,
      `    ${theme.cyan("validate")}    ${theme.dim("Validate .weave configuration files")}`,
      "",
      `  ${theme.boldCyan("OPTIONS")}`,
      "",
      `    ${theme.cyan("--help")}             ${theme.dim("Show this help message")}`,
      `    ${theme.cyan("--version")}          ${theme.dim("Show CLI version")}`,
      `    ${theme.cyan("--scope")} global|local ${theme.dim("Choose init scope")}`,
      `    ${theme.cyan("--install-dir")} <dir> ${theme.dim("Choose init config directory")}`,
      `    ${theme.cyan("--path")} <file>       ${theme.dim("Validate an explicit .weave file")}`,
      `    ${theme.cyan("--project")}           ${theme.dim("Validate ./.weave/config.weave")}`,
      `    ${theme.cyan("--global")}            ${theme.dim("Validate ~/.weave/config.weave")}`,
      `    ${theme.cyan("--json")}             ${theme.dim("Emit machine-readable validation output")}`,
      `    ${theme.cyan("--yes, -y")}          ${theme.dim("Accept safe non-interactive defaults")}`,
      "",
      `  ${theme.boldCyan("EXAMPLES")}`,
      "",
      `    ${theme.dim("$")} weave init                        ${theme.dim("# Interactive setup wizard")}`,
      `    ${theme.dim("$")} weave init --scope global --yes   ${theme.dim("# Non-interactive global setup")}`,
      `    ${theme.dim("$")} weave validate --project          ${theme.dim("# Validate project config")}`,
      `    ${theme.dim("$")} weave validate --path my.weave    ${theme.dim("# Validate a specific file")}`,
      "",
    ];
  }

  renderVersion(): string {
    return this.getVersion();
  }

  private getVersion(): string {
    const version = this.versionSource.version;
    if (typeof version === "string" && version.length > 0) return version;
    return "0.0.0";
  }

  private renderLogo(theme: ThemeColors): string[] {
    return renderLogo(theme);
  }
}

export const defaultThemeRenderer = new ThemeRenderer();
