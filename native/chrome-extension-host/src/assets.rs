use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

const MAX_ACTIVE_ASSETS: usize = 16;
const MAX_ASSET_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILE_NAME_BYTES: usize = 200;
const FALLBACK_FILE_NAME: &str = "tab-context.txt";

struct Asset {
    file: Option<File>,
    path: PathBuf,
    bytes: u64,
}

pub struct AssetStore {
    root: PathBuf,
    active: HashMap<String, Asset>,
    total_bytes: u64,
}

impl AssetStore {
    pub fn from_environment() -> Result<Self> {
        Self::new(env::temp_dir().join("codex-tab-context-assets"))
    }

    pub fn new(root: PathBuf) -> Result<Self> {
        prepare_root(&root)?;
        Ok(Self {
            root,
            active: HashMap::new(),
            total_bytes: 0,
        })
    }

    pub fn create(&mut self, file_name: &str) -> Result<Value> {
        if self.active.len() >= MAX_ACTIVE_ASSETS {
            bail!("Too many active Chrome tab context assets");
        }
        let safe_name = safe_file_name(file_name);
        for _ in 0..8 {
            let asset_id = random_hex(16)?;
            let path = self.root.join(format!("{asset_id}-{safe_name}"));
            let file = match OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to create {}", path.display()));
                }
            };
            self.active.insert(
                asset_id.clone(),
                Asset {
                    file: Some(file),
                    path: path.clone(),
                    bytes: 0,
                },
            );
            return Ok(json!({"assetId": asset_id, "path": path}));
        }
        bail!("failed to allocate a unique tab context asset")
    }

    pub fn append_chunk(&mut self, asset_id: &str, data_base64: &str) -> Result<Value> {
        let estimated = data_base64.len().div_ceil(4).saturating_mul(3);
        if estimated > MAX_CHUNK_BYTES {
            bail!("Chrome tab context asset chunk is too large");
        }
        let bytes = STANDARD
            .decode(data_base64)
            .context("dataBase64 is not valid base64")?;
        if bytes.len() > MAX_CHUNK_BYTES {
            bail!("Chrome tab context asset chunk is too large");
        }
        let asset = self
            .active
            .get_mut(asset_id)
            .context("Chrome tab context asset was not found")?;
        let next_asset_bytes = asset.bytes.saturating_add(bytes.len() as u64);
        let next_total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);
        if next_asset_bytes > MAX_ASSET_BYTES || next_total_bytes > MAX_TOTAL_BYTES {
            bail!("Chrome tab context asset is too large");
        }
        let file = asset
            .file
            .as_mut()
            .context("Chrome tab context asset is already finished")?;
        file.write_all(&bytes)
            .with_context(|| format!("failed to append {}", asset.path.display()))?;
        asset.bytes = next_asset_bytes;
        self.total_bytes = next_total_bytes;
        Ok(json!({}))
    }

    pub fn finish(&mut self, asset_id: &str) -> Result<Value> {
        let asset = self
            .active
            .get_mut(asset_id)
            .context("Chrome tab context asset was not found")?;
        if let Some(file) = asset.file.take() {
            file.sync_all()
                .with_context(|| format!("failed to flush {}", asset.path.display()))?;
        }
        Ok(json!({"assetId": asset_id, "path": asset.path}))
    }

    pub fn abort(&mut self, asset_id: &str) -> Result<Value> {
        self.remove_asset(asset_id)?;
        Ok(json!({}))
    }

    pub fn remove(&mut self, asset_id: &str) -> Result<Value> {
        self.remove_asset(asset_id)?;
        Ok(json!({}))
    }

    fn remove_asset(&mut self, asset_id: &str) -> Result<()> {
        let Some(asset) = self.active.remove(asset_id) else {
            return Ok(());
        };
        self.total_bytes = self.total_bytes.saturating_sub(asset.bytes);
        drop(asset.file);
        fs::remove_file(&asset.path)
            .with_context(|| format!("failed to remove {}", asset.path.display()))
    }
}

impl Drop for AssetStore {
    fn drop(&mut self) {
        for (_, asset) in self.active.drain() {
            drop(asset.file);
            if let Err(error) = fs::remove_file(&asset.path) {
                crate::log(format_args!(
                    "failed to clean tab context asset {}: {error}",
                    asset.path.display()
                ));
            }
        }
    }
}

