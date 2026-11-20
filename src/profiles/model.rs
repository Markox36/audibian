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

/// UTC timestamp as ISO-8601 (`2026-11-20T14:03:12Z`), std only. The first
/// profiles stored `"<days>d HH:MM:SS UTC"` instead; the UI still reads both.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_utc(secs)
}

fn iso_utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// Light summary for the scene bar: enough to label a scene without
/// shipping every profile's full link list to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileInfo {
    pub name: String,
    pub created_at: String,
    pub channels: usize,
    pub links: usize,
}

impl From<&AudioProfile> for ProfileInfo {
    fn from(p: &AudioProfile) -> Self {
        Self {
            name: p.name.clone(),
            created_at: p.created_at.clone(),
            channels: p.mixer_snapshot.as_ref().map_or(0, |s| s.fader.len()),
            links: p.links.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::iso_utc;

    #[test]
    fn iso_utc_known_dates() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        // Leap day, 2024-02-29 12:34:56 UTC.
        assert_eq!(iso_utc(1_709_210_096), "2024-02-29T12:34:56Z");
        assert_eq!(iso_utc(1_800_000_000), "2027-01-15T08:00:00Z");
    }
}
