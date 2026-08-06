# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of the 14-scenario acceptance matrix.

This refresh rebuilds the artifact after the live-session-manager work landed in `2a91854` (`fix(pi): read child refs via the live session manager`), `1c543b2` (`refactor(pi): isolate generation resources behind an internal seam`), and `150f121` (`fix(pi): isolate live session manager test filesystems`). It supersedes the previous refresh, which was built from `b2f3e339c35c0c3ba27c4a3a903ed50075145981` and carried the typed describe-source diagnostics fixes (`895f459` and `2a17b58`). The subject history also retains the resume-origin fix (`cdfbfcc`), the own-key overlay open-error diagnostics fix (`707dcae`), the exhaustive overlay open-error diagnostics mapping (`454908a`), the persisted ref title admission (`8736b78`), the historical overlay pagination and search remediation (`2521e29`), the active-child overlay startup fix (`5a0c10c`), the trusted XDG root fix (`8b9dc84`), the native child session-header fix (`c952ef8`), the bounded restore startup-suffix fix (`5b7f81f`), and the overlay session page source boundary fix (`8b15cf8`).

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `150f121c4ce8808f1b6e9bd0e9b15eeeef497065` |
| Subject HEAD subject line | `fix(pi): isolate live session manager test filesystems` |
| Remediation commits in subject history | `2a91854` — `fix(pi): read child refs via the live session manager`; `1c543b2` — `refactor(pi): isolate generation resources behind an internal seam`; `150f121` — `fix(pi): isolate live session manager test filesystems` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Superseded artifact subject | `b2f3e339c35c0c3ba27c4a3a903ed50075145981` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-150f121-task20-8bb0b953ada8.tgz` |
| Artifact SHA-256 | `8bb0b953ada871a827bb2b2c9cb50409a7ef172900214c3e961e24e1d2cf3dfc` |
| Built and shipped `dist/extension.js` SHA-256 | `70522a5122880af567b522207dead47e1d3908a5a6a4abe11954506b961a3ab3` |
| Built and shipped `dist/index.js` SHA-256 | `2634e0cecb71ae927b1449e5633c160e91ead583ef749e6d00cce747435a56aa` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `70522a5122880af567b522207dead47e1d3908a5a6a4abe11954506b961a3ab3` |
| Installed `dist/index.js` SHA-256 | `2634e0cecb71ae927b1449e5633c160e91ead583ef749e6d00cce747435a56aa` |
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

The repository was clean before the build, and the subject HEAD was confirmed to be exactly `150f121c4ce8808f1b6e9bd0e9b15eeeef497065`. The build and pack used the repository's Bun release path and canonical `PublicPackagePackager`:

```sh
SUBJECT_HEAD=150f121c4ce8808f1b6e9bd0e9b15eeeef497065
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-150f121-task20-8bb0b953ada8.tgz"

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

`bun run build` exited successfully. `PublicPackagePackager` staged the approved public manifest and files, ran script-disabled package packing through its Bun command runner, validated the emitted bytes with `PackagePolicyValidator`, and returned the packed tarball path. The artifact was copied to the durable artifact path, whose name embeds the subject prefix `150f121` and the first twelve hex characters of the tarball digest. The staging root `.release/` is ignored by Git, so the build and pack left the working tree clean.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. The previously installed package directory was moved to a temporary backup, then replaced with the staged tree; any copy or comparison failure would have restored the backup. Each shipped file was then compared byte-for-byte with the installed file.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-150f121-task20-8bb0b953ada8.tgz"
INSTALL="$HOME/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi"
STAGE=$(mktemp -d /tmp/weave-pi-task20-install.XXXXXX)
VERIFY=$(mktemp -d /tmp/weave-pi-task20-verify.XXXXXX)
BACKUPDIR=$(mktemp -d /tmp/weave-pi-task20-backup.XXXXXX)

tar -xzf "$ARTIFACT" -C "$STAGE"
(cd "$STAGE/package" && bun install --production --omit=peer --ignore-scripts)
tar -xzf "$ARTIFACT" -C "$VERIFY"
mv "$INSTALL" "$BACKUPDIR/weave-adapter-pi"
cp -R "$STAGE/package" "$INSTALL"
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

The recorded `settings.json` digest was identical before and after the install (`7fc846bdfc06f2b412b76a5be0c08ff33f21bd4d136cbcd3b39aa1d2294c4c71`), as was the launcher digest (`1ab6836d2ecfee255f0fb85ddc1d564408d5f4c0ccd8a1f213e610dcd3efd110`), so unrelated user configuration was preserved. The installed package path is a real directory, not a symlink.

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
| Focused live-session-manager suites | `bun test packages/adapters/pi/src/__tests__/child-ref-live-session-manager.test.ts packages/adapters/pi/src/__tests__/child-native-sessions.test.ts` | 83 pass, 0 fail, 2 files |
| Full Pi adapter suite | `bun test packages/adapters/pi` | 1843 pass, 0 fail, 96 files |
| Typecheck | `bun run typecheck` | pass (exit 0) |
| Lint | `bun run lint` | exit 0, no errors (352 warnings, 75 infos) |
| Documentation links | `bun run docs:check-links` | pass (exit 0) |

## Scope boundary

This record proves build, artifact, install, and package-provenance setup only.

No interactive Pi TUI readiness or behavior run was performed during this refresh, and none is claimed. Acceptance matrix items **b** and **c** are **not** claimed as passed by this record. Task 20(c) was **not** run and is **not** claimed. Loading, readiness, and real-behavior proof under `docs/testing/adapter-verification.md` stages 3 through 5 remain outstanding for the acceptance matrix.

No Task 20 scenario-matrix command was run. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged because preparation does not satisfy an acceptance scenario or checklist row.
