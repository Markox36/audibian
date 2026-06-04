use crate::audio::eq::EqBand;
use crate::mixer::MixerSnapshot;
use serde::{Deserialize, Serialize};

/// Stable specification for a PipeWire link, using node/port names
/// rather than ephemeral integer IDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkSpec {
    pub output_node: String,
    pub output_port: String,
    pub input_node: String,
    pub input_port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeSpec {
    /// Node name (e.g. "alsa_output.pci-0000_00_1f.3.analog-stereo")
    pub node_name: String,
    /// Volume [0.0..1.0]
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EqSpec {
    /// Name of the sink to apply EQ to
    pub target_sink: String,
    pub bands: Vec<EqBand>,
}

/// A complete audio configuration snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioProfile {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// ISO-8601 creation timestamp
    pub created_at: String,
    #[serde(default)]
    pub links: Vec<LinkSpec>,
    #[serde(default)]
    pub volumes: Vec<VolumeSpec>,
    #[serde(default)]
    pub default_sink: Option<String>,
    #[serde(default)]
    pub default_source: Option<String>,
    #[serde(default)]
    pub eq: Vec<EqSpec>,
    /// Audibian mixer state (faders, sends levels, pan, mute, EQ).
    /// Applied without recreating channels — virtual sinks / sends stay alive,
    /// only levels and toggles update.
    #[serde(default)]
    pub mixer_snapshot: Option<MixerSnapshot>,
}

impl AudioProfile {
    pub fn new(name: impl Into<String>) -> Self {
        let now = chrono_now();
        Self {
            name: name.into(),
            description: String::new(),
            created_at: now,
            links: Vec::new(),
            volumes: Vec::new(),
            default_sink: None,
            default_source: None,
            eq: Vec::new(),
            mixer_snapshot: None,
        }
    }
}

fn chrono_now() -> String {
    // Use std only — no chrono dep needed for a simple ISO timestamp
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Format as "YYYY-MM-DD HH:MM:SS UTC" (rough, no chrono dependency)
    let s = secs;
    let sec = s % 60;
    let min = (s / 60) % 60;
    let hour = (s / 3600) % 24;
    let days = s / 86400;
    // Approximate date (good enough for display)
    format!("{days}d {hour:02}:{min:02}:{sec:02} UTC")
}
