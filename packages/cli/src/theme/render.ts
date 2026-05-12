/**
 * Banner and help rendering helpers for the Weave CLI.
 */

import packageJson from "../../package.json";
import { renderLogo } from "./ascii-logo.js";
import type { ThemeColors } from "./colors.js";

export function getVersion(): string {
  const version = packageJson.version;
  if (typeof version === "string" && version.length > 0) return version;
  return "0.0.0";
}

export function renderBanner(theme: ThemeColors): string[] {
  const logo = renderLogo(theme);
  const versionLine = theme.dim(`{weave} v${getVersion()}`);
  return ["", ...logo, "", `  ${versionLine}`, ""];
}

export function renderHelp(theme: ThemeColors): string[] {
  return [
    ...renderBanner(theme),
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

export function renderVersion(): string {
  return getVersion();
}
