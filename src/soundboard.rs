//! Soundboard config + persistence.
//!
//! A single virtual input strip (`audibian_soundboard`) acts as the audio
//! source for every uploaded sound. Routing (sends, master, matrix) is then
//! controlled from the regular Mixer because the strip is a real input
//! channel in MixerConfig.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Dedicated virtual sink name. Exposed to the rest of the codebase so the
/// auto-provisioning logic in `MixerConfig::ensure_soundboard_channel` and
/// the playback path in `soundboard_play` agree on the target.
pub const SOUNDBOARD_SINK_NAME: &str = "audibian_soundboard";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sound {
    pub id: u32,
    pub name: String,
    /// Absolute path of the audio file on disk (inside the sounds dir we
    /// manage). Survives renames; deletion of the entry deletes the file.
    pub path: String,
    /// Total media duration in milliseconds (probed by ffprobe on import).
    /// `None` while the probe is still running or if ffprobe failed.
    #[serde(default)]
    pub duration_ms: Option<u32>,
    /// Optional trim window. When set, playback uses ffmpeg to seek/cut
    /// before piping into paplay. Both `None` plays the full file.
    #[serde(default)]
    pub start_ms: Option<u32>,
    #[serde(default)]
    pub end_ms: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SoundboardConfig {
    pub sounds: Vec<Sound>,
    #[serde(default)]
    next_id: u32,
}

impl SoundboardConfig {
    fn config_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".config/audibian/soundboard.toml")
    }

    /// Where uploaded audio files live. Created on demand.
    pub fn sounds_dir() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".local/share/audibian/sounds")
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = toml::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }

    pub fn next_id(&mut self) -> u32 {
        let id = self.next_id.max(1);
        self.next_id = id + 1;
        id
    }
}
