# Codex Chrome extension host for Linux

Production Rust native-messaging host for the Codex Chrome extension. It keeps
the established Browser Use Unix-socket relay and implements the extension's
protocol-v2 runtime methods on Linux:

- starts the configured Codex CLI as app-server --analytics-default-enabled;
- exposes it through a token- and Origin-gated loopback WebSocket;
- stores bounded tab-context assets under the system temporary directory;
- validates local files before opening them with xdg-open.

The desktop-managed host resolves registry-v2 on every runtime request, first
from `$XDG_STATE_HOME/openai-codex/chrome-native-hosts-v2.json`, then from
`$CODEX_HOME/chrome-native-hosts-v2.json`. The adjacent
`extension-host-config.json` schema remains the same installer fallback used by
the Darwin host. The Browser Use relay uses `/tmp/codex-browser-use` by default;
`CODEX_BROWSER_USE_SOCKET_DIR` overrides it.

## Build and verify

    cargo test
    cargo clippy --all-targets -- -D warnings
    cargo build --release --target x86_64-unknown-linux-musl

The release profile strips and LTO-optimizes static binaries suitable for Linux
x86-64 distributions. See `THIRD_PARTY_NOTICES.md` for relay provenance and the
packaged `RUST_DEPENDENCY_LICENSES.md` for the complete Cargo dependency notices.
