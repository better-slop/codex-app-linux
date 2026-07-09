# codex-app-linux

Run the Codex desktop app on Linux via npm, aur, and a nix flake.

> ‼️ We welcome platform specific PRs/issues/reproductions! Maintainer uses nix/arch (btw).

<img width="2274" height="1387" alt="image" src="https://github.com/user-attachments/assets/8efa863f-3711-4bf1-b36a-8dd165bb04d7" />

`codex-app-linux` is a thin launcher:

- bundles the matching `codex` CLI runtime
- downloads the matching Linux desktop binary archive on first run
- launches the desktop app with `CODEX_CLI_PATH` wired up

## Quick Start

### aur

- Latest
    ```bash
    yay -S codex-app-unofficial
    ```

- Beta
    ```bash
    yay -S codex-app-beta-unofficial
    ```

### npm

- Install globally
    ```bash
    npm i -g codex-app-linux@latest
    ```
    ```bash
    npm i -g codex-app-linux@beta
    ```

- Run once with `npx`:
    ```bash
    npx codex-app-linux@latest
    ```
    ```bash
    npx codex-app-linux@beta
    ```

- Browser mode from npm (**note: many features are missing, don't expect much**):
    ```bash
    npx codex-app-linux web --open
    ```

  `web` only serves the Codex UI in a browser. It does not install or replace
  the ChatGPT browser extension.

- Disable browser auth entirely (unsafe; only behind a trusted reverse proxy / tailnet):
    ```bash
    npx codex-app-linux web --dangerously-disable-auth true
    ```

## Requirements

- Linux x64
- GitHub access not required for normal app launch

## Browser Use

Linux desktop builds support Browser Use through the official
[ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg).

1. Install the extension in stable Google Chrome.
2. Start or restart the Codex desktop app.
3. Open the extension side panel and use Codex from there.

The desktop app installs the Linux native-messaging manifest and its bundled
extension host automatically. Current support is Linux x64 + stable Google
Chrome. Chromium-family variants using different profile/manifest locations
are not wired up yet.

Browser Use is separate from Computer Use. This enables the extension-driven
Chrome workflow; it does not add Linux desktop mouse/keyboard control.

If `CODEX_CLI_PATH` is already set, the launcher uses it.
Otherwise it uses the bundled `resources/codex`, then falls back to `which codex`.

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
- prod package: `codex-app-unofficial`
- beta package: `codex-app-beta-unofficial`

Launcher behavior:

- uses existing `CODEX_CLI_PATH` if set
- otherwise sets `CODEX_CLI_PATH` from bundled `resources/codex`
- finally falls back to `which codex`
- errors if neither is available
- extracts `linux-unpacked` into cache on first run
- npm launches the unpacked binary directly
- npm also exposes `codex-app-linux web` to serve the bundled UI in a browser
- browser auth can be disabled explicitly with `--dangerously-disable-auth true`
- AppImage and `linux-unpacked` release binaries perform the same bundled-first lookup at launch
- browser mode is npm-only; AUR packages continue to ship desktop launch behavior only

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
