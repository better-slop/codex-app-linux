use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const CONFIG_FILE_NAME: &str = "extension-host-config.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub schema_version: u64,
    #[serde(default)]
    pub browser_client_path: Option<PathBuf>,
    #[serde(default)]
    pub channel: Option<String>,
    pub codex_cli_path: PathBuf,
    #[serde(default)]
    pub extension_id: Option<String>,
    pub node_path: PathBuf,
    pub node_repl_path: PathBuf,
    #[serde(default = "default_proxy_host")]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
}

fn default_proxy_host() -> String {
    "127.0.0.1".to_string()
}

impl HostConfig {
    pub fn load_adjacent_to_current_exe() -> Result<Self> {
        let executable =
            env::current_exe().context("failed to locate extension host executable")?;
        let directory = executable
            .parent()
            .context("extension host executable has no parent directory")?;
        Self::load(&directory.join(CONFIG_FILE_NAME))
    }

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
        if self.proxy_host != "127.0.0.1"
            && self.proxy_host != "::1"
            && self.proxy_host != "localhost"
        {
            bail!(
                "proxyHost must resolve only to loopback; got {}",
                self.proxy_host
            );
        }
        validate_required_file(&self.codex_cli_path, "codexCliPath")?;
        validate_required_file(&self.node_path, "nodePath")?;
        validate_required_file(&self.node_repl_path, "nodeReplPath")?;
        if let Some(path) = &self.browser_client_path {
            validate_required_file(path, "browserClientPath")?;
        }
        Ok(())
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
            browser_client_path: None,
            channel: None,
            codex_cli_path: binary.clone(),
            extension_id: None,
            node_path: binary.clone(),
            node_repl_path: binary,
            proxy_host: "0.0.0.0".to_string(),
            proxy_port: 0,
        };
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("loopback")
        );
    }
}
