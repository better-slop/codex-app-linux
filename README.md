# codex-app-linux

Run the Codex desktop app on Linux via npm.

`codex-app-linux` is a thin launcher:

- expects `codex` CLI to already be installed
- downloads the matching Linux desktop binary archive on first run
- launches the desktop app with `CODEX_CLI_PATH` wired up

## Quick Start

Install globally:

```bash
npm i -g codex-app-linux
codex-app-linux
```

Run once with `npx`:

```bash
npx codex-app-linux
```

Beta channel:

```bash
npm i -g codex-app-linux@beta
codex-app-linux
```

```bash
npx codex-app-linux@beta
```

AUR:

```bash
yay -S codex-app-linux-bin
```

Beta AUR:

```bash
yay -S codex-app-linux-beta-bin
```

## Requirements

- Linux x64
- `codex` on `PATH`
- GitHub access not required for normal app launch

If `CODEX_CLI_PATH` is already set, the launcher uses it.
Otherwise it falls back to `which codex`.

## What This Repo Does

This repo builds and publishes the Linux release pipeline for Codex desktop:

- tracks upstream `prod` and `beta` appcast feeds
- rebuilds the upstream app for Linux x64
- emits `linux-unpacked` and `AppImage`
- publishes `codex-app-linux` on npm

## Repo Commands

```bash
npm test
npm run release:prod
npm run release:beta
```

Manual local build against the golden beta asset:

```bash
node scripts/release-channel.mjs \
  --channel beta \
  --archive "__golden__/Codex (Beta)-darwin-arm64-26.311.30926.zip"
```

## Distribution Model

GitHub Releases:

- source of truth for Linux desktop artifacts
- uploads `AppImage`
- uploads a tarball of `linux-unpacked`

npm:

- publishes `codex-app-linux`
- acts as a thin launcher
- downloads the matching `linux-unpacked` tarball from GitHub Releases on first run

AUR:

- publishes binary packages from the same GitHub release tarballs
- installs the unpacked app into `/opt`
- installs desktop entry + icon for Arch launchers/menus
- prod package: `codex-app-linux-bin`
- beta package: `codex-app-linux-beta-bin`

Launcher behavior:

- uses existing `CODEX_CLI_PATH` if set
- otherwise sets `CODEX_CLI_PATH` from `which codex`
- errors if neither is available
- extracts `linux-unpacked` into cache on first run
- npm launches the unpacked binary directly
- AppImage and `linux-unpacked` release binaries also perform the same `codex` lookup at launch

## GitHub Actions

Workflow: `.github/workflows/release.yml`

- scheduled 7 times daily
- checks both upstream channels
- builds `linux-unpacked` and `AppImage`
- creates/releases tagged GitHub assets
- publishes `latest` for prod, `beta` for beta

## Nix

This repo also includes a `flake.nix` with:

- `devShells.default` for local release work
- `apps.release-prod` for `nix run .#release-prod`
- `apps.release-beta` for `nix run .#release-beta`
