use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::audio::eq::EqBand;

fn default_true() -> bool { true }
fn default_scale() -> f32 { 1.0 }
fn default_send_level() -> f32 { 1.0 }
fn default_pan() -> f32 { 0.0 }
fn default_fader() -> f32 { 1.0 }

/// Per-strip parametric EQ state (persisted in mixer.toml and snapshots).
/// Reuses the same EqBand type as the legacy `audibian-eq-*` virtual sink.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StripEq {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bands: Vec<EqBand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InputChannel {
    pub id: u32,
    pub name: String,
    pub sink_name: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub mono: bool,
    #[serde(default = "default_true")]
    pub send_to_master: bool,
    #[serde(default = "default_pan")]
    pub pan: f32,
    #[serde(default = "default_fader")]
    pub fader: f32,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub app_match_rules: Vec<String>,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub eq: Option<StripEq>,
    /// Marks the soundboard strip. Auto-provisioned at startup, cannot be
    /// removed via UI. Plays uploaded sounds through this dedicated sink so
    /// the user can route every soundboard sound from one mixer strip.
    #[serde(default)]
    pub is_soundboard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReturnChannel {
    pub id: u32,
    pub name: String,
    pub sink_name: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_true")]
    pub send_to_master: bool,
    #[serde(default = "default_pan")]
    pub pan: f32,
    #[serde(default = "default_fader")]
    pub fader: f32,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub eq: Option<StripEq>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendRoute {
    pub input_channel_id: u32,
    pub return_channel_id: u32,
    #[serde(default = "default_send_level")]
    pub level: f32,
}

impl Default for SendRoute {
    fn default() -> Self {
        Self {
            input_channel_id: 0,
            return_channel_id: 0,
            level: 1.0,
        }
    }
}

/// One hosted plugin in a MIDI channel's chain. Persisted purely for
/// audibian's bookkeeping (display label, order) — the real audio
/// processing happens inside the Carla rack process; Carla owns the actual
/// plugin instance + parameter state via its own project file.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MidiPlugin {
    pub id: u32,
    pub name: String,
    /// LV2 URI, or absolute path for VST2/VST3/CLAP.
    pub identifier: String,
    /// "LV2" | "VST2" | "VST3" | "CLAP" | "SFZ".
    pub format: String,
}

/// MIDI/instrument strip. Like InputChannel but the source is a Carla
/// rack rather than a hardware input. The rack's audio output is wired
/// into `sink_name` (an audibian null-sink) so the rest of the mixer
/// graph treats it identically to any other strip.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MidiChannel {
    pub id: u32,
    pub name: String,
    pub sink_name: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_true")]
    pub send_to_master: bool,
    #[serde(default = "default_pan")]
    pub pan: f32,
    #[serde(default = "default_fader")]
    pub fader: f32,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub plugins: Vec<MidiPlugin>,
    #[serde(default)]
    pub next_plugin_id: u32,
    /// OSC UDP port for talking to this channel's Carla instance.
    /// Allocated lazily on first launch; reused across restarts so the
    /// rosc client always knows where to reach the running rack.
    #[serde(default)]
    pub osc_udp_port: u16,
    /// OSC TCP port for plugin-level Carla commands.
    #[serde(default)]
    pub osc_tcp_port: u16,
}

