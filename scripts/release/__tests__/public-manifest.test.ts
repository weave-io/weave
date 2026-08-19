import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  PRIVATE_PACKAGE_NAMES,
  PRIVATE_WORKSPACE_NAMES,
  PUBLIC_PACKAGES,
  RELEASE_CHANNELS,
} from "../constants.js";
import type { JsonObject } from "../json.js";
import {
  PublicManifestBuilder,
  type PublicManifestError,
  type PublicManifestFileSystem,
} from "../public-manifest.js";

class MemoryFileSystem implements PublicManifestFileSystem {
  readonly files = new Map<string, string>();
  readonly directories: string[] = [];

  readText(path: string) {
    const contents = this.files.get(path);
    if (contents === undefined) {
      return errAsync({
        type: "Filesystem" as const,
        path,
        operation: "read" as const,
      });
    }
    return okAsync(contents);
  }

  writeText(path: string, contents: string) {
    this.files.set(path, contents);
    return okAsync();
  }

  ensureDirectory(path: string) {
    this.directories.push(path);
    return okAsync();
  }
}

function sourceManifest(overrides: Readonly<JsonObject> = {}): JsonObject {
  return {
    name: "@weaveio/weave-cli",
    version: "1.2.3",
    description: "CLI",
    scripts: { prepublishOnly: "unsafe" },
    devDependencies: { typescript: "^5.0.0" },
    dependencies: { lodash: "^4.17.21" },
    ...overrides,
  };
}

describe("release catalog", () => {
  it("declares exactly the allowed public packages and channels", () => {
    expect(RELEASE_CHANNELS).toEqual(["stable", "next", "nightly"]);
    expect(PUBLIC_PACKAGES).toEqual({
      "@weaveio/weave-cli": {
        directory: "packages/cli",
        channels: ["stable", "next", "nightly"],
      },
      "@weaveio/weave-adapter-opencode": {
        directory: "packages/adapters/opencode",
        channels: ["stable", "next", "nightly"],
      },
      "@weaveio/weave-adapter-claude-code": {
        directory: "packages/adapters/claude-code",
        channels: ["stable", "next", "nightly"],
      },
      "@weaveio/weave-adapter-pi": {
        directory: "packages/adapters/pi",
        channels: ["stable", "next", "nightly"],
      },
    });
  });
});

