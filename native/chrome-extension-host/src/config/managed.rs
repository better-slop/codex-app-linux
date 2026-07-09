use super::{ConfigRequest, HostConfig, default_proxy_host};
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

const FILE_NAME: &str = "chrome-native-hosts-v2.json";
const SCHEMA_VERSION: u64 = 2;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    schema_version: u64,
    entries: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    app_version: String,
    channel: String,
    cli_version: String,
    entry_id: String,
    native_host_version: String,
    paths: EntryPaths,
    #[serde(default = "default_proxy_host")]
    proxy_host: String,
    #[serde(default)]
    proxy_port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryPaths {
    #[serde(default)]
    browser_client_path: Option<PathBuf>,
    codex_cli_path: PathBuf,
    codex_home: PathBuf,
    node_path: PathBuf,
    #[serde(default)]
    node_module_dirs: Vec<PathBuf>,
    #[serde(default)]
    node_repl_path: Option<PathBuf>,
    resources_path: PathBuf,
}

#[derive(Debug)]
struct RankedRaw {
    entry_id: String,
    score: u64,
    updated_at: String,
    value: Value,
}

pub(super) fn load(
    executable: &Path,
    registry_paths: &[PathBuf],
    request: ConfigRequest<'_>,
) -> Result<Option<HostConfig>> {
    let executable = fs::canonicalize(executable).with_context(|| {
        format!(
            "failed to resolve extension host executable {}",
            executable.display()
        )
    })?;
    let mut registries_found = 0_usize;
    let mut first_registry_error = None;
    let mut candidates = Vec::<RankedRaw>::new();

    for registry_path in registry_paths {
        let bytes = match fs::read(registry_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                first_registry_error.get_or_insert_with(|| {
                    anyhow::Error::new(error)
                        .context(format!("failed to read {}", registry_path.display()))
                });
                continue;
            }
        };
        registries_found += 1;
        let registry: Registry = match serde_json::from_slice(&bytes) {
            Ok(registry) => registry,
            Err(error) => {
                first_registry_error.get_or_insert_with(|| {
                    anyhow::Error::new(error)
                        .context(format!("failed to parse {}", registry_path.display()))
                });
                continue;
            }
        };
        if registry.schema_version != SCHEMA_VERSION {
            first_registry_error.get_or_insert_with(|| {
                anyhow::anyhow!(
                    "unsupported managed Chrome host registry schema {} in {}",
                    registry.schema_version,
                    registry_path.display()
                )
            });
            continue;
        }

        // Rank raw JSON first; only the Darwin-compatible winner must fully deserialize.
        for value in registry.entries {
            if let Some(candidate) = rank_raw(value, &executable, request) {
                candidates.push(candidate);
            }
        }
    }

    if registries_found == 0 {
        if let Some(error) = first_registry_error {
            return Err(error);
        }
        return Ok(None);
    }
    let Some(candidate) = candidates.into_iter().max_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.updated_at.cmp(&right.updated_at))
            .then_with(|| left.entry_id.cmp(&right.entry_id))
    }) else {
        if let Some(error) = first_registry_error {
            return Err(error);
        }
        return Ok(None);
    };
    let entry: Entry = serde_json::from_value(candidate.value)
        .context("matching managed Chrome host entry is malformed")?;
    let config = entry.into_host_config(request.extension_id);
    config.validate_managed()?;
    Ok(Some(config))
}

