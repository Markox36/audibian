//! Persistent state restoration — recreates every virtual sink, return bus,
//! source loopback, send, master, EQ filter-chain and per-strip volume from
//! the on-disk MixerConfig.
//!
//! Called from two places:
//!   1. GUI startup (main.rs setup) — returns the module-id maps so the
//!      running app can later unload/relink them.
//!   2. `audibian --apply-persistent` (headless) — discards the maps; pactl
//!      modules persist beyond our process so the routing graph stays alive.

use std::collections::HashMap;

use crate::audio::strip_eq::StripEqInstance;
use crate::commands;
use crate::mixer::MixerConfig;

#[derive(Default)]
pub struct RestoredModules {
    pub master_null_module: Option<u32>,
    pub master_loopback_module: Option<u32>,
    pub input_module_ids: HashMap<u32, Vec<u32>>,
    pub return_module_ids: HashMap<u32, Vec<u32>>,
    pub send_module_ids: HashMap<(u32, u32), u32>,
    pub input_source_ids: HashMap<u32, u32>,
    pub strip_eq_instances: HashMap<String, StripEqInstance>,
}

/// Recreate every audibian_* module described by `cfg` via pactl.
/// Idempotent: cleans up stale audibian_* modules first.
pub fn apply_persistent_state(cfg: &MixerConfig) -> RestoredModules {
    // Wipe legacy static drop-in so the next pipewire restart does not
    // resurrect ghost null-sinks that shadow our runtime modules.
    commands::write_pipewire_conf(&[]);
    commands::cleanup_stale_modules();

    let mut out = RestoredModules::default();

    // Master null-sink + monitor loopback to hardware sink.
    if let Some(hw) = &cfg.master_sink {
        if let Some((nid, lid)) = commands::create_master_modules(hw) {
            out.master_null_module = Some(nid);
            out.master_loopback_module = Some(lid);
        }
    }

    // Input virtual sinks.
    for ch in &cfg.input_channels {
        let mut mods = Vec::new();
        if let Some(mid) = commands::create_null_sink(&ch.sink_name) {
            mods.push(mid);
        }
        if !mods.is_empty() {
            out.input_module_ids.insert(ch.id, mods);
        }
    }

    // Return buses (null-sink + remap-source visible to apps).
    for r in &cfg.return_channels {
        let mut mods = Vec::new();
        if let Some(mid) = commands::create_null_sink(&r.sink_name) {
            mods.push(mid);
        }
        let src_name = format!("{}_src", r.sink_name);
        let monitor = format!("{}.monitor", r.sink_name);
        if let Some(mid) = commands::create_remap_source(&monitor, &src_name, &r.name) {
            mods.push(mid);
        }
        if !mods.is_empty() {
            out.return_module_ids.insert(r.id, mods);
        }
    }

    // Loopback sends — wait for sinks to register.
    std::thread::sleep(std::time::Duration::from_millis(500));

    for s in &cfg.sends {
        let inp = cfg.input_channels.iter().find(|c| c.id == s.input_channel_id);
        let ret = cfg.return_channels.iter().find(|r| r.id == s.return_channel_id);
        if let (Some(inp), Some(ret)) = (inp, ret) {
            let monitor = format!("{}.monitor", inp.sink_name);
            if let Some(mid) = commands::create_loopback(&monitor, &ret.sink_name) {
                if (s.level - 1.0).abs() > f32::EPSILON {
                    commands::set_loopback_volume(mid, s.level);
                }
                out.send_module_ids.insert((inp.id, ret.id), mid);
            }
        }
    }

    // Source loopbacks (hw mic → input strip).
    for ch in &cfg.input_channels {
        if let Some(src) = &ch.source_name {
            if let Some(mid) = commands::create_source_loopback(src, &ch.sink_name, ch.mono) {
                out.input_source_ids.insert(ch.id, mid);
            }
        }
    }

    // Persisted fader/pan/mute for every strip + master.
    for ch in &cfg.input_channels {
        commands::apply_strip_pactl(&ch.sink_name, ch.fader, ch.pan, ch.muted);
    }
    for r in &cfg.return_channels {
        commands::apply_strip_pactl(&r.sink_name, r.fader, r.pan, r.muted);
    }
    commands::apply_strip_pactl(
        commands::MASTER_SINK_NAME,
        cfg.master_fader,
        cfg.master_pan,
        cfg.master_muted,
    );

    // Per-strip EQ filter-chains. NOTE: each StripEqInstance owns a child
    // pipewire process. In headless --apply-persistent mode the caller must
    // `mem::forget` the returned map so Drop doesn't kill these on exit.
    for ch in &cfg.input_channels {
        if let Some(eq) = ch.eq.as_ref().filter(|e| e.enabled) {
            if let Some(inst) = crate::audio::strip_eq::start_strip_eq(&ch.sink_name, &eq.bands, 48000) {
                out.strip_eq_instances.insert(commands::strip_key(true, ch.id), inst);
            }
        }
    }

    out
}
