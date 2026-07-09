mod managed;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const CONFIG_FILE_NAME: &str = "extension-host-config.json";

/// The extension constraints used to select one desktop-managed Codex install.
#[derive(Clone, Copy, Debug)]
pub struct ConfigRequest<'a> {
    pub extension_build_channel: &'a str,
    pub extension_id: &'a str,
    pub native_host_name: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub schema_version: u64,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub browser_client_path: Option<PathBuf>,
    #[serde(default)]
    pub channel: Option<String>,
    pub codex_cli_path: PathBuf,
    #[serde(default)]
    pub codex_home: Option<PathBuf>,
    #[serde(default)]
    pub cli_version: Option<String>,
    #[serde(default)]
    pub entry_id: Option<String>,
    #[serde(default)]
    pub extension_id: Option<String>,
    #[serde(default)]
    pub native_host_version: Option<String>,
    #[serde(default)]
    pub node_module_dirs: Vec<PathBuf>,
    pub node_path: PathBuf,
    #[serde(default)]
    pub node_repl_path: Option<PathBuf>,
    #[serde(default = "default_proxy_host")]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub resources_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct HostConfigSource {
    kind: SourceKind,
}

#[derive(Clone, Debug)]
enum SourceKind {
    Files {
        adjacent_path: PathBuf,
        executable: PathBuf,
        registry_paths: Vec<PathBuf>,
    },
    #[cfg(test)]
    Fixed(Box<HostConfig>),
}

fn default_proxy_host() -> String {
    "127.0.0.1".to_string()
}

impl HostConfigSource {
    pub fn for_current_exe() -> Result<Self> {
        let executable =
            env::current_exe().context("failed to locate extension host executable")?;
        let directory = executable
            .parent()
            .context("extension host executable has no parent directory")?;
        Ok(Self {
            kind: SourceKind::Files {
                adjacent_path: directory.join(CONFIG_FILE_NAME),
                executable,
                registry_paths: managed::registry_paths(),
            },
        })
    }

    /// Resolve on every `ensure` request. The desktop rewrites registry-v2 at
    /// runtime, and the Darwin host observes those updates without restarting.
    pub fn resolve(&self, request: ConfigRequest<'_>) -> Result<HostConfig> {
        match &self.kind {
            SourceKind::Files {
                adjacent_path,
                executable,
                registry_paths,
            } => match managed::load(executable, registry_paths, request)? {
                Some(config) => Ok(config),
                None => {
                    if adjacent_path
                        .try_exists()
                        .with_context(|| format!("failed to inspect {}", adjacent_path.display()))?
                    {
                        let config = HostConfig::load(adjacent_path)?;
                        validate_installer_request(&config, request)?;
                        return Ok(config);
                    }
                    bail!("no compatible desktop-managed or adjacent Chrome host configuration")
                }
            },
            #[cfg(test)]
            SourceKind::Fixed(config) => {
                validate_installer_request(config, request)?;
                Ok((**config).clone())
            }
        }
    }

    /// Chrome passes the calling extension origin to native hosts. The
    /// adjacent installer config remains usable for direct host invocations.
    pub fn extension_id(&self, argument_id: Option<String>) -> Result<String> {
        if let Some(argument_id) = argument_id {
            return Ok(argument_id);
        }
        match &self.kind {
            SourceKind::Files { adjacent_path, .. } => HostConfig::load(adjacent_path)?
                .extension_id
                .context("extensionId is missing from config and Chrome arguments"),
            #[cfg(test)]
            SourceKind::Fixed(config) => config
                .extension_id
                .clone()
                .context("extensionId is missing from fixed config"),
        }
    }

