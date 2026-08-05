# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It does not claim completion of the 14-scenario acceptance matrix.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `0b68a775776915f72bb08079320ed1972a4630ca` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-0b68a775-task20-73cca4466e6c.tgz` |
| Artifact SHA-256 | `73cca4466e6cd0a82d682225509c8f4aa39c783fd9c5ded5abc1509b40f51c0a` |
| Built and shipped `dist/extension.js` SHA-256 | `c13eaf83ec49472ef2661da4c3a26a145eabf7b8bdb5295b31d4f49ee6b6fdfd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `c13eaf83ec49472ef2661da4c3a26a145eabf7b8bdb5295b31d4f49ee6b6fdfd` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |

The built file, the file in the tarball, and the installed entry point have the same SHA-256 digest.

## Shipped files

The canonical release packer validated this complete tarball inventory:

```text
package/README.md
package/dist/cli.d.ts
package/dist/cli.js
package/dist/extension.d.ts
package/dist/extension.js
package/dist/index.d.ts
package/dist/index.js
package/package.json
```

The staged public manifest contains the adapter runtime dependencies and Pi host peer dependencies. Installation used `--omit=peer`; the installed adapter has no nested copy of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, or `@earendil-works/pi-tui`.

## Build and artifact checks

The repository was clean before the build. The build and pack used the repository's Bun release path and canonical `PublicPackagePackager`:

```sh
SUBJECT_HEAD=0b68a775776915f72bb08079320ed1972a4630ca
ROOT=".release/task20-prep-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-0b68a775-task20-73cca4466e6c.tgz"

bun run build
SUBJECT_HEAD="$SUBJECT_HEAD" bun -e '
import { join } from "node:path";
import { PublicPackagePackager, BunPackageCommandRunner } from "./scripts/release/packager.ts";
import { PackagePolicyValidator } from "./scripts/release/package-policy.ts";
const root = `.release/task20-prep-${process.env.SUBJECT_HEAD}`;
const result = await new PublicPackagePackager(
  new BunPackageCommandRunner(),
  new PackagePolicyValidator(),
).pack("@weaveio/weave-adapter-pi", root, join(root, "out"));
if (result.isErr()) process.exit(1);
console.log(result.value);
'
cp "$ROOT/out/weaveio-weave-adapter-pi-0.0.1.tgz" "$ARTIFACT"
tar -tzf "$ARTIFACT" | LC_ALL=C sort
shasum -a 256 "$ARTIFACT" packages/adapters/pi/dist/extension.js
tar -xOf "$ARTIFACT" package/dist/extension.js | shasum -a 256
```

`PublicPackagePackager` staged the approved public manifest and files, ran script-disabled package packing through its Bun command runner, and validated the emitted bytes with `PackagePolicyValidator`.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. Each shipped file was then compared byte-for-byte with the installed file.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-0b68a775-task20-73cca4466e6c.tgz"
INSTALL="$HOME/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-pi-task20-install.XXXXXX)
VERIFY=$(mktemp -d /tmp/weave-pi-task20-verify.XXXXXX)

tar -xzf "$ARTIFACT" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
tar -xzf "$ARTIFACT" -C "$VERIFY"
cmp -s "$VERIFY/package/$RELATIVE_PATH" "$INSTALL/$RELATIVE_PATH"
shasum -a 256 "$INSTALL/dist/extension.js"
```

The previous local-development extension link was removed. Pi settings now register `npm:@weaveio/weave-adapter-pi`. The Pi launcher no longer exports `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE`, and all verification commands also removed that variable from their child environment:

```sh
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi --version
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi list
```

The clean-environment `pi list` result reported:

- identity: `npm:@weaveio/weave-adapter-pi`;
- path: `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi`;
- no package load or install error.

## Readiness and cleanup

A fresh Pi TUI was started with Pi `0.83.0`, `--no-session`, project approval, offline startup, and the unsafe provenance variable removed. It loaded `@weaveio/weave-adapter-pi:dist/extension.js`, showed `ready ◆ WEAVE · LOOM`, and reported `Weave adapter mode: ready` through the read-only health command. This was a setup readiness check, not an acceptance-matrix scenario.

The harness ran in a disposable Herdr tab created for this proof. Cleanup closed only that owned tab. Both recorded harness process IDs had exited after cleanup. The pre-existing Herdr tabs remained present. Final Runtime Store output reported `No active lease.` No Task 20 readiness tab remained.

## Scope boundary

The Task 20 14-scenario matrix was not run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
