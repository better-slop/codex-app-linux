use serde_json::{Map, Value, json};
use std::{fs::File, io::Read, path::Path};

const GLOBAL_STATE_FILE: &str = ".codex-global-state.json";
const PERSISTED_ATOMS_KEY: &str = "electron-persisted-atom-state";
const LEGACY_AGENT_MODES_KEY: &str = "agent-mode-by-host-id";
const LEGACY_NON_FULL_ACCESS_MODES_KEY: &str = "preferred-non-full-access-agent-mode-by-host-id";
const MAX_GLOBAL_STATE_BYTES: usize = 8 * 1024 * 1024;

/// Mirror the Darwin host's bridge from desktop persisted atoms to the
/// canonical extension runtime shape. The extension validates individual mode
/// values; the host only carries the two persisted maps across process bounds.
pub(super) fn load(codex_home: Option<&Path>) -> Value {
    let Some(codex_home) = codex_home else {
        return defaults();
    };
    let Ok(file) = File::open(codex_home.join(GLOBAL_STATE_FILE)) else {
        return defaults();
    };
    let mut bytes = Vec::new();
    if file
        .take((MAX_GLOBAL_STATE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_GLOBAL_STATE_BYTES
    {
        return defaults();
    }
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return defaults();
    };
    let Some(atoms) = root.get(PERSISTED_ATOMS_KEY).and_then(Value::as_object) else {
        return defaults();
    };

    json!({
        "agentModesByHostId": object_value(atoms.get(LEGACY_AGENT_MODES_KEY)),
        "preferredNonFullAccessModesByHostId": object_value(
            atoms.get(LEGACY_NON_FULL_ACCESS_MODES_KEY)
        )
    })
}

fn object_value(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_object)
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn defaults() -> Value {
    json!({
        "agentModesByHostId": {},
        "preferredNonFullAccessModesByHostId": {}
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "codex-desktop-agent-mode-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn missing_and_malformed_state_use_canonical_empty_maps() {
        let root = fixture("defaults");
        assert_eq!(load(Some(&root)), defaults());

        fs::write(root.join(GLOBAL_STATE_FILE), b"not json").unwrap();
        assert_eq!(load(Some(&root)), defaults());

        fs::write(
            root.join(GLOBAL_STATE_FILE),
            serde_json::to_vec(&json!({PERSISTED_ATOMS_KEY: []})).unwrap(),
        )
        .unwrap();
        assert_eq!(load(Some(&root)), defaults());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_desktop_maps_are_emitted_under_canonical_keys() {
        let root = fixture("legacy");
        fs::write(
            root.join(GLOBAL_STATE_FILE),
            serde_json::to_vec(&json!({
                PERSISTED_ATOMS_KEY: {
                    LEGACY_AGENT_MODES_KEY: {
                        "local": "full-access",
                        "remote": "read-only"
                    },
                    LEGACY_NON_FULL_ACCESS_MODES_KEY: {"local": "auto"},
                    "agentModesByHostId": {"ignored": "custom"}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            load(Some(&root)),
            json!({
                "agentModesByHostId": {
                    "local": "full-access",
                    "remote": "read-only"
                },
                "preferredNonFullAccessModesByHostId": {"local": "auto"}
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn non_object_maps_and_oversized_state_use_empty_maps() {
        let root = fixture("bounded");
        fs::write(
            root.join(GLOBAL_STATE_FILE),
            serde_json::to_vec(&json!({
                PERSISTED_ATOMS_KEY: {
                    LEGACY_AGENT_MODES_KEY: [],
                    LEGACY_NON_FULL_ACCESS_MODES_KEY: null
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(load(Some(&root)), defaults());

        fs::write(
            root.join(GLOBAL_STATE_FILE),
            vec![b' '; MAX_GLOBAL_STATE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(load(Some(&root)), defaults());
        fs::remove_dir_all(root).unwrap();
    }
}