impl MidiChannel {
    pub fn next_plugin_id(&mut self) -> u32 {
        let id = self.next_plugin_id.max(1);
        self.next_plugin_id = id + 1;
        id
    }
    /// Path to the Carla rack project file backing this channel.
    pub fn carla_project_path(&self) -> std::path::PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        std::path::PathBuf::from(home)
            .join(".config/audibian/midi")
            .join(format!("midi_{}.carxp", self.id))
    }
    /// JACK client name we ask Carla to advertise via PIPEWIRE_NODE_NAME.
    /// Stable across restarts so `pw-link` can wire the chain on every
    /// boot without having to enumerate Carla instances by PID.
    pub fn carla_client_name(&self) -> String {
        format!("audibian_midi_{}_host", self.id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixerConfig {
    pub next_id: u32,
    #[serde(default)]
    pub input_channels: Vec<InputChannel>,
    #[serde(default)]
    pub return_channels: Vec<ReturnChannel>,
    #[serde(default)]
    pub midi_channels: Vec<MidiChannel>,
    #[serde(default)]
    pub sends: Vec<SendRoute>,
    pub master_sink: Option<String>,
    #[serde(default = "default_scale")]
    pub global_scale: f32,
    #[serde(default)]
    pub master_eq: Option<StripEq>,
    #[serde(default = "default_fader")]
    pub master_fader: f32,
    #[serde(default = "default_pan")]
    pub master_pan: f32,
    #[serde(default)]
    pub master_muted: bool,
}

impl Default for MixerConfig {
    fn default() -> Self {
        Self {
            next_id: 0,
            input_channels: Vec::new(),
            return_channels: Vec::new(),
            midi_channels: Vec::new(),
            sends: Vec::new(),
            master_sink: None,
            global_scale: 1.0,
            master_eq: None,
            master_fader: 1.0,
            master_pan: 0.0,
            master_muted: false,
        }
    }
}

impl MixerConfig {
    fn config_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(".config/audibian/mixer.toml")
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

    pub fn next_channel_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Ensures a single soundboard input strip exists. Called on startup so
    /// `audibian_soundboard` is always present in the Mixer regardless of
    /// previous config state. Returns true if a new entry was added.
    pub fn ensure_soundboard_channel(&mut self) -> bool {
        let sink = crate::soundboard::SOUNDBOARD_SINK_NAME;
        if self.input_channels.iter().any(|c| c.is_soundboard || c.sink_name == sink) {
            // Make sure the flag is set on the existing entry so the UI can
            // hide the remove button.
            if let Some(c) = self.input_channels.iter_mut().find(|c| c.sink_name == sink) {
                c.is_soundboard = true;
            }
            return false;
        }
        let id = self.next_channel_id();
        let order = self.input_channels.len() as u32;
        self.input_channels.push(InputChannel {
            id,
            name: "Soundboard".to_string(),
            sink_name: sink.to_string(),
            order,
            color: Some("#a18c47".to_string()),
            source_name: None,
            mono: false,
            send_to_master: true,
            pan: 0.0,
            fader: 1.0,
            muted: false,
            app_match_rules: Vec::new(),
            is_default: false,
            eq: None,
            is_soundboard: true,
        });
        true
    }

    pub fn has_send(&self, input_id: u32, return_id: u32) -> bool {
        self.sends.iter().any(|s| s.input_channel_id == input_id && s.return_channel_id == return_id)
    }

    pub fn add_send(&mut self, input_id: u32, return_id: u32) {
        if !self.has_send(input_id, return_id) {
            self.sends.push(SendRoute {
                input_channel_id: input_id,
                return_channel_id: return_id,
                level: 1.0,
            });
        }
    }

    pub fn remove_send(&mut self, input_id: u32, return_id: u32) {
        self.sends.retain(|s| !(s.input_channel_id == input_id && s.return_channel_id == return_id));
    }

    pub fn set_send_level(&mut self, input_id: u32, return_id: u32, level: f32) {
        if let Some(s) = self.sends.iter_mut()
            .find(|s| s.input_channel_id == input_id && s.return_channel_id == return_id)
        {
            s.level = level.clamp(0.0, 4.0);
        }
    }

    pub fn get_send_level(&self, input_id: u32, return_id: u32) -> Option<f32> {
        self.sends.iter()
            .find(|s| s.input_channel_id == input_id && s.return_channel_id == return_id)
            .map(|s| s.level)
    }

    pub fn default_input_channel(&self) -> Option<&InputChannel> {
        self.input_channels.iter().find(|c| c.is_default)
    }
}
