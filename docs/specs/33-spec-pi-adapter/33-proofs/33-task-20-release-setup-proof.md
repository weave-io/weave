# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

The refresh includes the trusted XDG root remediation from `8b9dc84215d85d87bac4644f24cc3e0dc02260cd` and its proof commit `75c24fc668a3c2a87d5ca7ab47cb05c14069e010`.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `75c24fc668a3c2a87d5ca7ab47cb05c14069e010` |
| Trusted XDG root fix | `8b9dc84215d85d87bac4644f24cc3e0dc02260cd` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-75c24fc-task20-ef1c42e5ec1c.tgz` |
| Artifact SHA-256 | `ef1c42e5ec1c9a6835b4d75cf2b49bfb0c9945543d331bafec46a2575c21005b` |
| Built and shipped `dist/extension.js` SHA-256 | `d5d6e14ba1579e92b6f5ffde391b0b5601862d0c946cf9eee71b6fde413d206e` |
| Built and shipped `dist/index.js` SHA-256 | `97ead39ad6a41cb458b97a0ba1a0f32ca90c523114bff9affa8416db8f621f62` |
| Built and shipped `dist/cli.js` SHA-256 | `3b3cd3aff7d130095f7bdccee0b7b843500a9ea81925342062c925181176a36f` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `d5d6e14ba1579e92b6f5ffde391b0b5601862d0c946cf9eee71b6fde413d206e` |
| Installed `dist/index.js` SHA-256 | `97ead39ad6a41cb458b97a0ba1a0f32ca90c523114bff9affa8416db8f621f62` |
| Installed `dist/cli.js` SHA-256 | `3b3cd3aff7d130095f7bdccee0b7b843500a9ea81925342062c925181176a36f` |
| Pi source identity | `npm:@weaveio/weave-adapter-pi` |

The built files, tarball files, and installed entry points have the same SHA-256 digests.

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
SUBJECT_HEAD=75c24fc668a3c2a87d5ca7ab47cb05c14069e010
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-75c24fc-task20-ef1c42e5ec1c.tgz"

bun run build
SUBJECT_HEAD="$SUBJECT_HEAD" bun -e '
import { join } from "node:path";
import { PublicPackagePackager, BunPackageCommandRunner } from "./scripts/release/packager.ts";
import { PackagePolicyValidator } from "./scripts/release/package-policy.ts";
const root = `.release/task20-refresh-${process.env.SUBJECT_HEAD}`;
const result = await new PublicPackagePackager(
  new BunPackageCommandRunner(),
  new PackagePolicyValidator(),
).pack("@weaveio/weave-adapter-pi", root, join(root, "out"));
if (result.isErr()) process.exit(1);
console.log(result.value);
'
cp "$ROOT/out/weaveio-weave-adapter-pi-0.0.1.tgz" "$ARTIFACT"
tar -tzf "$ARTIFACT" | LC_ALL=C sort
shasum -a 256 "$ARTIFACT" packages/adapters/pi/dist/{extension,index,cli}.js
tar -xOf "$ARTIFACT" package/dist/extension.js | shasum -a 256
tar -xOf "$ARTIFACT" package/dist/index.js | shasum -a 256
tar -xOf "$ARTIFACT" package/dist/cli.js | shasum -a 256
```

`PublicPackagePackager` staged the approved public manifest and files, ran script-disabled package packing through its Bun command runner, and validated the emitted bytes with `PackagePolicyValidator`.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. Each shipped file was then compared byte-for-byte with the installed file.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-75c24fc-task20-ef1c42e5ec1c.tgz"
INSTALL="$HOME/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-pi-task20-install.XXXXXX)
VERIFY=$(mktemp -d /tmp/weave-pi-task20-verify.XXXXXX)

tar -xzf "$ARTIFACT" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
tar -xzf "$ARTIFACT" -C "$VERIFY"
cmp -s "$VERIFY/package/$RELATIVE_PATH" "$INSTALL/$RELATIVE_PATH"
shasum -a 256 "$INSTALL/dist/extension.js" "$INSTALL/dist/index.js" "$INSTALL/dist/cli.js"
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

A fresh Pi TUI was started with Pi `0.83.0`, `--no-session`, `--approve`, `--offline`, and the unsafe provenance variable removed. It loaded `@weaveio/weave-adapter-pi:dist/extension.js`, showed `ready ◆ WEAVE · LOOM`, and reported `Weave adapter mode: ready` through `/weave:health`. The read-only `/weave:status` output reported `trust: trusted`, `health-only: false`, and `children: 0`. This was a setup readiness check, not an acceptance-matrix scenario.

The harness ran in disposable Herdr tab `w23:tF`, with pane `w23:p8K`, created for this proof. Cleanup closed only that owned tab. Recorded Pi process IDs `71274` and `71275` had exited after cleanup. The baseline tabs `w23:t1` and `w23:tA` remained present. Final Runtime Store output reported `No active lease.` No Task 20 readiness tab remained.

## Scope boundary

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
