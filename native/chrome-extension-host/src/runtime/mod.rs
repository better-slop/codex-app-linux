mod broker;
mod http;
mod process;
mod proxy;

use crate::{APP_SERVER_PROTOCOL_VERSION, NATIVE_HOST_PROTOCOL_VERSION, config::HostConfig};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env,
    sync::{Arc, Mutex},
};

const DEFAULT_CLIENT_ID: &str = "default";

pub struct RuntimeManager {
    config: Arc<HostConfig>,
    extension_id: String,
    session: Mutex<Option<Arc<proxy::RuntimeSession>>>,
}

impl RuntimeManager {
    pub fn new(config: Arc<HostConfig>, extension_id: String) -> Self {
        Self {
            config,
            extension_id,
            session: Mutex::new(None),
        }
    }

    pub fn hello(&self) -> Value {
        // This shape is the exact protocol-v2 contract shipped by the Darwin
        // host. Asset methods are intentionally callable but not advertised.
        json!({
            "manifestSchemaVersion": 2,
            "nativeHostProtocolVersion": NATIVE_HOST_PROTOCOL_VERSION,
            "nativeHostVersion": env!("CARGO_PKG_VERSION"),
            "supportedProtocolVersions": [NATIVE_HOST_PROTOCOL_VERSION],
            "supportedMethods": ["codexRuntime/openLocalFile"]
        })
    }

    pub fn validate_request(&self, params: &Value) -> Result<()> {
        validate_constraints(params)?;
        let constraints = params.get("constraints").context("missing constraints")?;
        if constraints.get("nativeHostName").and_then(Value::as_str) != Some(crate::HOST_NAME) {
            bail!("version_mismatch: nativeHostName does not match this host");
        }
        if constraints.get("extensionId").and_then(Value::as_str)
            != Some(self.extension_id.as_str())
        {
            bail!("version_mismatch: extensionId does not match the allowed origin");
        }
        if let Some(expected_channel) = self.config.channel.as_deref()
            && constraints
                .get("extensionBuildChannel")
                .and_then(Value::as_str)
                != Some(expected_channel)
        {
            bail!("version_mismatch: extension build channel does not match");
        }
        Ok(())
    }

    pub fn ensure(&self, params: &Value, restart: bool) -> Result<Value> {
        self.validate_request(params)?;
        let client_id = params
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_CLIENT_ID);
        validate_client_id(client_id)?;

        let mut session_slot = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("app-server process mutex poisoned"))?;
        if restart && let Some(session) = session_slot.take() {
            session.stop();
        }
        if let Some(session) = session_slot.as_ref() {
            if session.is_alive()? {
                return self.runtime_result(session);
            }
            session.stop();
            *session_slot = None;
        }
        let session = proxy::RuntimeSession::start(&self.config, self.extension_id.clone())?;
        let result = self.runtime_result(&session)?;
        *session_slot = Some(session);
        Ok(result)
    }

    pub fn shutdown(&self) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        if let Some(session) = session.take() {
            session.stop();
        }
    }

    fn runtime_result(&self, session: &proxy::RuntimeSession) -> Result<Value> {
        let browser_client_sha256 = self.config.browser_client_sha256()?;
        let codex_home = env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                env::var_os("HOME")
                    .map(std::path::PathBuf::from)
                    .map(|home| home.join(".codex"))
            });
        let trusted_hashes = browser_client_sha256
            .as_ref()
            .map(|hash| vec![hash.clone()])
            .unwrap_or_default();
        Ok(json!({
            "entryId": "linux-bundled",
            "localAppServerUrl": session.url(),
            "runtimeSessionId": session.id(),
            "selected": {
                "appServerProtocolVersion": APP_SERVER_PROTOCOL_VERSION,
                "appVersion": env::var("CODEX_APP_VERSION").unwrap_or_else(|_| "linux".to_string()),
                "channel": self.config.channel.as_deref().unwrap_or("prod"),
                "cliVersion": "bundled",
                "nativeHostProtocolVersion": NATIVE_HOST_PROTOCOL_VERSION,
                "nativeHostVersion": env!("CARGO_PKG_VERSION")
            },
            "runtimeConfig": {
                "platform": "linux",
                "codexCliPath": self.config.codex_cli_path,
                "codexHome": codex_home,
                "desktopAgentModeDefaults": Value::Null,
                "nodePath": self.config.node_path,
                "nodeReplPath": self.config.node_repl_path,
                "nodeModuleDirs": [],
                "browserClientPath": self.config.browser_client_path,
                "browserClientSha256": browser_client_sha256,
                "trustedBrowserClientSha256s": trusted_hashes
            }
        }))
    }
}

