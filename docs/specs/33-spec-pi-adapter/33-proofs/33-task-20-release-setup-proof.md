# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

This refresh includes both live-proof remediations: the trusted XDG root fix from `8b9dc84215d85d87bac4644f24cc3e0dc02260cd`, recorded by proof commit `75c24fc668a3c2a87d5ca7ab47cb05c14069e010`, and the native child session-header fix from `c952ef89d90a2efa8dc27394f217d6b6307d4367`, recorded by proof commit `eec3a4af1e65ebed5f4b2de44c139e3831ae5694`.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `eec3a4af1e65ebed5f4b2de44c139e3831ae5694` |
| Trusted XDG root fix | `8b9dc84215d85d87bac4644f24cc3e0dc02260cd` |
| Native child session-header fix | `c952ef89d90a2efa8dc27394f217d6b6307d4367` |
| Remediation proof commits | `75c24fc668a3c2a87d5ca7ab47cb05c14069e010`, `eec3a4af1e65ebed5f4b2de44c139e3831ae5694` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-eec3a4a-task20-c927ea47e3af.tgz` |
| Artifact SHA-256 | `c927ea47e3af584582770c8fac96547f12d9bfcf234f095987387e3586635d7c` |
| Built and shipped `dist/extension.js` SHA-256 | `4e1c360fe1e0d764c64b5eaa1535188a480110e8a48fb22f6c1089efaba4c653` |
| Built and shipped `dist/index.js` SHA-256 | `95efd487860d219e40fe57acbaf964fa62f8d89e309a9c95ecd38a95a6c1ea66` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `4e1c360fe1e0d764c64b5eaa1535188a480110e8a48fb22f6c1089efaba4c653` |
| Installed `dist/index.js` SHA-256 | `95efd487860d219e40fe57acbaf964fa62f8d89e309a9c95ecd38a95a6c1ea66` |
| Installed `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
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
SUBJECT_HEAD=eec3a4af1e65ebed5f4b2de44c139e3831ae5694
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-eec3a4a-task20-c927ea47e3af.tgz"

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
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-eec3a4a-task20-c927ea47e3af.tgz"
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

The harness ran in disposable Herdr tab `w23:tG`, with pane `w23:p8P`, created for this proof. Cleanup closed only that owned tab. Recorded Pi process IDs `4584` and `4585` had exited after cleanup. The baseline tabs `w23:t1` and `w23:tA` remained present. Final Runtime Store output reported `No active lease.` No Task 20 readiness tab remained.

## Scope boundary

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
