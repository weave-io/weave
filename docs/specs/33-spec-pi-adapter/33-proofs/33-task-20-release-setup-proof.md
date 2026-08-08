# Task 20 release setup proof

This record covers Task 20 preparation only. It binds the installed Pi adapter to the exact release artifact built from the subject commit. It supersedes the earlier artifact data in this file and does not claim completion of Task 20(f) or the 14-scenario acceptance matrix.

This refresh includes the child-overlay width fix in `70f0fde` (`fix(pi): fit child overlay lines to terminal width`) and its CodeSight metadata restoration in `1f69937` (`chore(codesight): restore metadata accidentally changed in 70f0fde`). It supersedes the artifact built from `150f121c4ce8808f1b6e9bd0e9b15eeeef497065`.

## Subject

| Field | Verified value |
| --- | --- |
| Subject HEAD | `1f69937e62d10cf08421a74a550d2233ccfaa9e2` |
| Subject HEAD subject line | `chore(codesight): restore metadata accidentally changed in 70f0fde` |
| Width remediation in subject history | `70f0fde` — `fix(pi): fit child overlay lines to terminal width` |
| Working tree at build time | clean (`git status --porcelain` empty) |
| Superseded artifact subject | `150f121c4ce8808f1b6e9bd0e9b15eeeef497065` |
| Pi version | `0.83.0` |
| Bun version | `1.3.13` |
| Package | `@weaveio/weave-adapter-pi@0.0.1` |
| Artifact | `/Users/jose/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz` |
| Artifact SHA-256 | `636b8fac98ce2c69df982a40f698956ccd363e8189e31ee118f45c57533b3eb6` |
| Built and shipped `dist/extension.js` SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` |
| Built and shipped `dist/index.js` SHA-256 | `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e` |
| Built and shipped `dist/cli.js` SHA-256 | `8321e436db13296ae1967c0d84e51ba95c86e36e961e2650e08ddb2016d1cfdd` |
| Installed package | `/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi` |
| Installed `dist/extension.js` SHA-256 | `eda2f6193544fee382a8447e20333eb95fa663cb3a510422f1c465c24fa30d84` |
| Installed `dist/index.js` SHA-256 | `faab8e0de1044087a0d1847bd8eced0facc2e521abdb4f77499894d29fc8758e` |
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

The staged public manifest declares the adapter runtime dependencies (`kysely`, `mustache`, `neverthrow`, `pino`, `typebox`, `zod`) and the Pi host peer dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`). It declares `pi.extensions` as `./dist/extension.js`. Installation used `--omit=peer`; the installed adapter has no nested copy of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, or `pi-agent-core`.

## Build and artifact checks

The repository was clean before the build, and the subject HEAD was exactly `1f69937e62d10cf08421a74a550d2233ccfaa9e2`. The build and pack used the repository's Bun release path and canonical `PublicPackagePackager`:

```sh
SUBJECT_HEAD=1f69937e62d10cf08421a74a550d2233ccfaa9e2
ROOT=".release/task20-refresh-${SUBJECT_HEAD}"
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz"

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

`bun run build` exited successfully. `PublicPackagePackager` staged the approved public manifest and files, packed with lifecycle scripts disabled, validated the emitted bytes with `PackagePolicyValidator`, and returned the tarball path. The durable artifact name contains the subject prefix `1f69937` and the first 12 hex characters of its SHA-256 digest. The ignored `.release/` staging root did not change the tracked working tree.

## Exact-byte install and provenance

The artifact was extracted into a temporary directory. Runtime dependencies were installed without peer dependencies or lifecycle scripts. The prior installed package was backed up before replacement. All eight shipped files compared byte-for-byte with the installed files: `package.json`, `README.md`, `dist/cli.js`, `dist/cli.d.ts`, `dist/extension.js`, `dist/extension.d.ts`, `dist/index.js`, and `dist/index.d.ts`.

```sh
ARTIFACT="$HOME/.pi/agent/npm/artifacts/weaveio-weave-adapter-pi-0.0.1-1f69937-task20-636b8fac98ce.tgz"
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

Pi settings still register `npm:@weaveio/weave-adapter-pi`. The installed package path is a real directory, not a symlink. `~/.pi/agent/extensions` has no `weave-adapter-pi` entry, so no local extension shadows the npm package.

The settings digest remained `7fc846bdfc06f2b412b76a5be0c08ff33f21bd4d136cbcd3b39aa1d2294c4c71`. The launcher digest remained `1ab6836d2ecfee255f0fb85ddc1d564408d5f4c0ccd8a1f213e610dcd3efd110`. This confirms that installation preserved unrelated Pi configuration.

### Command-provenance override

`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE` was absent from the verifier environment, Pi launcher `~/.pi/agent/bin/pi`, `~/.pi/agent/settings.json`, and `~/.zshrc`. It remained disabled throughout this refresh.

Clean-environment verification reported Pi `0.83.0` and this package identity and path:

```text
npm:@weaveio/weave-adapter-pi
/Users/jose/.pi/agent/npm/node_modules/@weaveio/weave-adapter-pi
```

## Repository validation

| Check | Command | Result |
| --- | --- | --- |
| Build | `bun run build` | pass (exit 0) |
| Focused child-overlay width suite | `bun test packages/adapters/pi/src/__tests__/child-overlay-render-width.test.ts` | 6 pass, 0 fail, 1 file |
| Full Pi adapter suite | `bun test packages/adapters/pi` | 1860 pass, 0 fail, 98 files |
| Typecheck | `bun run typecheck` | pass (exit 0) |
| Lint | `bun run lint` | exit 0, no errors (352 warnings, 75 infos) |
| Documentation links | `bun run docs:check-links` | pass (exit 0) |

## Scope boundary

This record proves build, artifact, exact-byte install, npm package provenance, and repository validation only.

The focused width suite is release-setup validation. It does not by itself satisfy or prove the interactive acceptance scenario. Task 20(f) was not run as an acceptance scenario and is not claimed as passed. No interactive Pi TUI run or 14-scenario acceptance-matrix command was performed or claimed. The Task 20 plan checkbox, acceptance manifest, and smoke checklist remain unchanged.
