use anyhow::{Context, Result, bail};
use codex_chrome_extension_host::{
    assets::AssetStore,
    config::HostConfigSource,
    framing::read_frame,
    host::ProtocolHost,
    legacy::{LegacyBridge, spawn_chrome_writer},
    runtime::RuntimeManager,
    uds::SocketGuard,
};
use std::{env, io, sync::Arc};

fn main() {
    if let Err(error) = run() {
        codex_chrome_extension_host::log(format_args!("{error:#}"));
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let argument_id = extension_id_from_args();
    let config_source = Arc::new(HostConfigSource::for_current_exe()?);
    let extension_id = config_source.extension_id(argument_id)?;
    if !is_extension_id(&extension_id) {
        bail!("configured extensionId is invalid: {extension_id}");
    }
    let (listener, socket_guard) = SocketGuard::bind()?;
    codex_chrome_extension_host::log(format_args!(
        "browser relay listening on {}",
        socket_guard.path().display()
    ));

    let chrome_output = spawn_chrome_writer(io::stdout());
    let legacy = LegacyBridge::start(listener, chrome_output.clone(), Some(extension_id.clone()));
    let runtime = RuntimeManager::new(config_source, extension_id);
    let assets = AssetStore::from_environment()?;
    let mut protocol = ProtocolHost::new(runtime, assets);

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    while let Some(message) =
        read_frame(&mut reader).context("extension-host native input failed")?
    {
        if ProtocolHost::handles(&message) {
            chrome_output
                .send(protocol.handle(&message))
                .context("native output writer stopped")?;
        } else {
            legacy.handle_chrome_message(message);
        }
    }
    protocol.shutdown();
    drop(socket_guard);
    Ok(())
}

fn extension_id_from_args() -> Option<String> {
    env::args().skip(1).find_map(|argument| {
        argument
            .strip_prefix("chrome-extension://")
            .and_then(|origin| origin.split('/').next())
            .filter(|value| is_extension_id(value))
            .map(ToString::to_string)
    })
}

fn is_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| matches!(byte, b'a'..=b'p'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_chrome_extension_ids() {
        assert!(is_extension_id("abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_extension_id("hehggadaopoacecdllhhajmbjkdcmajz"));
        assert!(!is_extension_id("short"));
    }
}
