use anyhow::{Context, Result, bail};
use std::{
    env, fs, io,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

pub const SOCKET_DIR_ENV: &str = "CODEX_BROWSER_USE_SOCKET_DIR";
pub const DEFAULT_SOCKET_DIR: &str = "/tmp/codex-browser-use";

pub struct SocketGuard {
    path: PathBuf,
}

impl SocketGuard {
    pub fn bind() -> Result<(UnixListener, Self)> {
        Self::bind_in(&socket_dir())
    }

    pub fn bind_in(directory: &Path) -> Result<(UnixListener, Self)> {
        prepare_socket_dir(directory)?;
        let path = socket_path(directory);
        let listener = UnixListener::bind(&path)
            .with_context(|| format!("failed to bind {}", path.display()))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to chmod {}", path.display()))?;
        Ok((listener, Self { path }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            crate::log(format_args!(
                "failed to remove socket {}: {error}",
                self.path.display()
            ));
        }
    }
}

pub fn socket_dir() -> PathBuf {
    env::var_os(SOCKET_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_DIR))
}

pub fn prepare_socket_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "socket directory is not a real directory: {}",
            path.display()
        );
    }
    let effective_uid = unsafe { libc::geteuid() };
    if metadata.uid() != effective_uid {
        bail!(
            "socket directory is owned by uid {}, expected {effective_uid}: {}",
            metadata.uid(),
            path.display()
        );
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("failed to chmod {}", path.display()))?;
    }
    Ok(())
}

pub fn authorize_peer(stream: &UnixStream) -> Result<()> {
    let credentials = peer_credentials(stream)?;
    let effective_uid = unsafe { libc::geteuid() };
    if credentials.uid != effective_uid {
        bail!(
            "rejecting peer pid {} uid {}, expected uid {effective_uid}",
            credentials.pid,
            credentials.uid
        );
    }
    Ok(())
}

pub fn peer_credentials(stream: &UnixStream) -> Result<libc::ucred> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let expected = std::mem::size_of::<libc::ucred>();
    let mut length = expected as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error()).context("failed to read peer credentials");
    }
    if length as usize != expected {
        bail!("SO_PEERCRED returned {} bytes; expected {expected}", length);
    }
    if credentials.pid <= 0 {
        bail!("SO_PEERCRED returned invalid pid {}", credentials.pid);
    }
    Ok(credentials)
}

fn socket_path(directory: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    directory.join(format!("extension-{}-{nonce}.sock", process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_directory(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{label}-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn socket_and_directory_are_private_and_removed_on_drop() {
        let directory = unique_directory("codex-host-socket");
        let (_listener, guard) = SocketGuard::bind_in(&directory).unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(guard.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let path = guard.path().to_path_buf();
        drop(guard);
        assert!(!path.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unix_pair_has_same_uid_credentials() {
        let (left, _right) = UnixStream::pair().unwrap();
        let credentials = peer_credentials(&left).unwrap();
        assert_eq!(credentials.uid, unsafe { libc::geteuid() });
        authorize_peer(&left).unwrap();
    }
}