describe("PublicManifestBuilder", () => {
  const fileSystem = new MemoryFileSystem();
  const builder = new PublicManifestBuilder(fileSystem);

  it("allowlists public fields and external runtime dependencies", () => {
    const result = builder.build(
      sourceManifest({
        dependencies: {
          "@weaveio/weave-core": "workspace:*",
          "@weaveio/weave-adapter-claude-code": "workspace:*",
          "@weaveio/weave-adapter-pi": "workspace:*",
          lodash: "^4.17.21",
        },
      }),
      "packages/cli/package.json",
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value).toEqual({
      name: "@weaveio/weave-cli",
      version: "1.2.3",
      description: "CLI",
      dependencies: { lodash: "^4.17.21" },
    });
    for (const privatePackageName of PRIVATE_PACKAGE_NAMES) {
      expect(JSON.stringify(result.value)).not.toContain(privatePackageName);
    }
    expect(JSON.stringify(result.value)).not.toContain(
      "@weaveio/weave-adapter-claude-code",
    );
    expect(JSON.stringify(result.value)).not.toContain(
      "@weaveio/weave-adapter-pi",
    );
  });

  it("omits the Pi adapter workspace build dependency from staged CLI manifests", () => {
    const result = builder.build(
      sourceManifest({
        dependencies: {
          "@weaveio/weave-adapter-pi": "workspace:*",
          neverthrow: "^8.2.0",
        },
      }),
      "packages/cli/package.json",
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.dependencies).toEqual({ neverthrow: "^8.2.0" });
    expect(JSON.stringify(result.value)).not.toContain(
      "@weaveio/weave-adapter-pi",
    );
  });

  for (const dependencyField of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const) {
    it(`rejects private package names in ${dependencyField}`, () => {
      const result = builder.build(
        sourceManifest({
          [dependencyField]: {
            "@weaveio/weave-private-fixture": "workspace:*",
          },
        }),
        "fixture.json",
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toEqual({
        type: "ForbiddenDependency",
        path: `fixture.json.${dependencyField}.@weaveio/weave-private-fixture`,
        dependencyField,
        packageName: "@weaveio/weave-private-fixture",
      } satisfies PublicManifestError);
    });
  }

  it("rejects the private dev-dependency fixture with its typed path", async () => {
    const fixture = await Bun.file(
      "scripts/release/__fixtures__/manifests/private-dev-dependency.json",
    ).json();
    const result = builder.build(fixture, "private-dev-dependency.json");

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "ForbiddenDependency",
      path: "private-dev-dependency.json.devDependencies.@weaveio/weave-private-dev",
      dependencyField: "devDependencies",
      packageName: "@weaveio/weave-private-dev",
    } satisfies PublicManifestError);
  });

  it("stages a new manifest without mutating its source", async () => {
    const sourcePath = "packages/cli/package.json";
    const source = JSON.stringify(sourceManifest());
    fileSystem.files.set(sourcePath, source);

    const result = await builder.stage(sourcePath, ".release/staging");

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.manifestPath).toBe(
      ".release/staging/weave-cli/package.json",
    );
    expect(fileSystem.files.get(sourcePath)).toBe(source);
    expect(fileSystem.files.get(result.value.manifestPath)).toContain('"name"');
  });

  for (const privateWorkspaceName of PRIVATE_WORKSPACE_NAMES) {
    it(`refuses to stage the private workspace ${privateWorkspaceName}`, () => {
      const result = builder.build(
        { name: privateWorkspaceName, version: "0.0.1" },
        "fixture.json",
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) return;
      expect(result.error).toEqual({
        type: "UnknownPublicPackage",
        path: "fixture.json.name",
        packageName: privateWorkspaceName,
        reason: "PrivateWorkspace",
      } satisfies PublicManifestError);
    });
  }

  it("refuses to stage a fifth package outside the catalog", () => {
    const result = builder.build(
      { name: "@weaveio/weave-adapter-fifth", version: "0.0.1" },
      "fixture.json",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "UnknownPublicPackage",
      path: "fixture.json.name",
      packageName: "@weaveio/weave-adapter-fifth",
      reason: "UnknownPackage",
    } satisfies PublicManifestError);
  });

  it("omits every known private package from staged manifests", () => {
    const result = builder.build(
      sourceManifest({
        dependencies: Object.fromEntries(
          PRIVATE_PACKAGE_NAMES.map((name) => [name, "workspace:*"]),
        ),
      }),
      "fixture.json",
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    for (const privatePackageName of PRIVATE_PACKAGE_NAMES) {
      expect(JSON.stringify(result.value)).not.toContain(privatePackageName);
    }
  });

  it("sanitizes every declared public source manifest", async () => {
    const manifestPaths = [
      "packages/cli/package.json",
      "packages/adapters/opencode/package.json",
      "packages/adapters/claude-code/package.json",
      "packages/adapters/pi/package.json",
    ];

    for (const manifestPath of manifestPaths) {
      const source = await Bun.file(manifestPath).json();
      const result = builder.build(source, manifestPath);

      expect(result.isOk()).toBe(true);
      if (result.isErr()) continue;
      expect(result.value.devDependencies).toBeUndefined();
      expect(result.value.scripts).toBeUndefined();
      for (const privatePackageName of PRIVATE_PACKAGE_NAMES) {
        expect(JSON.stringify(result.value)).not.toContain(privatePackageName);
      }
      if (result.value.name !== "@weaveio/weave-adapter-claude-code") {
        expect(JSON.stringify(result.value)).not.toContain(
          "@weaveio/weave-adapter-claude-code",
        );
      }
      if (result.value.name !== "@weaveio/weave-adapter-pi") {
        expect(JSON.stringify(result.value)).not.toContain(
          "@weaveio/weave-adapter-pi",
        );
      }
    }
  });
});
