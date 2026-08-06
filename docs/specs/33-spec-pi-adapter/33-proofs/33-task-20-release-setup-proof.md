# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

This refresh rebuilds the artifact after the typed describe-source diagnostics work landed in `895f459` (`fix(pi): name the source error behind a describe fallback`) and `2a17b58` (`fix(pi): exhaustively map describe fallback source errors`). It supersedes the previous refresh, which was built from `5e40129c91933f6dac971f7a686dcae0e15c4191` and carried the resume-origin fix (`cdfbfcc`). The subject history also retains the own-key overlay open-error diagnostics fix (`707dcae`), the exhaustive overlay open-error diagnostics mapping (`454908a`), the persisted ref title admission (`8736b78`), the historical overlay pagination and search remediation (`2521e29`), the active-child overlay startup fix (`5a0c10c`), the trusted XDG root fix (`8b9dc84`), the native child session-header fix (`c952ef8`), the bounded restore startup-suffix fix (`5b7f81f`), and the overlay session page source boundary fix (`8b15cf8`).

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `b2f3e339c35c0c3ba27c4a3a903ed50075145981` |
| Subject HEAD subject line | `chore(codesight): restore metadata from before 2a17b58` |
| Remediation commits in subject history | `895f459` — `fix(pi): name the source error behind a describe fallback`; `2a17b58` — `fix(pi): exhaustively map describe fallback source errors` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Superseded artifact subject | `5e40129c91933f6dac971f7a686dcae0e15c4191` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-b2f3e33-task20-1ec676628a95.tgz` |
| Artifact SHA-256 | `1ec676628a9519e63f9fa69d101a15110722da5eca3eb689beb2470a7c8d672c` |
| Built and shipped `dist/extension.js` SHA-256 | `5d68b19a4e89bdcc6622921b966802e451f167df1745525f18a99c5321f61719` |
| Built and shipped `dist/index.js` SHA-256 | `a7f28f8d2349e5a22b1fd988cee2a5e4a933941ee2e62345e2580515b2d6f737` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `5d68b19a4e89bdcc6622921b966802e451f167df1745525f18a99c5321f61719` |
| Installed `dist/index.js` SHA-256 | `a7f28f8d2349e5a22b1fd988cee2a5e4a933941ee2e62345e2580515b2d6f737` |
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

The repository was clean before the build, and the subject HEAD was confirmed to be exactly `b2f3e339c35c0c3ba27c4a3a903ed50075145981`. The build and pack used the repository's Bun release path and canonical `PublicPackagePackager`:

```sh
SUBJECT_HEAD=b2f3e339c35c0c3ba27c4a3a903ed50075145981
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-b2f3e33-task20-1ec676628a95.tgz"

git log -1 --pretty='%H%n%s'
git status --porcelain
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
if (result.isErr()) { console.error(result.error); process.exit(1); }
console.log(result.value);
'
cp "$ROOT/out/weaveio-weave-adapter-pi-0.0.1.tgz" "$ARTIFACT"
tar -tzf "$ARTIFACT" | LC_ALL=C sort
shasum -a 256 "$ARTIFACT" packages/adapters/pi/dist/{extension,index,cli}.js
tar -xOzf "$ARTIFACT" package/dist/extension.js | shasum -a 256
tar -xOzf "$ARTIFACT" package/dist/index.js | shasum -a 256
tar -xOzf "$ARTIFACT" package/dist/cli.js | shasum -a 256
```

`bun run build` exited successfully. `PublicPackagePackager` staged the approved public manifest and files, ran script-disabled package packing through its Bun command runner, validated the emitted bytes with `PackagePolicyValidator`, and returned the packed tarball path. The artifact was copied to the durable artifact path, whose name embeds the subject prefix `b2f3e33` and the first twelve hex characters of the tarball digest. The staging root `.release/` is ignored by Git, so the build and pack left the working tree clean.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. The previously installed package directory was removed and replaced with the staged tree. Each shipped file was then compared byte-for-byte with the installed file.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-b2f3e33-task20-1ec676628a95.tgz"
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

All eight shipped files compared identical: `package.json`, `README.md`, `dist/cli.js`, `dist/cli.d.ts`, `dist/extension.js`, `dist/extension.d.ts`, `dist/index.js`, and `dist/index.d.ts`. No file mismatched. The install produced 18 runtime packages under `node_modules`, and none of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, or `pi-agent-core` is present.

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

### Command-provenance override

`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from the verifier environment, absent from the Pi launcher `~/.pi/agent/bin/pi`, absent from `~/.pi/agent/settings.json`, and absent from the user shell profile `~/.zshrc` (`grep -c` returned `0` for the launcher, the settings file, and the profile). The override was not set at any point during this refresh and was not enabled.

All Pi verification commands also removed that variable from their child environment:

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
| Focused overlay suites | `bun test packages/adapters/pi/src/__tests__/child-overlay.test.ts packages/adapters/pi/src/__tests__/child-overlay-keys.test.ts packages/adapters/pi/src/__tests__/child-overlay-modules.test.ts` | 101 pass, 0 fail, 3 files |
| Full Pi adapter suite | `bun test packages/adapters/pi` | 1826 pass, 0 fail, 95 files |
| Typecheck | `bun run typecheck` | pass (exit 0) |
| Lint | `bun run lint` | exit 0, no errors (352 warnings, 75 infos) |
| Documentation links | `bun run docs:check-links` | pass (exit 0) |

## Scope boundary

This record proves build, artifact, install, and package-provenance setup only.

No interactive Pi TUI readiness or behavior run was performed during this refresh, and none is claimed. Acceptance matrix items **b** and **c** are **not** claimed as passed by this record. Loading, readiness, and real-behavior proof under `docs/testing/adapter-verification.md` stages 3 through 5 remain outstanding for the acceptance matrix.

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
