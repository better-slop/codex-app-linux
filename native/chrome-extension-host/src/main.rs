use anyhow::{Context, Result, bail};
use codex_chrome_extension_host::{
    assets::AssetStore,
    config::HostConfig,
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
    let config = Arc::new(HostConfig::load_adjacent_to_current_exe()?);
    let extension_id = resolve_extension_id(&config)?;
    let (listener, socket_guard) = SocketGuard::bind()?;
    codex_chrome_extension_host::log(format_args!(
        "browser relay listening on {}",
        socket_guard.path().display()
    ));

    let chrome_output = spawn_chrome_writer(io::stdout());
    let legacy = LegacyBridge::start(listener, chrome_output.clone(), Some(extension_id.clone()));
    let runtime = RuntimeManager::new(Arc::clone(&config), extension_id);
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

fn resolve_extension_id(config: &HostConfig) -> Result<String> {
    let argument_id = env::args().skip(1).find_map(|argument| {
        argument
            .strip_prefix("chrome-extension://")
            .and_then(|origin| origin.split('/').next())
            .filter(|value| is_extension_id(value))
            .map(ToString::to_string)
    });
    match (&config.extension_id, argument_id) {
        (Some(configured), Some(argument)) if configured != &argument => {
            bail!("Chrome origin extension ID {argument} does not match configured ID {configured}")
        }
        (Some(configured), _) if is_extension_id(configured) => Ok(configured.clone()),
        (None, Some(argument)) => Ok(argument),
        (Some(configured), _) => bail!("configured extensionId is invalid: {configured}"),
        (None, None) => bail!("extensionId is missing from config and Chrome arguments"),
    }
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
