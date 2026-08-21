import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import {
  hasPrivateDeclarationReference,
  hasPrivateDependencyReference,
  PI_EXTENSION_IDENTITY_MANIFEST,
  type PublicPackageBuildError,
  type PublicPackageFileSystem,
  piIdentityOutputFiles,
  piOutputName,
  writePiExtensionBuildIdentityManifest,
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

  it("declares both Pi extension loader and implementation entries", () => {
    const piBuild = PUBLIC_PACKAGE_BUILDS["@weaveio/weave-adapter-pi"];
    const outputs = piBuild.entries.map((entry) => entry.output);
    expect(outputs).toContain("packages/adapters/pi/dist/extension.js");
    expect(outputs).toContain(
      "packages/adapters/pi/dist/extension-build-identity.js",
    );
    expect(outputs).toContain("packages/adapters/pi/dist/extension-impl.js");
    expect(piBuild.extraFiles).toEqual(["dist/extension-build-identity.json"]);
    expect(
      piBuild.entries.find(
        (entry) => entry.output === "packages/adapters/pi/dist/extension.js",
      )?.transpileOnly,
    ).toBe(true);
    const identityEntry = piBuild.entries.find(
      (entry) =>
        entry.output ===
        "packages/adapters/pi/dist/extension-build-identity.js",
    );
    expect(identityEntry).toBeDefined();
    expect("transpileOnly" in (identityEntry ?? {})).toBe(false);
  });

  it("keeps the three Pi host packages as public runtime externals", () => {
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain(
      "@earendil-works/pi-coding-agent",
    );
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain("@earendil-works/pi-ai");
    expect(PUBLIC_RUNTIME_EXTERNALS).toContain("@earendil-works/pi-tui");
  });
});

class MemoryPublicPackageFileSystem implements PublicPackageFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  copyFile(): ReturnType<PublicPackageFileSystem["copyFile"]> {
    return okAsync(undefined);
  }
  ensureDirectory(): ReturnType<PublicPackageFileSystem["ensureDirectory"]> {
    return okAsync(undefined);
  }
  makeExecutable(): ReturnType<PublicPackageFileSystem["makeExecutable"]> {
    return okAsync(undefined);
  }
  listDeclarationFiles(): ReturnType<
    PublicPackageFileSystem["listDeclarationFiles"]
  > {
    return okAsync([]);
  }
  readText(path: string): ReturnType<PublicPackageFileSystem["readText"]> {
    const contents = this.files.get(path);
    return contents === undefined
      ? errAsync({
          type: "Filesystem",
          path,
          operation: "copy",
        } satisfies PublicPackageBuildError)
      : okAsync(contents);
  }
  removeFile(): ReturnType<PublicPackageFileSystem["removeFile"]> {
    return okAsync(undefined);
  }
  writeText(
    path: string,
    contents: string,
  ): ReturnType<PublicPackageFileSystem["writeText"]> {
    this.writes.push(path);
    this.files.set(path, contents);
    return okAsync(undefined);
  }
}

describe("Pi extension build identity sidecar", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const subject = "c".repeat(40);

  it("names outputs logically and writes the sidecar after those outputs exist", async () => {
    expect(piOutputName("packages/adapters/pi/dist/extension.js")).toBe(
      "extension",
    );
    expect(piOutputName("packages/adapters/pi/dist/index.d.ts")).toBe(
      "index-declarations",
    );
    expect(piIdentityOutputFiles().map((output) => output.name)).toContain(
      "extension",
    );
    expect(
      piIdentityOutputFiles().some((output) => output.name.includes("/")),
    ).toBe(false);

    const fileSystem = new MemoryPublicPackageFileSystem();
    const result = await writePiExtensionBuildIdentityManifest({
      fileSystem,
      subject,
      dirty: true,
      buildBinding: digestA,
      inputDigests: [digestB, digestA],
      outputs: [
        { name: "index", sha256: digestB },
        { name: "extension", sha256: digestA },
      ],
      buildCompletedAt: "1970-01-01T00:00:00.100Z",
    });
    expect(result.isOk()).toBe(true);
    expect(fileSystem.writes).toEqual([PI_EXTENSION_IDENTITY_MANIFEST]);
    const sidecar = fileSystem.files.get(PI_EXTENSION_IDENTITY_MANIFEST);
    expect(sidecar).toBeDefined();
    expect(sidecar).not.toContain("packages/");
    expect(sidecar).not.toContain("/Users/");
    expect(sidecar).not.toContain("PATH");
    const parsed = JSON.parse(sidecar ?? "") as {
      schemaVersion: number;
      git: { subject: string; dirty: boolean };
      buildInputs: string[];
      outputs: { name: string; sha256: string }[];
      buildCompletedAt: string;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.git).toEqual({ subject, dirty: true });
    expect(parsed.buildInputs).toEqual([digestA, digestB]);
    expect(parsed.outputs.map((output) => output.name)).toEqual([
      "extension",
      "index",
    ]);
    expect(parsed.buildCompletedAt).toBe("1970-01-01T00:00:00.100Z");
  });

  it("refuses a sidecar when hashed outputs are missing or unsorted names collide", async () => {
    const fileSystem = new MemoryPublicPackageFileSystem();
    const result = await writePiExtensionBuildIdentityManifest({
      fileSystem,
      subject,
      dirty: false,
      buildBinding: digestA,
      inputDigests: [],
      outputs: [],
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "BuildIdentity",
      reason: "manifest-invalid",
    });
    expect(fileSystem.writes).toEqual([]);
  });
});
