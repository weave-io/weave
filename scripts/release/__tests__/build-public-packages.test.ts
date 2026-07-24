import { describe, expect, it } from "bun:test";
import {
  hasPrivateDeclarationReference,
  hasPrivateDependencyReference,
} from "../../build-public-packages.js";
import {
  PUBLIC_PACKAGE_BUILDS,
  PUBLIC_RUNTIME_EXTERNALS,
} from "../constants.js";

describe("public package build guard", () => {
  it("rejects bundled private workspace dependency maps", () => {
    expect(
      hasPrivateDependencyReference(
        '{ "@weaveio/weave-core": "workspace:*" }',
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("rejects bundled private module specifiers", () => {
    expect(
      hasPrivateDependencyReference(
        'import { parseConfig } from "@weaveio/weave-config";',
        "@weaveio/weave-config",
      ),
    ).toBe(true);
  });

  it("allows prose that merely names a private package", () => {
    expect(
      hasPrivateDependencyReference(
        "Install @weaveio/weave-engine before continuing.",
        "@weaveio/weave-engine",
      ),
    ).toBe(false);
  });

  it("rejects private workspace references in declaration rollups", () => {
    expect(
      hasPrivateDeclarationReference(
        'import type { WeaveConfig } from "@weaveio/weave-core";',
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("rejects private package names in declaration prose", () => {
    expect(
      hasPrivateDeclarationReference(
        "/** Use @weaveio/weave-core to define this config. */",
        "@weaveio/weave-core",
      ),
    ).toBe(true);
  });

  it("keeps Pi's CommonJS-heavy externals scoped to the Pi build", () => {
    expect(PUBLIC_RUNTIME_EXTERNALS).not.toContain("pino");
    expect(PUBLIC_RUNTIME_EXTERNALS).not.toContain("kysely");
    expect(
      PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"].runtimeExternals,
    ).toEqual(["kysely", "pino"]);
  });
});
