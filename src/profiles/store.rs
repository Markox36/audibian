use std::fs;
use std::path::PathBuf;

use log::{error, info, warn};

use super::model::AudioProfile;

/// Reads and writes profiles as TOML files under `~/.config/audibian/profiles/`.
pub struct ProfileStore {
    dir: PathBuf,
}

impl ProfileStore {
    pub fn new() -> Self {
        let dir = dirs_profile_dir();
        if !dir.exists() {
            let _ = fs::create_dir_all(&dir);
        }
        Self { dir }
    }

    /// Return the directory where profiles are stored.
    #[allow(dead_code)]
    pub fn dir(&self) -> &PathBuf {
        &self.dir
    }

    /// List all saved profile names (sorted alphabetically).
    pub fn list(&self) -> Vec<String> {
        let mut names = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return names;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("toml") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
        names.sort();
        names
    }

    /// Load a profile by name.
    pub fn load(&self, name: &str) -> Option<AudioProfile> {
        let path = self.dir.join(format!("{name}.toml"));
        let content = fs::read_to_string(&path)
            .map_err(|e| warn!("Cannot read profile '{name}': {e}"))
            .ok()?;
        toml::from_str(&content)
            .map_err(|e| error!("Cannot parse profile '{name}': {e}"))
            .ok()
    }

    /// Save a profile. Overwrites if a profile with the same name exists.
    pub fn save(&self, profile: &AudioProfile) -> bool {
        let path = self.dir.join(format!("{}.toml", profile.name));
        let content = match toml::to_string_pretty(profile) {
            Ok(c) => c,
            Err(e) => {
                error!("Cannot serialise profile '{}': {e}", profile.name);
                return false;
            }
        };
        match fs::write(&path, content) {
            Ok(_) => {
                info!("Profile '{}' saved to {path:?}", profile.name);
                true
            }
            Err(e) => {
                error!("Cannot write profile '{}': {e}", profile.name);
                false
            }
        }
    }

    /// Delete a profile by name.
    pub fn delete(&self, name: &str) -> bool {
        let path = self.dir.join(format!("{name}.toml"));
        match fs::remove_file(&path) {
            Ok(_) => {
                info!("Profile '{name}' deleted");
                true
            }
            Err(e) => {
                warn!("Cannot delete profile '{name}': {e}");
                false
            }
        }
    }
}

fn dirs_profile_dir() -> PathBuf {
    let base = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    base.join(".config").join("audibian").join("profiles")
}
