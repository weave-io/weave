# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

This refresh includes all three live-proof remediations: the trusted XDG root fix from `8b9dc84215d85d87bac4644f24cc3e0dc02260cd`, recorded by proof commit `75c24fc668a3c2a87d5ca7ab47cb05c14069e010`; the native child session-header fix from `c952ef89d90a2efa8dc27394f217d6b6307d4367`, recorded by proof commit `eec3a4af1e65ebed5f4b2de44c139e3831ae5694`; and the bounded restore startup-suffix fix from `5b7f81f7a562a96d62711caa24df1a092bc8bd7c`, recorded by proof commit `6a547d315be90df7c5db2c3c764c922e74e5e024`.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `6a547d315be90df7c5db2c3c764c922e74e5e024` |
| Trusted XDG root fix | `8b9dc84215d85d87bac4644f24cc3e0dc02260cd` |
| Native child session-header fix | `c952ef89d90a2efa8dc27394f217d6b6307d4367` |
| Bounded restore startup-suffix fix | `5b7f81f7a562a96d62711caa24df1a092bc8bd7c` |
| Remediation proof commits | `75c24fc668a3c2a87d5ca7ab47cb05c14069e010`, `eec3a4af1e65ebed5f4b2de44c139e3831ae5694`, `6a547d315be90df7c5db2c3c764c922e74e5e024` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-6a547d3-task20-e905209b8cf5.tgz` |
| Artifact SHA-256 | `e905209b8cf5359eb78c7c31c5ade4f82feaa660f752b3c45a8d07e62d41750d` |
| Built and shipped `dist/extension.js` SHA-256 | `7d441b86529a1d15baecb31a77a51f298f820eb73a4a927a366b493542d723bc` |
| Built and shipped `dist/index.js` SHA-256 | `925cc842591d9b8bd2ad9c94089e821eae2c26b641b89c04264f25cf0428213f` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `7d441b86529a1d15baecb31a77a51f298f820eb73a4a927a366b493542d723bc` |
| Installed `dist/index.js` SHA-256 | `925cc842591d9b8bd2ad9c94089e821eae2c26b641b89c04264f25cf0428213f` |
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
SUBJECT_HEAD=6a547d315be90df7c5db2c3c764c922e74e5e024
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-6a547d3-task20-e905209b8cf5.tgz"

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
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-6a547d3-task20-e905209b8cf5.tgz"
INSTALL="$HOME/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-pi-task20-install.XXXXXX)
VERIFY=$(mktemp -d /tmp/weave-pi-task20-verify.XXXXXX)

tar -xzf "$ARTIFACT" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
tar -xzf "$ARTIFACT" -C "$VERIFY"
cmp -s "$VERIFY/package/$RELATIVE_PATH" "$INSTALL/$RELATIVE_PATH"
shasum -a 256 "$INSTALL/dist/extension.js" "$INSTALL/dist/index.js" "$INSTALL/dist/cli.js"
```

The previous local-development extension link was removed. Pi settings now register `npm:@weaveio/weave-adapter-pi`. Before the build, the verifier confirmed that its environment did not contain `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` and that the Pi launcher did not export it. All Pi verification commands also removed that variable from their child environment:

```sh
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi --version
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi list
```

The clean-environment `pi list` result reported:

- identity: `npm:@weaveio/weave-adapter-pi`;
- path: `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi`;
- no package load or install error.

## Readiness and cleanup

A fresh Pi TUI was started with Pi `0.83.0`, `--no-session`, and the unsafe provenance variable removed. The live process environments for recorded Pi process IDs `34750` and `34751` did not contain `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE`. Pi loaded `@weaveio/weave-adapter-pi:dist/extension.js`, showed `ready ◆ WEAVE · LOOM`, and reported `Weave adapter mode: ready` through `/weave:health`. The read-only `/weave:status` output reported `trust: trusted`, `health-only: false`, and `children: 0`. No model request was sent. This was a setup readiness check, not an acceptance-matrix scenario.

The harness ran in disposable Herdr tab `w23:tH`, with pane `w23:p8S`, created without focus for this proof. Cleanup exited Pi and closed only that owned tab. Recorded Pi process IDs `34750` and `34751` had exited after cleanup. The baseline tabs `w23:t1` and `w23:tA` remained present. Final Runtime Store output reported `No active lease.` No Task 20 readiness tab remained.

## Focused validation

The canonical `bun run build` completed successfully. The focused restore-context suite passed all 63 tests:

```sh
bun test packages/adapters/pi/src/__tests__/rpc-child.test.ts
```

The documentation link check also passed:

```sh
bun run docs:check-links
```

## Scope boundary

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
