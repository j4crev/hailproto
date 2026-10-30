use crate::contract::Error;
use std::{
    fs::{File, OpenOptions},
    io::{IsTerminal, Read, Write},
    path::Path,
};
use zeroize::Zeroizing;

pub fn read(path: &str, limit: usize) -> Result<Vec<u8>, Error> {
    let invalid = || Error::client("Client files must be bounded private mode-0600 regular files");
    let before = std::fs::metadata(path).map_err(|_| invalid())?;
    if !before.is_file() {
        return Err(invalid());
    }
    let file = File::open(path).map_err(|_| invalid())?;
    let info = file.metadata().map_err(|_| invalid())?;
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::PermissionsExt;
        info.permissions().mode() & 0o077 == 0
    };
    #[cfg(not(unix))]
    let private = false;
    if !info.is_file() || info.len() == 0 || info.len() > limit as u64 || !private {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.is_empty() || bytes.len() > limit {
        return Err(invalid());
    }
    Ok(bytes)
}
pub fn create(path: &str, bytes: &[u8]) -> Result<(), Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    return Err(Error::client(
        "Private output is currently supported only on Unix",
    ));
    let mut file = options.open(path).map_err(|_| {
        Error::client("Cannot create private output; destination must not already exist")
    })?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(Error::client("Cannot save private output"));
    }
    Ok(())
}
pub fn private_parent(path: &str) -> Result<(), Error> {
    let parent = Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let info = std::fs::metadata(parent)
        .map_err(|_| Error::client("Cannot inspect vault destination directory"))?;
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::PermissionsExt;
        info.permissions().mode() & 0o077 == 0
    };
    #[cfg(not(unix))]
    let private = false;
    if !info.is_dir() || !private {
        return Err(Error::client(
            "Vault destination directory must be private mode 0700",
        ));
    }
    Ok(())
}
pub fn recovery_secret() -> Result<Zeroizing<Vec<u8>>, Error> {
    let text = if std::io::stdin().is_terminal() {
        eprint!("Recovery secret (hidden): ");
        let value = rpassword::read_password()
            .map_err(|_| Error::client("Recovery input was cancelled"))?;
        eprintln!();
        Zeroizing::new(value)
    } else {
        let mut value = Zeroizing::new(String::new());
        std::io::stdin()
            .take(1025)
            .read_to_string(&mut value)
            .map_err(|_| Error::client("Invalid recovery input"))?;
        if value.len() > 1024 {
            return Err(Error::client("Recovery input is too long"));
        }
        value
    };
    let bytes = Zeroizing::new(crate::codec::decode_base64(text.trim())?);
    if bytes.len() != 32 {
        return Err(Error::client(
            "Vault recovery secret must be exactly 256 bits",
        ));
    }
    Ok(bytes)
}

// Replace only reviewed retry state, via a private new sibling and atomic rename.
pub fn replace(path: &str, value: &serde_json::Value) -> Result<(), Error> {
    use base64::Engine;
    let suffix = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(crate::crypto::random::<16>()?.as_ref());
    let temporary = format!("{path}.tmp-{suffix}");
    create(&temporary, value.to_string().as_bytes())?;
    if std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(Error::client("Cannot replace private retry state"));
    }
    Ok(())
}
pub fn optional_json(path: &str) -> Result<Option<serde_json::Value>, Error> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => serde_json::from_slice(&read(path, 16384)?)
            .map(Some)
            .map_err(|_| Error::client("Invalid private retry state")),
    }
}

pub fn distinct(paths: &[&str]) -> Result<(), Error> {
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let absolute =
            std::path::absolute(path).map_err(|_| Error::client("Invalid private path"))?;
        let mut normalized = std::path::PathBuf::new();
        for part in absolute.components() {
            match part {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => {}
                _ => normalized.push(part),
            }
        }
        if !seen.insert(normalized) {
            return Err(Error::client("Requires distinct private paths"));
        }
    }
    Ok(())
}
pub fn save_identical(path: &str, value: &serde_json::Value) -> Result<(), Error> {
    if let Some(saved) = optional_json(path)? {
        if saved != *value {
            return Err(Error::client(
                "Private output conflicts with the issued artifact",
            ));
        }
        Ok(())
    } else {
        create(path, value.to_string().as_bytes())
    }
}

pub fn optional_bytes(path: &str, limit: usize) -> Result<Option<Vec<u8>>, Error> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => read(path, limit).map(Some),
    }
}
