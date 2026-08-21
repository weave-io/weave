import { logger } from "@weaveio/weave-engine";
import { PublicPackageBuilder } from "./build-public-packages-builder.js";
import { BunPublicPackageFileSystem } from "./build-public-packages-filesystem.js";

export * from "./build-public-packages-builder.js";
export * from "./build-public-packages-filesystem.js";
export * from "./build-public-packages-git.js";
export * from "./build-public-packages-pi.js";
export * from "./build-public-packages-shared.js";

if (import.meta.main) {
  const builder = new PublicPackageBuilder(new BunPublicPackageFileSystem());
  const result = await builder.buildAll();
  if (result.isErr()) {
    logger.error(result.error, "Public package build failed");
    process.exitCode = 1;
  }
}
