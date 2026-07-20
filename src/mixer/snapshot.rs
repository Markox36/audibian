use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::config::{MixerConfig, StripEq};

/// Persistable subset of mixer state for profiles.
/// Snapshots capture *levels and toggles* but never the structure
/// (virtuals, returns, sends, master sink stay in mixer.toml).
/// Applying a snapshot adjusts faders/sends/eq without recreating modules,
/// so apps stay connected.
// toml requires string map keys, so channel ids are stored as strings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MixerSnapshot {
    #[serde(default)]
    pub fader: HashMap<String, f32>,
    #[serde(default)]
    pub mute: HashMap<String, bool>,
    #[serde(default)]
    pub pan: HashMap<String, f32>,
    #[serde(default)]
    pub input_to_master: HashMap<String, bool>,
    #[serde(default)]
    pub return_to_master: HashMap<String, bool>,
    #[serde(default)]
    pub send_levels: HashMap<String, f32>,
    #[serde(default)]
    pub eq: HashMap<String, StripEq>,
    /// Master strip values.
    #[serde(default)]
    pub master_fader: Option<f32>,
    #[serde(default)]
    pub master_mute: Option<bool>,
    #[serde(default)]
    pub master_eq: Option<StripEq>,
}

impl MixerSnapshot {
    /// Build a snapshot from current persisted mixer config + provided runtime levels.
    /// Runtime values (fader, mute, pan) are read from `mixer.toml` itself today
    /// because the existing code uses pactl to set them — extend later when we
    /// store live runtime state.
    pub fn from_config(cfg: &MixerConfig) -> Self {
        let mut snap = MixerSnapshot::default();

        for ch in &cfg.input_channels {
            let k = ch.id.to_string();
            snap.input_to_master.insert(k.clone(), ch.send_to_master);
            snap.pan.insert(k.clone(), ch.pan);
            snap.fader.insert(k.clone(), ch.fader);
            snap.mute.insert(k.clone(), ch.muted);
            if let Some(eq) = &ch.eq {
                snap.eq.insert(k, eq.clone());
            }
        }
        for r in &cfg.return_channels {
            let k = r.id.to_string();
            snap.return_to_master.insert(k.clone(), r.send_to_master);
            snap.pan.insert(k.clone(), r.pan);
            snap.fader.insert(k.clone(), r.fader);
            snap.mute.insert(k.clone(), r.muted);
            if let Some(eq) = &r.eq {
                snap.eq.insert(k, eq.clone());
            }
        }
        for s in &cfg.sends {
            snap.send_levels.insert(
                format!("{}:{}", s.input_channel_id, s.return_channel_id),
                s.level,
            );
        }
        snap.master_fader = Some(cfg.master_fader);
        snap.master_mute = Some(cfg.master_muted);
        snap.master_eq = cfg.master_eq.clone();
        snap
    }

    /// Apply snapshot values into the mixer config (mutating).
    /// Does NOT touch structure — only updates fields that match existing ids.
    /// Caller is responsible for triggering runtime side-effects (re-link sends,
    /// re-attach EQ filter-chains, push volumes via pactl).
    pub fn apply_to(&self, cfg: &mut MixerConfig) {
        for ch in cfg.input_channels.iter_mut() {
            let k = ch.id.to_string();
            if let Some(&v) = self.input_to_master.get(&k) { ch.send_to_master = v; }
            if let Some(&p) = self.pan.get(&k) { ch.pan = p; }
            if let Some(&f) = self.fader.get(&k) { ch.fader = f; }
            if let Some(&m) = self.mute.get(&k) { ch.muted = m; }
            if let Some(eq) = self.eq.get(&k) { ch.eq = Some(eq.clone()); }
        }
        for r in cfg.return_channels.iter_mut() {
            let k = r.id.to_string();
            if let Some(&v) = self.return_to_master.get(&k) { r.send_to_master = v; }
            if let Some(&p) = self.pan.get(&k) { r.pan = p; }
            if let Some(&f) = self.fader.get(&k) { r.fader = f; }
            if let Some(&m) = self.mute.get(&k) { r.muted = m; }
            if let Some(eq) = self.eq.get(&k) { r.eq = Some(eq.clone()); }
        }
        for s in cfg.sends.iter_mut() {
            let key = format!("{}:{}", s.input_channel_id, s.return_channel_id);
            if let Some(&lvl) = self.send_levels.get(&key) {
                s.level = lvl;
            }
        }
        if let Some(f) = self.master_fader { cfg.master_fader = f; }
        if let Some(m) = self.master_mute { cfg.master_muted = m; }
        if let Some(eq) = &self.master_eq { cfg.master_eq = Some(eq.clone()); }
    }
}
