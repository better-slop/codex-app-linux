use anyhow::{Context, Result, bail};
use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

pub fn open_local_file(path: &Path) -> Result<()> {
    let validated = validate_local_file(path)?;
    let mut child = Command::new("xdg-open")
        .arg(&validated)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to run xdg-open for {}", validated.display()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn validate_local_file(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("local file path must be absolute");
    }
    if path.as_os_str().as_bytes().contains(&0) {
        bail!("local file path contains a NUL byte");
    }
    if executable_like_extension(path) {
        bail!("refusing to open an executable-like local file");
    }
    reject_symlink_components(path)?;
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("local file must be a regular non-symlink file");
    }
    if metadata.permissions().mode() & 0o111 != 0 {
        bail!("refusing to open an executable local file");
    }
    path.canonicalize()
        .with_context(|| format!("failed to canonicalize {}", path.display()))
}

fn executable_like_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "command" | "desktop" | "jar" | "terminal" | "tool"
            )
        })
}

fn reject_symlink_components(path: &Path) -> Result<()> {
    let mut current = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(part) => current.push(part),
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                bail!("local file path is not normalized")
            }
        }
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("failed to stat {}", current.display()))?;
        if metadata.file_type().is_symlink() {
            bail!("local file path contains a symlink: {}", current.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        os::unix::fs::symlink,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture() -> PathBuf {
        let root = env::temp_dir().join(format!(
            "codex-host-open-file-{}-{}",
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
    fn accepts_plain_non_executable_regular_file() {
        let root = fixture();
        let path = root.join("report.txt");
        fs::write(&path, "safe").unwrap();
        assert_eq!(validate_local_file(&path).unwrap(), path);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relative_symlink_directory_and_executable() {
        let root = fixture();
        let file = root.join("target.txt");
        fs::write(&file, "safe").unwrap();
        assert!(validate_local_file(Path::new("target.txt")).is_err());
        let link = root.join("link.txt");
        symlink(&file, &link).unwrap();
        assert!(validate_local_file(&link).is_err());
        assert!(validate_local_file(&root).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_local_file(&file).is_err());
        let desktop = root.join("launch.Desktop");
        fs::write(&desktop, "[Desktop Entry]").unwrap();
        assert!(validate_local_file(&desktop).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
