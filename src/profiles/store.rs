use std::fs;
use std::path::PathBuf;

use log::{error, info, warn};

use super::model::{AudioProfile, ProfileInfo};

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

    /// Path of a profile file, or `None` for names that could escape the
    /// profiles directory (`../x`, `a/b`) or hide as dotfiles. Names come from
    /// the UI and are used verbatim as file names.
    fn path_for(&self, name: &str) -> Option<PathBuf> {
        let ok = !name.trim().is_empty()
            && !name.starts_with('.')
            && !name.contains(['/', '\\', '\0']);
        ok.then(|| self.dir.join(format!("{name}.toml")))
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

    /// Summaries of every profile, sorted by name.
    pub fn list_info(&self) -> Vec<ProfileInfo> {
        self.list()
            .iter()
            .filter_map(|n| self.load(n))
            .map(|p| ProfileInfo::from(&p))
            .collect()
    }

    /// Load a profile by name.
    pub fn load(&self, name: &str) -> Option<AudioProfile> {
        let path = self.path_for(name)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| warn!("Cannot read profile '{name}': {e}"))
            .ok()?;
        toml::from_str(&content)
            .map_err(|e| error!("Cannot parse profile '{name}': {e}"))
            .ok()
    }

    /// Save a profile. Overwrites if a profile with the same name exists.
    pub fn save(&self, profile: &AudioProfile) -> bool {
        let Some(path) = self.path_for(&profile.name) else {
            error!("Refusing to save profile with invalid name '{}'", profile.name);
            return false;
        };
        if crate::config_io::save_toml(&path, profile) {
            info!("Profile '{}' saved to {path:?}", profile.name);
            true
        } else {
            false
        }
    }

    /// Copy `from` to a new profile `to`. Fails if `to` already exists.
    pub fn duplicate(&self, from: &str, to: &str) -> Result<(), String> {
        let mut profile = self.load(from).ok_or_else(|| format!("Profile '{from}' not found"))?;
        let target = self.path_for(to).ok_or("Invalid profile name")?;
        if target.exists() {
            return Err(format!("A profile named '{to}' already exists"));
        }
        profile.name = to.to_string();
        profile.created_at = AudioProfile::new(to).created_at;
        if self.save(&profile) { Ok(()) } else { Err("Could not write profile".into()) }
    }

    /// Rename `from` to `to`. Fails if `to` already exists; the old file is
    /// removed only after the new one was written.
    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let mut profile = self.load(from).ok_or_else(|| format!("Profile '{from}' not found"))?;
        let target = self.path_for(to).ok_or("Invalid profile name")?;
        if from == to {
            return Ok(());
        }
        if target.exists() {
            return Err(format!("A profile named '{to}' already exists"));
        }
        profile.name = to.to_string();
        if !self.save(&profile) {
            return Err("Could not write profile".into());
        }
        self.delete(from);
        Ok(())
    }

    /// Delete a profile by name.
    pub fn delete(&self, name: &str) -> bool {
        let Some(path) = self.path_for(name) else { return false };
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
