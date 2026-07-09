# Codex Chrome extension host for Linux

Production Rust native-messaging host for the Codex Chrome extension. It keeps
the established Browser Use Unix-socket relay and implements the extension's
protocol-v2 runtime methods on Linux:

- starts the configured Codex CLI as app-server --analytics-default-enabled;
- exposes it through a token- and Origin-gated loopback WebSocket;
- stores bounded tab-context assets under the system temporary directory;
- validates local files before opening them with xdg-open.

The host reads extension-host-config.json beside its executable. The installer
already writes that schema. The Browser Use relay continues to use
/tmp/codex-browser-use by default; CODEX_BROWSER_USE_SOCKET_DIR overrides it.

## Build and verify

    cargo test
    cargo clippy --all-targets -- -D warnings
    cargo build --release --target x86_64-unknown-linux-musl
    cargo build --release --target aarch64-unknown-linux-musl

The release profile strips and LTO-optimizes static binaries suitable for Linux
x86-64 and arm64 distributions. See THIRD_PARTY_NOTICES.md for relay provenance.
