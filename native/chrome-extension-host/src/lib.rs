//! Linux implementation of the Codex Chrome native messaging host.
//!
//! The legacy browser relay is derived from the MIT-licensed implementation
//! pinned in THIRD_PARTY_NOTICES.md. Protocol-v2 runtime support is native to
//! this crate.

pub mod assets;
pub mod config;
pub mod framing;
pub mod host;
pub mod legacy;
pub mod open_file;
pub mod rollout;
pub mod rpc;
pub mod runtime;
pub mod uds;

pub const HOST_NAME: &str = "com.openai.codexextension";
pub const NATIVE_HOST_PROTOCOL_VERSION: u64 = 2;
pub const APP_SERVER_PROTOCOL_VERSION: u64 = 2;

pub fn log(message: impl std::fmt::Display) {
    eprintln!("[{HOST_NAME}] {message}");
}