    #[cfg(test)]
    pub(crate) fn fixed(config: HostConfig) -> Self {
        Self {
            kind: SourceKind::Fixed(Box::new(config)),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_paths(
        executable: PathBuf,
        adjacent_path: PathBuf,
        registry_paths: Vec<PathBuf>,
    ) -> Self {
        Self {
            kind: SourceKind::Files {
                adjacent_path,
                executable,
                registry_paths,
            },
        }
    }
}

impl HostConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
        let config: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!(
                "unsupported extension-host-config schema {}",
                self.schema_version
            );
        }
        validate_proxy_host(&self.proxy_host)?;
        validate_required_file(&self.codex_cli_path, "codexCliPath")?;
        validate_required_file(&self.node_path, "nodePath")?;
        if let Some(path) = &self.node_repl_path {
            validate_required_file(path, "nodeReplPath")?;
        }
        if let Some(path) = &self.browser_client_path {
            validate_required_file(path, "browserClientPath")?;
        }
        if let Some(path) = &self.codex_home {
            validate_required_directory(path, "codexHome")?;
        }
        if let Some(path) = &self.resources_path {
            validate_required_directory(path, "resourcesPath")?;
        }
        for path in &self.node_module_dirs {
            validate_required_directory(path, "nodeModuleDirs")?;
        }
        Ok(())
    }

    pub(super) fn validate_managed(&self) -> Result<()> {
        validate_proxy_host(&self.proxy_host)?;
        validate_required_file(&self.codex_cli_path, "codexCliPath")?;
        validate_required_file(&self.node_path, "nodePath")?;
        let codex_home = self
            .codex_home
            .as_deref()
            .context("managed config is missing codexHome")?;
        validate_required_directory(codex_home, "codexHome")?;
        let resources_path = self
            .resources_path
            .as_deref()
            .context("managed config is missing resourcesPath")?;
        validate_required_directory(resources_path, "resourcesPath")
    }

    pub fn browser_client_sha256(&self) -> Result<Option<String>> {
        let Some(path) = &self.browser_client_path else {
            return Ok(None);
        };
        let mut file = fs::File::open(path)
            .with_context(|| format!("failed to hash browser client {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .with_context(|| format!("failed to hash browser client {}", path.display()))?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let digest = hasher.finalize();
        Ok(Some(
            digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        ))
    }
}

fn validate_installer_request(config: &HostConfig, request: ConfigRequest<'_>) -> Result<()> {
    if let Some(extension_id) = config.extension_id.as_deref()
        && extension_id != request.extension_id
    {
        bail!("version_mismatch: extensionId does not match installer config");
    }
    if let Some(channel) = config.channel.as_deref()
        && channel != request.extension_build_channel
    {
        bail!("version_mismatch: extension build channel does not match installer config");
    }
    Ok(())
}

fn validate_proxy_host(proxy_host: &str) -> Result<()> {
    if proxy_host != "127.0.0.1" && proxy_host != "::1" && proxy_host != "localhost" {
        bail!("proxyHost must resolve only to loopback; got {proxy_host}");
    }
    Ok(())
}

fn validate_required_file(path: &Path, field: &str) -> Result<()> {
    if !path.is_absolute() {
        bail!("{field} must be an absolute path: {}", path.display());
    }
    let metadata = fs::metadata(path)
        .with_context(|| format!("required {field} is missing: {}", path.display()))?;
    if !metadata.is_file() {
        bail!("{field} is not a regular file: {}", path.display());
    }
    Ok(())
}

fn validate_required_directory(path: &Path, field: &str) -> Result<()> {
    if !path.is_absolute() {
        bail!("{field} must be an absolute path: {}", path.display());
    }
    let metadata = fs::metadata(path)
        .with_context(|| format!("required {field} is missing: {}", path.display()))?;
    if !metadata.is_dir() {
        bail!("{field} is not a directory: {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture() -> (PathBuf, PathBuf) {
        let root = env::temp_dir().join(format!(
            "codex-host-config-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let binary = root.join("binary");
        let mut file = fs::File::create(&binary).unwrap();
        file.write_all(b"browser client").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        (root, binary)
    }

    fn request<'a>(extension_id: &'a str) -> ConfigRequest<'a> {
        ConfigRequest {
            extension_build_channel: "prod",
            extension_id,
            native_host_name: crate::HOST_NAME,
        }
    }

    #[test]
    fn loads_installer_schema_and_hashes_browser_client() {
        let (root, binary) = fixture();
        let path = root.join(CONFIG_FILE_NAME);
        let config_json = serde_json::json!({
            "schemaVersion": 1,
            "browserClientPath": binary,
            "channel": "prod",
            "codexCliPath": binary,
            "extensionId": "hehggadaopoacecdllhhajmbjkdcmajg",
            "nodePath": binary,
            "nodeReplPath": binary,
            "proxyHost": "127.0.0.1",
            "proxyPort": 0
        });
        fs::write(&path, serde_json::to_vec(&config_json).unwrap()).unwrap();
        let config = HostConfig::load(&path).unwrap();
        assert_eq!(config.channel.as_deref(), Some("prod"));
        assert_eq!(config.browser_client_sha256().unwrap().unwrap().len(), 64);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_loopback_proxy() {
        let (_root, binary) = fixture();
        let config = HostConfig {
            schema_version: 1,
            app_version: None,
            browser_client_path: None,
            channel: None,
            codex_cli_path: binary.clone(),
            codex_home: None,
            cli_version: None,
            entry_id: None,
            extension_id: None,
            native_host_version: None,
            node_module_dirs: Vec::new(),
            node_path: binary.clone(),
            node_repl_path: Some(binary),
            proxy_host: "0.0.0.0".to_string(),
            proxy_port: 0,
            resources_path: None,
        };
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("loopback")
        );
    }

    #[test]
    fn falls_back_to_adjacent_installer_config() {
        let (root, binary) = fixture();
        let adjacent = root.join(CONFIG_FILE_NAME);
        let config_json = serde_json::json!({
            "schemaVersion": 1,
            "channel": "prod",
            "codexCliPath": binary,
            "extensionId": "hehggadaopoacecdllhhajmbjkdcmajg",
            "nodePath": binary,
            "nodeReplPath": binary
        });
        fs::write(&adjacent, serde_json::to_vec(&config_json).unwrap()).unwrap();
        let source = HostConfigSource::from_paths(
            binary.clone(),
            adjacent,
            vec![root.join("missing-registry.json")],
        );

        let config = source
            .resolve(request("hehggadaopoacecdllhhajmbjkdcmajg"))
            .unwrap();
        assert_eq!(config.codex_cli_path, binary);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_registry_takes_precedence_over_adjacent_config() {
        let (root, binary) = fixture();
        let adjacent = root.join(CONFIG_FILE_NAME);
        let registry_path = root.join("chrome-native-hosts-v2.json");
        let adjacent_json = serde_json::json!({
            "schemaVersion": 1,
            "channel": "prod",
            "codexCliPath": binary,
            "extensionId": "hehggadaopoacecdllhhajmbjkdcmajg",
            "nodePath": binary,
            "nodeReplPath": binary
        });
        fs::write(&adjacent, serde_json::to_vec(&adjacent_json).unwrap()).unwrap();
        let registry = serde_json::json!({
            "schemaVersion": 2,
            "entries": [{
                "schemaVersion": 2,
                "appServerProtocolVersion": 2,
                "appVersion": "26.707.31123",
                "channel": "prod",
                "cliVersion": "0.140.0",
                "entryId": "managed-entry",
                "extensionBuildChannels": ["prod"],
                "extensionIds": ["hehggadaopoacecdllhhajmbjkdcmajg"],
                "nativeHostNames": [crate::HOST_NAME],
                "nativeHostProtocolVersion": 2,
                "nativeHostVersion": "26.707.31123",
                "paths": {
                    "codexCliPath": binary,
                    "codexHome": root,
                    "extensionHostPath": binary,
                    "nodePath": binary,
                    "resourcesPath": root
                },
                "updatedAt": "2026-07-09T21:42:12.025Z"
            }]
        });
        fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        let source = HostConfigSource::from_paths(binary, adjacent, vec![registry_path]);

        let config = source
            .resolve(request("hehggadaopoacecdllhhajmbjkdcmajg"))
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("managed-entry"));
        fs::remove_dir_all(root).unwrap();
    }
}
