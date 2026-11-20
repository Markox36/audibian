//! Shared TOML config I/O.
//!
//! Every Audibian config file (mixer, matrix, soundboard, app settings,
//! profiles) holds state the user cannot reconstruct by hand, and every
//! loader falls back to `Default` when parsing fails. Writing in place would
//! therefore turn a crash or power cut mid-write into "all your channels,
//! sends and routing are gone". Writes go to a sibling temp file, get synced
//! and are then renamed over the target: readers always see either the whole
//! previous file or the whole new one.

use std::io::Write;
use std::path::Path;

use log::{error, warn};
use serde::{de::DeserializeOwned, Serialize};

/// Serialise `value` to TOML and replace `path` atomically.
pub fn save_toml<T: Serialize>(path: &Path, value: &T) -> bool {
    let content = match toml::to_string_pretty(value) {
        Ok(c) => c,
        Err(e) => {
            error!("Cannot serialise {path:?}: {e}");
            return false;
        }
    };

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!("Cannot create {parent:?}: {e}");
            return false;
        }
    }

    // Same directory as the target: `rename` is only atomic within one
    // filesystem, and this also keeps the temp file under the user's config
    // dir rather than a world-writable /tmp.
    let tmp = path.with_extension("toml.tmp");
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(content.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = written {
        error!("Cannot write {tmp:?}: {e}");
        let _ = std::fs::remove_file(&tmp);
        return false;
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        error!("Cannot replace {path:?}: {e}");
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// Read and parse a TOML config. A missing file is normal and returns `None`
/// quietly; a parse error is logged, because the caller will substitute
/// defaults and the user needs to know their file was ignored.
pub fn load_toml<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let content = std::fs::read_to_string(path).ok()?;
    match toml::from_str(&content) {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("Ignoring unparsable config {path:?}: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A failed write must not take the previous config with it: the loader
    /// treats a truncated file as "no config" and resets the whole mixer.
    #[test]
    fn save_replaces_without_leaving_a_temp_file() {
        let dir = std::env::temp_dir().join(format!("audibian-cfgio-{}", std::process::id()));
        let path = dir.join("thing.toml");

        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Thing {
            name: String,
        }

        assert!(save_toml(&path, &Thing { name: "first".into() }));
        assert!(save_toml(&path, &Thing { name: "second".into() }));

        let loaded: Thing = load_toml(&path).expect("config reloads");
        assert_eq!(loaded.name, "second");
        assert!(!path.with_extension("toml.tmp").exists(), "temp file left behind");

        std::fs::write(&path, "this is not toml {{{").unwrap();
        assert!(load_toml::<Thing>(&path).is_none(), "garbage must not parse");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
