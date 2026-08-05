# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

This refresh rebuilds the artifact after the native child overlay remediation landed. It supersedes the previous refresh, which was built from `6a547d315be90df7c5db2c3c764c922e74e5e024` and carried the trusted XDG root fix (`8b9dc84215d85d87bac4644f24cc3e0dc02260cd`), the native child session-header fix (`c952ef89d90a2efa8dc27394f217d6b6307d4367`), and the bounded restore startup-suffix fix (`5b7f81f7a562a96d62711caa24df1a092bc8bd7c`). Those fixes remain in the subject history.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `920aaa3d4ef09cf829f2ab82f0df58c09e3e30d7` |
| Subject HEAD subject line | `test(pi): cover replacement-generation native overlay` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Superseded artifact subject | `6a547d315be90df7c5db2c3c764c922e74e5e024` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-920aaa3-task20-84a3c57fa497.tgz` |
| Artifact SHA-256 | `84a3c57fa497a954b4881ca5a29269b6a8c423602205f6e5e979e41213627a90` |
| Built and shipped `dist/extension.js` SHA-256 | `480d83b90133d6a92e7e1cf6db701425a3679fe975a218ce161e7f76cf38016f` |
| Built and shipped `dist/index.js` SHA-256 | `35274403e0cf0b6729fec32fc6886d733cba51606757afab0fa0b74b0553345e` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `480d83b90133d6a92e7e1cf6db701425a3679fe975a218ce161e7f76cf38016f` |
| Installed `dist/index.js` SHA-256 | `35274403e0cf0b6729fec32fc6886d733cba51606757afab0fa0b74b0553345e` |
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

The staged public manifest declares the adapter runtime dependencies (`kysely`, `mustache`, `neverthrow`, `pino`, `typebox`, `zod`) and the Pi host peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`). It also declares `pi.extensions` as `./dist/extension.js`. Installation used `--omit=peer`; the installed adapter has no nested copy of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, or `pi-agent-core`.

## Build and artifact checks

The repository was clean before the build. The build and pack used the repository's Bun release path and canonical `PublicPackagePackager`:

```sh
SUBJECT_HEAD=920aaa3d4ef09cf829f2ab82f0df58c09e3e30d7
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-920aaa3-task20-84a3c57fa497.tgz"

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
tar -xOf "$ARTIFACT" package/package.json
```

`bun run build` exited successfully. `PublicPackagePackager` staged the approved public manifest and files, ran script-disabled package packing through its Bun command runner, validated the emitted bytes with `PackagePolicyValidator`, and returned the packed tarball path. The artifact was copied to the durable artifact path, whose name embeds the subject prefix `920aaa3` and the first twelve hex characters of the tarball digest.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. The previously installed package directory was removed and replaced with the staged tree. Each shipped file was then compared byte-for-byte with the installed file.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-920aaa3-task20-84a3c57fa497.tgz"
INSTALL="$HOME/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-pi-task20-install.XXXXXX)
VERIFY=$(mktemp -d /tmp/weave-pi-task20-verify.XXXXXX)

tar -xzf "$ARTIFACT" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
rm -rf "$INSTALL"
cp -R "$STAGE/package" "$INSTALL"
tar -xzf "$ARTIFACT" -C "$VERIFY"
cmp -s "$VERIFY/package/$RELATIVE_PATH" "$INSTALL/$RELATIVE_PATH"
shasum -a 256 "$INSTALL/dist/extension.js" "$INSTALL/dist/index.js" "$INSTALL/dist/cli.js"
```

All eight shipped files compared identical: `package.json`, `README.md`, `dist/cli.js`, `dist/cli.d.ts`, `dist/extension.js`, `dist/extension.d.ts`, `dist/index.js`, and `dist/index.d.ts`. No file mismatched.

Pi settings continue to register the adapter as an npm package. The recorded `packages` list is:

```json
[
  "npm:pi-markdown-preview",
  "npm:pi-vim",
  "npm:pi-themes-rose-pine",
  "npm:@ogulcancelik/pi-codex-compaction",
  "npm:pi-cursor-sdk",
  "npm:@weaveio/weave-adapter-pi"
]
```

`~/.pi/agent/extensions` contains no `weave-adapter-pi` entry, so no local-development extension link can shadow the npm package.

Before the build, the verifier confirmed that `WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from its own environment, absent from the Pi launcher `~/.pi/agent/bin/pi`, and absent from `~/.zshrc`, `~/.zprofile`, and `~/.profile`. The override was never set during this refresh. All Pi verification commands also removed that variable from their child environment:

```sh
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi --version
env -u WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE ~/.pi/agent/bin/pi list
```

`pi --version` reported `0.83.0`. The clean-environment `pi list` result reported:

- identity: `npm:@weaveio/weave-adapter-pi`;
- path: `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi`;
- no package load or install error.

## Repository validation

| Check | Command | Result |
| --- | --- | --- |
| Build | `bun run build` | pass |
| Focused overlay suites | `bun test packages/adapters/pi/src/__tests__/child-overlay.test.ts packages/adapters/pi/src/__tests__/child-overlay-keys.test.ts packages/adapters/pi/src/__tests__/child-overlay-modules.test.ts` | 73 pass, 0 fail |
| Full Pi adapter suite | `bun test packages/adapters/pi` | 1744 pass, 0 fail, 92 files |
| Typecheck | `bun run typecheck` | pass |
| Lint | `bun run lint` | exit 0, no errors |
| Documentation links | `bun run docs:check-links` | pass |

## Scope boundary

This record proves build, artifact, install, and package-provenance setup only.

No interactive Pi TUI readiness or behavior run was performed during this refresh, and none is claimed. Acceptance matrix item **b** is **not** claimed as passed by this record. Loading, readiness, and real-behavior proof under `docs/testing/adapter-verification.md` stages 3 through 5 remain outstanding for the acceptance matrix.

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
