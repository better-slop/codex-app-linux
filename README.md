# codex-app-linux

Build/publish repo for a Linux repack of the upstream Codex desktop app.

Current shape:

- tracks upstream desktop appcast feeds for `prod` and `beta`
- rebuilds the desktop app's native Electron modules for Linux x64
- publishes one npm package with `latest` and `beta` dist-tags
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

## Publish Behavior

The published npm package:

- does not bundle or install the Codex CLI
- uses existing `CODEX_CLI_PATH` if set
- otherwise sets `CODEX_CLI_PATH` from `which codex`
- errors if neither is available

## GitHub Actions

Workflow: `.github/workflows/release.yml`

- scheduled twice daily
- checks both upstream channels
- skips work if the target npm version already exists
- publishes `latest` for prod, `beta` for beta