fn prepare_root(root: &Path) -> Result<()> {
    fs::create_dir_all(root).with_context(|| format!("failed to create {}", root.display()))?;
    let metadata =
        fs::symlink_metadata(root).with_context(|| format!("failed to stat {}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("asset root is not a real directory: {}", root.display());
    }
    let effective_uid = unsafe { libc::geteuid() };
    if metadata.uid() != effective_uid {
        bail!(
            "asset root is owned by uid {}, expected {effective_uid}: {}",
            metadata.uid(),
            root.display()
        );
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to chmod {}", root.display()))
}

fn safe_file_name(file_name: &str) -> String {
    let candidate = file_name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned = candidate
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || matches!(cleaned, "." | "..") {
        return FALLBACK_FILE_NAME.to_string();
    }
    if cleaned.len() <= MAX_FILE_NAME_BYTES {
        return cleaned.to_string();
    }

    let extension = Path::new(cleaned)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty() && extension.len() <= 32);
    if let Some(extension) = extension {
        let suffix = format!(".{extension}");
        let stem = cleaned.strip_suffix(&suffix).unwrap_or(cleaned);
        let stem = truncate_utf8(stem, MAX_FILE_NAME_BYTES - suffix.len());
        if !stem.is_empty() {
            return format!("{stem}{suffix}");
        }
    }
    truncate_utf8(cleaned, MAX_FILE_NAME_BYTES).to_string()
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> &str {
    let mut end = value.len().min(maximum_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn random_hex(bytes: usize) -> Result<String> {
    let mut random = vec![0_u8; bytes];
    File::open("/dev/urandom")
        .context("failed to open /dev/urandom")?
        .read_exact(&mut random)
        .context("failed to read /dev/urandom")?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn store() -> AssetStore {
        let root = env::temp_dir().join(format!(
            "codex-host-assets-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        AssetStore::new(root).unwrap()
    }

    #[test]
    fn create_append_finish_and_remove_round_trip() {
        let mut store = store();
        let created = store.create("tab-context.txt").unwrap();
        let id = created["assetId"].as_str().unwrap();
        let path = PathBuf::from(created["path"].as_str().unwrap());
        store
            .append_chunk(id, &STANDARD.encode(b"hello browser"))
            .unwrap();
        let finished = store.finish(id).unwrap();
        let finished_again = store.finish(id).unwrap();
        assert_eq!(finished["path"], created["path"]);
        assert_eq!(finished_again, finished);
        assert_eq!(fs::read(&path).unwrap(), b"hello browser");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        store.remove(id).unwrap();
        store.remove(id).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rejects_traversal_and_oversized_chunk() {
        let mut store = store();
        let stripped = store.create("../safe-name.txt").unwrap();
        assert!(
            Path::new(stripped["path"].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-safe-name.txt")
        );
        let windows = store.create(r"C:\temp\windows-name.txt").unwrap();
        assert!(
            Path::new(windows["path"].as_str().unwrap())
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-windows-name.txt")
        );
        let created = store.create("safe.txt").unwrap();
        let id = created["assetId"].as_str().unwrap();
        let oversized = STANDARD.encode(vec![0_u8; MAX_CHUNK_BYTES + 1]);
        assert!(store.append_chunk(id, &oversized).is_err());
    }

    #[test]
    fn unsafe_empty_names_fall_back_and_long_utf8_names_preserve_extension() {
        let mut store = store();
        for unsafe_name in ["", "../", ".", "..", "\0\n"] {
            let created = store.create(unsafe_name).unwrap();
            assert!(
                Path::new(created["path"].as_str().unwrap())
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with("-tab-context.txt")
            );
        }

        let long_name = format!("{}.snapshot.json", "🦀".repeat(100));
        let created = store.create(&long_name).unwrap();
        let file_name = Path::new(created["path"].as_str().unwrap())
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        let normalized = file_name.split_once('-').unwrap().1;
        assert!(normalized.len() <= 200);
        assert!(normalized.ends_with(".json"));
        assert!(normalized.is_char_boundary(normalized.len()));
    }
}
