mod broker;
mod desktop_agent_mode;
mod http;
mod process;
mod proxy;

use crate::{
    APP_SERVER_PROTOCOL_VERSION, NATIVE_HOST_PROTOCOL_VERSION,
    config::{ConfigRequest, HostConfig, HostConfigSource},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    env,
    sync::{Arc, Mutex},
};

pub struct RuntimeManager {
    config_source: Arc<HostConfigSource>,
    extension_id: String,
    session: Mutex<Option<ActiveRuntime>>,
}

struct ActiveRuntime {
    config: HostConfig,
    session: Arc<proxy::RuntimeSession>,
}

impl RuntimeManager {
    pub fn new(config_source: Arc<HostConfigSource>, extension_id: String) -> Self {
        Self {
            config_source,
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
        self.config_request(params).map(|_| ())
    }

    fn config_request<'a>(&self, params: &'a Value) -> Result<ConfigRequest<'a>> {
        let request = parse_constraints(params)?;
        if request.native_host_name != crate::HOST_NAME {
            bail!("version_mismatch: nativeHostName does not match this host");
        }
        if request.extension_id != self.extension_id {
            bail!("version_mismatch: extensionId does not match the allowed origin");
        }
        Ok(request)
    }

    pub fn ensure(&self, params: &Value, restart: bool) -> Result<Value> {
        let request = self.config_request(params)?;
        let config = self.config_source.resolve(request)?;
        let client_id = params
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or(broker::DEFAULT_CLIENT_ID);
        validate_client_id(client_id)?;

        let mut session_slot = self
            .session
            .lock()
            .map_err(|_| anyhow::anyhow!("app-server process mutex poisoned"))?;
        if restart && let Some(active) = session_slot.take() {
            active.session.stop();
        }
        if let Some(active) = session_slot.as_ref() {
            if active.config == config && active.session.is_alive()? {
                return self.runtime_result(&active.config, &active.session);
            }
            active.session.stop();
            *session_slot = None;
        }
        let session = proxy::RuntimeSession::start(&config, self.extension_id.clone())?;
        let result = self.runtime_result(&config, &session)?;
        *session_slot = Some(ActiveRuntime { config, session });
        Ok(result)
    }

    pub fn shutdown(&self) {
        let Ok(mut session) = self.session.lock() else {
            return;
        };
        if let Some(active) = session.take() {
            active.session.stop();
        }
    }

    fn runtime_result(
        &self,
        config: &HostConfig,
        session: &proxy::RuntimeSession,
    ) -> Result<Value> {
        let browser_client_sha256 = config.browser_client_sha256()?;
        let codex_home = config.codex_home.clone().or_else(|| {
            env::var_os("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    env::var_os("HOME")
                        .map(std::path::PathBuf::from)
                        .map(|home| home.join(".codex"))
                })
        });
        let trusted_hashes = browser_client_sha256
            .as_ref()
            .map(|hash| vec![hash.clone()])
            .unwrap_or_default();
        let desktop_agent_mode_defaults = desktop_agent_mode::load(codex_home.as_deref());
        Ok(json!({
            "entryId": config.entry_id.as_deref().unwrap_or("linux-bundled"),
            "localAppServerUrl": session.url(),
            "runtimeSessionId": session.id(),
            "selected": {
                "appServerProtocolVersion": APP_SERVER_PROTOCOL_VERSION,
                "appVersion": config.app_version.clone().unwrap_or_else(|| env::var("CODEX_APP_VERSION").unwrap_or_else(|_| "linux".to_string())),
                "channel": config.channel.as_deref().unwrap_or("prod"),
                "cliVersion": config.cli_version.as_deref().unwrap_or("bundled"),
                "nativeHostProtocolVersion": NATIVE_HOST_PROTOCOL_VERSION,
                "nativeHostVersion": config.native_host_version.as_deref().unwrap_or(env!("CARGO_PKG_VERSION"))
            },
            "runtimeConfig": {
                "platform": "linux",
                "codexCliPath": config.codex_cli_path,
                "codexHome": codex_home,
                "desktopAgentModeDefaults": desktop_agent_mode_defaults,
                "nodePath": config.node_path,
                "nodeReplPath": config.node_repl_path,
                "nodeModuleDirs": config.node_module_dirs,
                "browserClientPath": config.browser_client_path,
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

fn parse_constraints(params: &Value) -> Result<ConfigRequest<'_>> {
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
    let required_string = |field| {
        constraints
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("missing {field}"))
    };
    Ok(ConfigRequest {
        extension_build_channel: required_string("extensionBuildChannel")?,
        extension_id: required_string("extensionId")?,
        native_host_name: required_string("nativeHostName")?,
    })
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
        path::{Path, PathBuf},
        thread,
        time::Duration,
        time::{SystemTime, UNIX_EPOCH},
    };

    const TEST_EXTENSION_ID: &str = "hehggadaopoacecdllhhajmbjkdcmajg";

    fn constraints(host: u64, server: u64) -> Value {
        json!({
            "constraints": {
                "extensionBuildChannel": "prod",
                "extensionId": TEST_EXTENSION_ID,
                "nativeHostName": crate::HOST_NAME,
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

    fn runtime_fixture() -> (PathBuf, Arc<HostConfigSource>, PathBuf) {
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
            app_version: None,
            browser_client_path: Some(cli.clone()),
            channel: Some("prod".to_string()),
            codex_cli_path: cli.clone(),
            codex_home: Some(root.clone()),
            cli_version: None,
            entry_id: None,
            extension_id: Some(TEST_EXTENSION_ID.to_string()),
            native_host_version: None,
            node_module_dirs: Vec::new(),
            node_path: cli.clone(),
            node_repl_path: Some(cli),
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 0,
            resources_path: None,
        });
        (
            root,
            Arc::new(HostConfigSource::fixed(Arc::unwrap_or_clone(config))),
            process_count,
        )
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

    fn write_managed_registry(path: &Path, root: &Path, cli: &Path, entry_id: &str) {
        let registry = json!({
            "schemaVersion": 2,
            "entries": [{
                "schemaVersion": 2,
                "appServerProtocolVersion": 2,
                "appVersion": "26.707.31123",
                "channel": "prod",
                "cliVersion": "0.140.0",
                "entryId": entry_id,
                "extensionBuildChannels": ["prod"],
                "extensionIds": [TEST_EXTENSION_ID],
                "nativeHostNames": [crate::HOST_NAME],
                "nativeHostProtocolVersion": 2,
                "nativeHostVersion": "26.707.31123",
                "paths": {
                    "browserClientPath": cli,
                    "codexCliPath": cli,
                    "codexHome": root,
                    "extensionHostPath": cli,
                    "nodePath": cli,
                    "nodeModuleDirs": [root],
                    "nodeReplPath": cli,
                    "resourcesPath": root
                },
                "proxyHost": "127.0.0.1",
                "proxyPort": 0,
                "updatedAt": "2026-07-09T21:42:12.025Z"
            }]
        });
        fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
    }

    #[test]
    fn accepts_only_protocol_v2_constraints() {
        parse_constraints(&constraints(2, 2)).unwrap();
        assert!(parse_constraints(&constraints(1, 2)).is_err());
        assert!(parse_constraints(&constraints(2, 3)).is_err());
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
        assert_eq!(
            first["runtimeConfig"]["desktopAgentModeDefaults"],
            json!({
                "agentModesByHostId": {},
                "preferredNonFullAccessModesByHostId": {}
            })
        );
        assert!(first["runtimeConfig"].get("browserClientSha256").is_none());
        assert_eq!(wait_for_process_count(&process_count, 1), "p\n");

        let restarted = manager.ensure(&full_params("window-2"), true).unwrap();
        assert_ne!(first["runtimeSessionId"], restarted["runtimeSessionId"]);
        assert_eq!(wait_for_process_count(&process_count, 2), "p\np\n");
        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_observes_registry_updates_and_replaces_the_runtime() {
        let (root, _fixed_source, process_count) = runtime_fixture();
        let cli = root.join("codex");
        let registry = root.join("chrome-native-hosts-v2.json");
        write_managed_registry(&registry, &root, &cli, "entry-a");
        let source = Arc::new(HostConfigSource::from_paths(
            cli.clone(),
            root.join("missing-adjacent.json"),
            vec![registry.clone()],
        ));
        let manager = RuntimeManager::new(source, TEST_EXTENSION_ID.to_string());

        let first = manager.ensure(&full_params("window-1"), false).unwrap();
        let unchanged = manager.ensure(&full_params("window-2"), false).unwrap();
        assert_eq!(first["runtimeSessionId"], unchanged["runtimeSessionId"]);
        assert_eq!(first["entryId"], "entry-a");
        assert_eq!(
            first["runtimeConfig"]["codexHome"],
            root.display().to_string()
        );
        assert_eq!(wait_for_process_count(&process_count, 1), "p\n");

        write_managed_registry(&registry, &root, &cli, "entry-b");
        let updated = manager.ensure(&full_params("window-2"), false).unwrap();
        assert_ne!(first["runtimeSessionId"], updated["runtimeSessionId"]);
        assert_eq!(updated["entryId"], "entry-b");
        assert_eq!(wait_for_process_count(&process_count, 2), "p\np\n");

        manager.shutdown();
        fs::remove_dir_all(root).unwrap();
    }
}
