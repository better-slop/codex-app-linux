# codex-app-linux

Build/publish repo for the Linux Codex desktop release flow.

Current shape:

- tracks upstream desktop appcast feeds for `prod` and `beta`
- rebuilds the upstream desktop app for Linux x64
- emits `linux-unpacked` and `AppImage`
- publishes a thin npm launcher package
- expects users to already have `codex` installed

## Commands

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
- downloads the matching `AppImage` from GitHub Releases on first run

Launcher behavior:

- uses existing `CODEX_CLI_PATH` if set
- otherwise sets `CODEX_CLI_PATH` from `which codex`
- errors if neither is available
- sets `APPIMAGE_EXTRACT_AND_RUN=1` by default for broader compatibility
- AppImage and `linux-unpacked` binaries also perform the same `codex` lookup at launch

## GitHub Actions

Workflow: `.github/workflows/release.yml`

- scheduled twice daily
- checks both upstream channels
- builds `linux-unpacked` and `AppImage`
- creates/releases tagged GitHub assets
- publishes `latest` for prod, `beta` for beta

## Nix

This repo also includes a `flake.nix` with:

- `devShells.default` for local release work
- `apps.release-prod` for `nix run .#release-prod`
- `apps.release-beta` for `nix run .#release-beta`
