use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::config::{MixerConfig, StripEq};

/// Persistable subset of mixer state for profiles.
/// Snapshots capture *levels and toggles* but never the structure
/// (virtuals, returns, sends, master sink stay in mixer.toml).
/// Applying a snapshot adjusts faders/sends/eq without recreating modules,
/// so apps stay connected.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MixerSnapshot {
    /// Per-strip volume (1.0 = unity). Key = channel id (input or return).
    #[serde(default)]
    pub fader: HashMap<u32, f32>,
    /// Per-strip mute state. Key = channel id.
    #[serde(default)]
    pub mute: HashMap<u32, bool>,
    /// Per-strip pan. Key = channel id. Range -1.0 .. 1.0.
    #[serde(default)]
    pub pan: HashMap<u32, f32>,
    /// Per-input send_to_master toggle. Key = input id.
    #[serde(default)]
    pub input_to_master: HashMap<u32, bool>,
    /// Per-return send_to_master toggle. Key = return id.
    #[serde(default)]
    pub return_to_master: HashMap<u32, bool>,
    /// Per-send levels. Key = (input_id, return_id) flattened as "in:ret".
    #[serde(default)]
    pub send_levels: HashMap<String, f32>,
    /// Per-strip EQ state. Key = channel id (input or return).
    #[serde(default)]
    pub eq: HashMap<u32, StripEq>,
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
            snap.input_to_master.insert(ch.id, ch.send_to_master);
            snap.pan.insert(ch.id, ch.pan);
            snap.fader.insert(ch.id, ch.fader);
            snap.mute.insert(ch.id, ch.muted);
            if let Some(eq) = &ch.eq {
                snap.eq.insert(ch.id, eq.clone());
            }
        }
        for r in &cfg.return_channels {
            snap.return_to_master.insert(r.id, r.send_to_master);
            snap.pan.insert(r.id, r.pan);
            snap.fader.insert(r.id, r.fader);
            snap.mute.insert(r.id, r.muted);
            if let Some(eq) = &r.eq {
                snap.eq.insert(r.id, eq.clone());
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
            if let Some(&v) = self.input_to_master.get(&ch.id) { ch.send_to_master = v; }
            if let Some(&p) = self.pan.get(&ch.id) { ch.pan = p; }
            if let Some(&f) = self.fader.get(&ch.id) { ch.fader = f; }
            if let Some(&m) = self.mute.get(&ch.id) { ch.muted = m; }
            if let Some(eq) = self.eq.get(&ch.id) { ch.eq = Some(eq.clone()); }
        }
        for r in cfg.return_channels.iter_mut() {
            if let Some(&v) = self.return_to_master.get(&r.id) { r.send_to_master = v; }
            if let Some(&p) = self.pan.get(&r.id) { r.pan = p; }
            if let Some(&f) = self.fader.get(&r.id) { r.fader = f; }
            if let Some(&m) = self.mute.get(&r.id) { r.muted = m; }
            if let Some(eq) = self.eq.get(&r.id) { r.eq = Some(eq.clone()); }
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
