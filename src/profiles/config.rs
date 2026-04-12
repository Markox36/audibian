/// Persistent application settings (separate from audio profiles).
///
/// Stored as TOML at `~/.config/audibian/config.toml`.
use std::fs;
use std::path::PathBuf;

use log::{error, info, warn};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    /// Profile name to apply automatically on startup (if any).
    #[serde(default)]
    pub default_profile: Option<String>,

    /// Whether Audibian should start with the desktop session.
    #[serde(default)]
    pub autostart: bool,
}

impl AppConfig {
    /// Load from `~/.config/audibian/config.toml`, returning defaults on error.
    pub fn load() -> Self {
        let path = config_path();
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return Self::default(),
        };
        toml::from_str(&content).unwrap_or_else(|e| {
            warn!("Cannot parse app config: {e}");
            Self::default()
        })
    }

    /// Persist to `~/.config/audibian/config.toml`.
    pub fn save(&self) -> bool {
        let path = config_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match toml::to_string_pretty(self) {
            Ok(content) => match fs::write(&path, content) {
                Ok(_) => {
                    info!("App config saved to {path:?}");
                    true
                }
                Err(e) => {
                    error!("Cannot write app config: {e}");
                    false
                }
            },
            Err(e) => {
                error!("Cannot serialize app config: {e}");
                false
            }
        }
    }

    /// Write or remove the XDG autostart `.desktop` file so the desktop
    /// environment launches Audibian when the user logs in.
    pub fn apply_autostart(&self) {
        let desktop_path = autostart_desktop_path();

        if self.autostart {
            // Resolve the path to the currently-running binary
            let exe = std::env::current_exe()
                .unwrap_or_else(|_| PathBuf::from("audibian"));

            let content = format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Name=Audibian\n\
                 Comment=Gestor de audio PipeWire\n\
                 Exec={exe}\n\
                 Hidden=false\n\
                 X-GNOME-Autostart-enabled=true\n",
                exe = exe.display()
            );

            if let Some(parent) = desktop_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::write(&desktop_path, content) {
                Ok(_) => info!("Autostart enabled: {desktop_path:?}"),
                Err(e) => error!("Cannot write autostart file: {e}"),
            }
        } else {
            match fs::remove_file(&desktop_path) {
                Ok(_) => info!("Autostart disabled"),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => warn!("Cannot remove autostart file: {e}"),
            }
        }
    }
}

fn config_path() -> PathBuf {
    home_dir().join(".config").join("audibian").join("config.toml")
}

fn autostart_desktop_path() -> PathBuf {
    home_dir()
        .join(".config")
        .join("autostart")
        .join("audibian.desktop")
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}
