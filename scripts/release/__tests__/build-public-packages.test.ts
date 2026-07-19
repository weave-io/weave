import { describe, expect, it } from "bun:test";
import {
  hasPrivateDeclarationReference,
  hasPrivateDependencyReference,
} from "../../build-public-packages.js";

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
});