impl Drop for RuntimeManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_constraints(params: &Value) -> Result<()> {
    let constraints = params.get("constraints").context("missing constraints")?;
    let required_host = constraints
        .get("requiredNativeHostProtocolVersion")
        .and_then(Value::as_u64)
        .context("missing requiredNativeHostProtocolVersion")?;
    let required_server = constraints
        .get("requiredAppServerProtocolVersion")
        .and_then(Value::as_u64)
        .context("missing requiredAppServerProtocolVersion")?;
    if required_host != NATIVE_HOST_PROTOCOL_VERSION
        || required_server != APP_SERVER_PROTOCOL_VERSION
    {
        bail!(
            "version_mismatch: extension requires native host {required_host} and app-server {required_server}"
        );
    }
    Ok(())
}

fn validate_client_id(client_id: &str) -> Result<()> {
    broker::validate_client_id(client_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        thread,
        time::Duration,
        time::{SystemTime, UNIX_EPOCH},
    };

    const TEST_EXTENSION_ID: &str = "hehggadaopoacecdllhhajmbjkdcmajg";

    fn constraints(host: u64, server: u64) -> Value {
        json!({
            "constraints": {
                "requiredNativeHostProtocolVersion": host,
                "requiredAppServerProtocolVersion": server
            }
        })
    }

    fn full_params(client_id: &str) -> Value {
        json!({
            "clientId": client_id,
            "constraints": {
                "extensionBuildChannel": "prod",
                "extensionId": TEST_EXTENSION_ID,
                "nativeHostName": crate::HOST_NAME,
                "requiredAppServerProtocolVersion": 2,
                "requiredNativeHostProtocolVersion": 2
            }
        })
    }

    fn runtime_fixture() -> (PathBuf, Arc<HostConfig>, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "codex-runtime-manager-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let process_count = root.join("process-count");
        let cli = root.join("codex");
        fs::write(
            &cli,
            format!(
                "#!/bin/sh\nprintf 'p\\n' >> \"{}\"\nwhile IFS= read -r line; do :; done\n",
                process_count.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
        let config = Arc::new(HostConfig {
            schema_version: 1,
            browser_client_path: Some(cli.clone()),
            channel: Some("prod".to_string()),
            codex_cli_path: cli.clone(),
            extension_id: Some(TEST_EXTENSION_ID.to_string()),
            node_path: cli.clone(),
            node_repl_path: cli,
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 0,
        });
        (root, config, process_count)
    }

    fn wait_for_process_count(path: &std::path::Path, expected_lines: usize) -> String {
        for _ in 0..100 {
            if let Ok(contents) = fs::read_to_string(path)
                && contents.lines().count() >= expected_lines
            {
                return contents;
            }
            thread::sleep(Duration::from_millis(10));
        }
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn accepts_only_protocol_v2_constraints() {
        validate_constraints(&constraints(2, 2)).unwrap();
        assert!(validate_constraints(&constraints(1, 2)).is_err());
        assert!(validate_constraints(&constraints(2, 3)).is_err());
    }

    #[test]
    fn client_ids_are_bounded_and_path_safe() {
        validate_client_id("sidepanel-window-42").unwrap();
        assert!(validate_client_id("../escape").is_err());
        assert!(validate_client_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn ensure_reuses_one_runtime_for_all_clients_and_restart_replaces_it() {
        let (root, config, process_count) = runtime_fixture();
        let manager = RuntimeManager::new(config, TEST_EXTENSION_ID.to_string());
        let first = manager.ensure(&full_params("window-1"), false).unwrap();
        let second = manager.ensure(&full_params("window-2"), false).unwrap();
        assert_eq!(first["localAppServerUrl"], second["localAppServerUrl"]);
        assert_eq!(first["runtimeSessionId"], second["runtimeSessionId"]);
        assert!(first["runtimeConfig"]["desktopAgentModeDefaults"].is_null());
        assert_eq!(wait_for_process_count(&process_count, 1), "p\n");

        let restarted = manager.ensure(&full_params("window-2"), true).unwrap();
        assert_ne!(first["runtimeSessionId"], restarted["runtimeSessionId"]);
        assert_eq!(wait_for_process_count(&process_count, 2), "p\np\n");
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
}