pub(super) fn registry_paths() -> Vec<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let state_root = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|path| path.join(".local/state")));
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|path| path.join(".codex")));
    let mut paths = Vec::new();
    if let Some(root) = state_root {
        paths.push(root.join("openai-codex").join(FILE_NAME));
    }
    if let Some(root) = codex_home {
        let path = root.join(FILE_NAME);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

impl Entry {
    fn into_host_config(self, extension_id: &str) -> HostConfig {
        HostConfig {
            schema_version: 1,
            app_version: Some(self.app_version),
            browser_client_path: self.paths.browser_client_path,
            channel: Some(self.channel),
            codex_cli_path: self.paths.codex_cli_path,
            codex_home: Some(self.paths.codex_home),
            cli_version: Some(self.cli_version),
            entry_id: Some(self.entry_id),
            extension_id: Some(extension_id.to_string()),
            native_host_version: Some(self.native_host_version),
            node_module_dirs: self.paths.node_module_dirs,
            node_path: self.paths.node_path,
            node_repl_path: self.paths.node_repl_path,
            proxy_host: self.proxy_host,
            proxy_port: self.proxy_port,
            resources_path: Some(self.paths.resources_path),
        }
    }
}

fn rank_raw(value: Value, executable: &Path, request: ConfigRequest<'_>) -> Option<RankedRaw> {
    if value.get("schemaVersion")?.as_u64()? != SCHEMA_VERSION
        || value.get("appServerProtocolVersion")?.as_u64()? != crate::APP_SERVER_PROTOCOL_VERSION
        || value.get("nativeHostProtocolVersion")?.as_u64()? != crate::NATIVE_HOST_PROTOCOL_VERSION
    {
        return None;
    }
    let paths = value.get("paths")?;
    let required_file = |field| {
        Path::new(paths.get(field)?.as_str()?)
            .is_file()
            .then_some(())
    };
    let required_directory = |field| {
        Path::new(paths.get(field)?.as_str()?)
            .is_dir()
            .then_some(())
    };
    required_file("codexCliPath")?;
    required_directory("codexHome")?;
    required_file("nodePath")?;
    required_directory("resourcesPath")?;

    let array_contains = |field: &str, expected: &str| {
        value
            .get(field)
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
    };
    // Exact Darwin precedence: executable +100, host +50, extension +25,
    // channel +10, positive presence PID +1; updatedAt breaks score ties.
    let mut score = 0_u64;
    if paths
        .get("extensionHostPath")
        .and_then(Value::as_str)
        .is_some_and(|path| paths_match(Path::new(path), executable))
    {
        score += 100;
    }
    if array_contains("nativeHostNames", request.native_host_name) {
        score += 50;
    }
    if array_contains("extensionIds", request.extension_id) {
        score += 25;
    }
    if array_contains("extensionBuildChannels", request.extension_build_channel) {
        score += 10;
    }
    if value
        .pointer("/presence/pid")
        .and_then(Value::as_u64)
        .is_some_and(|pid| pid > 0)
    {
        score += 1;
    }
    Some(RankedRaw {
        entry_id: value
            .get("entryId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        score,
        updated_at: value
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        value,
    })
}

fn paths_match(candidate: &Path, executable: &Path) -> bool {
    candidate == executable
        || fs::canonicalize(candidate).is_ok_and(|resolved| resolved == executable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        time::{SystemTime, UNIX_EPOCH},
    };

    const EXTENSION_ID: &str = "hehggadaopoacecdllhhajmbjkdcmajg";

    fn fixture() -> (PathBuf, PathBuf) {
        let root = env::temp_dir().join(format!(
            "codex-managed-config-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let binary = root.join("extension-host");
        fs::write(&binary, b"host").unwrap();
        (root, binary)
    }

    fn request<'a>(extension_id: &'a str) -> ConfigRequest<'a> {
        ConfigRequest {
            extension_build_channel: "prod",
            extension_id,
            native_host_name: crate::HOST_NAME,
        }
    }

    fn entry(root: &Path, host: &Path, extension_id: &str) -> Value {
        serde_json::json!({
            "schemaVersion": 2,
            "appServerProtocolVersion": 2,
            "appVersion": "26.707.31123",
            "channel": "prod",
            "cliVersion": "0.140.0",
            "entryId": "managed-test-entry",
            "extensionBuildChannels": ["prod"],
            "extensionIds": [extension_id],
            "nativeHostNames": [crate::HOST_NAME],
            "nativeHostProtocolVersion": 2,
            "nativeHostVersion": "26.707.31123",
            "paths": {
                "browserClientPath": host,
                "codexCliPath": host,
                "codexHome": root,
                "extensionHostPath": host,
                "nodePath": host,
                "nodeModuleDirs": [root],
                "nodeReplPath": host,
                "resourcesPath": root
            },
            "presence": {"pid": 42},
            "proxyHost": "127.0.0.1",
            "proxyPort": 0,
            "updatedAt": "2026-07-09T21:42:12.025Z"
        })
    }

    fn write_registry(path: &Path, entries: Vec<Value>) {
        fs::write(
            path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 2,
                "entries": entries
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn loads_desktop_managed_registry_for_current_host() {
        let (root, binary) = fixture();
        let registry_path = root.join(FILE_NAME);
        write_registry(&registry_path, vec![entry(&root, &binary, EXTENSION_ID)]);

        let config = load(&binary, &[registry_path], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("managed-test-entry"));
        assert_eq!(config.app_version.as_deref(), Some("26.707.31123"));
        assert_eq!(config.cli_version.as_deref(), Some("0.140.0"));
        assert_eq!(config.codex_home.as_deref(), Some(root.as_path()));
        assert_eq!(config.node_module_dirs, vec![root.clone()]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scores_identity_matches_and_uses_newest_tie() {
        let (root, binary) = fixture();
        let registry_path = root.join(FILE_NAME);
        let other_binary = root.join("other-host");
        fs::write(&other_binary, b"other").unwrap();
        let mut lower_score = entry(&root, &other_binary, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        lower_score["entryId"] = serde_json::json!("newer-but-unmatched");
        lower_score["updatedAt"] = serde_json::json!("2027-01-01T00:00:00.000Z");
        let mut newest_tie = entry(&root, &binary, EXTENSION_ID);
        newest_tie["entryId"] = serde_json::json!("newest-tie");
        newest_tie["updatedAt"] = serde_json::json!("2026-07-10T00:00:00.000Z");
        write_registry(
            &registry_path,
            vec![entry(&root, &binary, EXTENSION_ID), lower_score, newest_tie],
        );

        let config = load(&binary, &[registry_path], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("newest-tie"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn request_channel_selects_the_matching_build() {
        let (root, binary) = fixture();
        let registry_path = root.join(FILE_NAME);
        let prod = entry(&root, &binary, EXTENSION_ID);
        let mut dev = entry(&root, &binary, EXTENSION_ID);
        dev["entryId"] = serde_json::json!("dev-entry");
        dev["channel"] = serde_json::json!("dev");
        dev["extensionBuildChannels"] = serde_json::json!(["dev"]);
        dev["updatedAt"] = serde_json::json!("2027-01-01T00:00:00.000Z");
        write_registry(&registry_path, vec![dev, prod]);

        let config = load(&binary, &[registry_path], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("managed-test-entry"));
        assert_eq!(config.channel.as_deref(), Some("prod"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tolerates_malformed_and_missing_path_entries() {
        let (root, binary) = fixture();
        let registry_path = root.join(FILE_NAME);
        let mut missing_path = entry(&root, &binary, EXTENSION_ID);
        missing_path["entryId"] = serde_json::json!("missing-path");
        missing_path["paths"]["codexCliPath"] = serde_json::json!(root.join("missing"));
        write_registry(
            &registry_path,
            vec![
                serde_json::json!({"broken": true}),
                missing_path,
                entry(&root, &binary, EXTENSION_ID),
            ],
        );

        let config = load(&binary, &[registry_path], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("managed-test-entry"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_executable_match_outranks_newer_identity_only_entry() {
        let (root, binary) = fixture();
        let symlink_path = root.join("latest-host");
        symlink(&binary, &symlink_path).unwrap();
        let registry_path = root.join(FILE_NAME);
        let mut canonical_match = entry(&root, &symlink_path, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        canonical_match["entryId"] = serde_json::json!("canonical-match");
        let mut identity_only = entry(&root, &root.join("other"), EXTENSION_ID);
        identity_only["entryId"] = serde_json::json!("identity-only");
        identity_only["updatedAt"] = serde_json::json!("2027-01-01T00:00:00.000Z");
        write_registry(&registry_path, vec![identity_only, canonical_match]);

        let config = load(&binary, &[registry_path], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("canonical-match"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn excludes_protocol_mismatch_and_uses_newest_registry_copy() {
        let (root, binary) = fixture();
        let global = root.join("global.json");
        let codex = root.join("codex.json");
        let mut incompatible = entry(&root, &binary, EXTENSION_ID);
        incompatible["entryId"] = serde_json::json!("incompatible");
        incompatible["nativeHostProtocolVersion"] = serde_json::json!(3);
        let mut older = entry(&root, &binary, EXTENSION_ID);
        older["updatedAt"] = serde_json::json!("2025-01-01T00:00:00.000Z");
        write_registry(&global, vec![incompatible, older]);
        write_registry(&codex, vec![entry(&root, &binary, EXTENSION_ID)]);

        let config = load(&binary, &[global, codex], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.app_version.as_deref(), Some("26.707.31123"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_malformed_highest_ranked_entry() {
        let (root, binary) = fixture();
        let registry_path = root.join(FILE_NAME);
        let other_binary = root.join("other-host");
        fs::write(&other_binary, b"other").unwrap();
        let valid_lower_score = entry(&root, &other_binary, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut malformed_winner = entry(&root, &binary, EXTENSION_ID);
        malformed_winner
            .as_object_mut()
            .unwrap()
            .remove("appVersion");
        write_registry(&registry_path, vec![valid_lower_score, malformed_winner]);

        let error = load(&binary, &[registry_path], request(EXTENSION_ID)).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("matching managed Chrome host entry is malformed")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_registry_copy_does_not_mask_a_valid_copy() {
        let (root, binary) = fixture();
        let malformed = root.join("malformed.json");
        let valid = root.join("valid.json");
        fs::write(&malformed, b"not json").unwrap();
        write_registry(&valid, vec![entry(&root, &binary, EXTENSION_ID)]);

        let config = load(&binary, &[malformed, valid], request(EXTENSION_ID))
            .unwrap()
            .unwrap();

        assert_eq!(config.entry_id.as_deref(), Some("managed-test-entry"));
        fs::remove_dir_all(root).unwrap();
    }
}
