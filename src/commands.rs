use tauri::State;
use log::debug;

use crate::audio::eq::EqBand;
use crate::audio::effects;
use crate::audio::{AudioGraph, PwCommand, PwThread};
use crate::mixer::{InputChannel, MidiChannel, MidiPlugin, ReturnChannel};
use crate::proc::CommandExt;
use crate::profiles::model::AudioProfile;
use crate::profiles::AppConfig;
use crate::soundboard::{Sound, SoundboardConfig, SOUNDBOARD_SINK_NAME};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_graph(state: State<AppState>) -> serde_json::Value {
    let graph = state.graph.lock().unwrap();
    let nodes: Vec<&crate::audio::graph::AudioNode> = graph.nodes.values().collect();
    let ports: Vec<&crate::audio::graph::AudioPort> = graph.ports.values().collect();
    let links: Vec<&crate::audio::graph::AudioLink> = graph.links.values().collect();
    serde_json::json!({
        "nodes": nodes,
        "ports": ports,
        "links": links,
    })
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_link(state: State<AppState>, output_port_id: u32, input_port_id: u32) {
    state.pw.create_link(output_port_id, input_port_id);
}

#[tauri::command]
pub fn destroy_link(state: State<AppState>, link_id: u32) {
    state.pw.destroy_link(link_id);
}

// ---------------------------------------------------------------------------
// EQ
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_eq(state: State<AppState>, target_sink: String, bands: Vec<EqBand>, sample_rate: u32) {
    let mut eq = state.eq_instance.lock().unwrap();
    // Drop existing instance first
    *eq = None;
    *eq = effects::start_eq(&target_sink, &bands, sample_rate);
}

#[tauri::command]
pub fn stop_eq(state: State<AppState>) {
    let mut eq = state.eq_instance.lock().unwrap();
    *eq = None;
}

#[tauri::command]
pub fn get_eq_target(state: State<AppState>) -> Option<String> {
    state.eq_instance.lock().unwrap()
        .as_ref()
        .map(|e| e.target_sink.clone())
}

// ---------------------------------------------------------------------------
// Noise Suppression
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn start_ns(state: State<AppState>, source_name: String) {
    let mut ns = state.ns_instances.lock().unwrap();
    if !ns.contains_key(&source_name) {
        if let Some(inst) = effects::start_noise_suppression(&source_name) {
            ns.insert(source_name, inst);
        }
    }
}

#[tauri::command]
pub fn stop_ns(state: State<AppState>, source_name: String) {
    let mut ns = state.ns_instances.lock().unwrap();
    ns.remove(&source_name);
}

#[tauri::command]
pub fn get_ns_active(state: State<AppState>) -> Vec<String> {
    state.ns_instances.lock().unwrap().keys().cloned().collect()
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_profiles(state: State<AppState>) -> Vec<String> {
    state.profile_store.lock().unwrap().list()
}

#[tauri::command]
pub fn load_profile(state: State<AppState>, name: String) -> Option<AudioProfile> {
    state.profile_store.lock().unwrap().load(&name)
}

#[tauri::command]
pub fn save_profile(state: State<AppState>, profile: AudioProfile) -> bool {
    state.profile_store.lock().unwrap().save(&profile)
}

#[tauri::command]
pub fn delete_profile(state: State<AppState>, name: String) -> bool {
    state.profile_store.lock().unwrap().delete(&name)
}

#[tauri::command]
pub fn apply_profile_cmd(state: State<AppState>, name: String) -> usize {
    let store = state.profile_store.lock().unwrap();
    let profile = match store.load(&name) {
        Some(p) => p,
        None => return 0,
    };
    drop(store);
    let graph = state.graph.lock().unwrap();
    let result = crate::profiles::apply::apply_profile(&profile, &graph, &state.pw);
    drop(graph);

    if let Some(snap) = &profile.mixer_snapshot {
        {
            let mut cfg = state.mixer_config.lock().unwrap();
            snap.apply_to(&mut cfg);
            cfg.save();
        }
        apply_mixer_snapshot_runtime(&state);
    }

    result.links_applied
}

#[tauri::command]
pub fn snapshot_profile_cmd(state: State<AppState>, name: String) -> bool {
    let graph = state.graph.lock().unwrap();
    let mut profile = crate::profiles::apply::snapshot_profile(&name, &graph);
    drop(graph);
    profile.mixer_snapshot = Some(
        crate::mixer::MixerSnapshot::from_config(&state.mixer_config.lock().unwrap())
    );
    state.profile_store.lock().unwrap().save(&profile)
}

/// Push the (already-applied to MixerConfig) snapshot values through pactl
/// without recreating any modules. Call after `snap.apply_to(&mut cfg)`.
fn apply_mixer_snapshot_runtime(state: &AppState) {
    let cfg = state.mixer_config.lock().unwrap().clone();
    let solos = state.solo_set.lock().unwrap().clone();
    let any_solo = !solos.is_empty();

    for ch in &cfg.input_channels {
        let key = strip_key(true, ch.id);
        let eff = ch.muted || (any_solo && !solos.contains(&key));
        apply_strip_pactl(&ch.sink_name, ch.fader, ch.pan, eff);
    }
    for r in &cfg.return_channels {
        let key = strip_key(false, r.id);
        let eff = r.muted || (any_solo && !solos.contains(&key));
        apply_strip_pactl(&r.sink_name, r.fader, r.pan, eff);
    }
    apply_strip_pactl(MASTER_SINK_NAME, cfg.master_fader, cfg.master_pan, cfg.master_muted);

    let send_ids = state.send_module_ids.lock().unwrap().clone();
    for send in &cfg.sends {
        if let Some(&mid) = send_ids.get(&(send.input_channel_id, send.return_channel_id)) {
            set_loopback_volume(mid, send.level);
        }
    }
}

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_config(_state: State<AppState>) -> AppConfig {
    AppConfig::load()
}

#[tauri::command]
pub fn save_app_config(_state: State<AppState>, config: AppConfig) {
    config.save();
    apply_low_latency_conf(config.low_latency);
}

/// Write or remove the PipeWire drop-in that pins quantum to 256 samples
/// (~5ms @ 48k). Effective after a PipeWire restart.
pub fn apply_low_latency_conf(enabled: bool) {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = std::path::PathBuf::from(&home).join(".config/pipewire/pipewire.conf.d");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("audibian-quantum.conf");
    if enabled {
        let conf = "# Generated by audibian — do not edit manually\n\
context.properties = {\n\
    default.clock.quantum = 256\n\
    default.clock.min-quantum = 256\n\
    default.clock.max-quantum = 256\n\
}\n";
        let _ = std::fs::write(path, conf);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_mixer_config(state: State<AppState>) -> crate::mixer::MixerConfig {
    state.mixer_config.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_input_channel(state: State<AppState>, name: String) {
    let (id, sink_name, all_channels) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let id = cfg.next_channel_id();
        let order = cfg.input_channels.len() as u32;
        let slug: String = name.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        let sink_name = format!("audibian_{}", slug);
        cfg.input_channels.push(InputChannel {
            id,
            name: name.clone(),
            sink_name: sink_name.clone(),
            order,
            color: None,
            source_name: None,
            mono: false,
            send_to_master: true,
            pan: 0.0,
            fader: 1.0,
            muted: false,
            app_match_rules: Vec::new(),
            is_default: false,
            eq: None,
            is_soundboard: false,
        });
        cfg.save();
        let channels = cfg.input_channels.clone();
        (id, sink_name, channels)
    };

    write_pipewire_conf(&all_channels);

    let mut mods = Vec::new();
    if let Some(mid) = create_null_sink(&sink_name) {
        debug!("Created input null-sink '{}' as module {}", sink_name, mid);
        mods.push(mid);
    }
    if !mods.is_empty() {
        state.input_module_ids.lock().unwrap().insert(id, mods);
    }
}

#[tauri::command]
pub fn add_return_channel(state: State<AppState>, name: Option<String>) {
    let (id, sink_name, display_name) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let id = cfg.next_channel_id();
        let letter = ('A' as u8 + (cfg.return_channels.len() % 26) as u8) as char;
        let sink_name = format!("audibian_return_{}", id);
        let order = cfg.return_channels.len() as u32;
        let channel_name = name.unwrap_or_else(|| format!("Return {}", letter));
        cfg.return_channels.push(ReturnChannel {
            id,
            name: channel_name.clone(),
            sink_name: sink_name.clone(),
            order,
            color: None,
            send_to_master: false,
            pan: 0.0,
            fader: 1.0,
            muted: false,
            eq: None,
        });
        cfg.save();
        (id, sink_name, channel_name)
    };

    let mut mods = Vec::new();
    if let Some(mid) = create_null_sink(&sink_name) {
        debug!("Created null-sink '{}' as module {}", sink_name, mid);
        mods.push(mid);
    }
    let src_name = format!("{}_src", sink_name);
    let monitor = format!("{}.monitor", sink_name);
    if let Some(mid) = create_remap_source(&monitor, &src_name, &display_name) {
        debug!("Created remap-source '{}' ({}) as module {}", src_name, display_name, mid);
        mods.push(mid);
    }
    if !mods.is_empty() {
        state.mixer_module_ids.lock().unwrap().insert(id, mods);
    }
    // Meter starts reactively in handle_pw_event when the ".monitor" node appears.
}

#[tauri::command]
pub fn remove_input_channel(state: State<AppState>, id: u32) {
    // Refuse to delete the soundboard strip — it is auto-provisioned at
    // startup and removing it would break soundboard playback routing.
    {
        let cfg = state.mixer_config.lock().unwrap();
        if cfg.input_channels.iter().any(|c| c.id == id && c.is_soundboard) {
            return;
        }
    }

    // Unload source loopback if any
    if let Some(mid) = state.input_source_ids.lock().unwrap().remove(&id) {
        std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn_detached();
    }

    // Unload all send loopbacks where this channel is the input
    {
        let mut send_mods = state.send_module_ids.lock().unwrap();
        let keys: Vec<(u32, u32)> = send_mods.keys().filter(|(inp, _)| *inp == id).cloned().collect();
        for key in keys {
            if let Some(mid) = send_mods.remove(&key) {
                std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn_detached();
            }
        }
    }

    // Unload input null-sink
    if let Some(mods) = state.input_module_ids.lock().unwrap().remove(&id) {
        for mid in mods {
            unload_module(mid);
        }
    }

    let all_channels = {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.sends.retain(|s| s.input_channel_id != id);
        cfg.input_channels.retain(|c| c.id != id);
        cfg.save();
        cfg.input_channels.clone()
    };

    write_pipewire_conf(&all_channels);
}

#[tauri::command]
pub fn remove_return_channel(state: State<AppState>, id: u32) {
    // Drop meter before unloading the sink
    let sink_name = state.mixer_config.lock().unwrap()
        .return_channels.iter()
        .find(|r| r.id == id)
        .map(|r| r.sink_name.clone());
    if let Some(name) = sink_name {
        state.meter_handles.lock().unwrap().remove(&name);
    }
    if let Some(mods) = state.mixer_module_ids.lock().unwrap().remove(&id) {
        for mid in mods {
            unload_module(mid);
        }
    }
    let mut cfg = state.mixer_config.lock().unwrap();
    cfg.sends.retain(|s| s.return_channel_id != id);
    cfg.return_channels.retain(|r| r.id != id);
    cfg.save();
}

#[tauri::command]
pub fn update_input_channel_name(state: State<AppState>, id: u32, name: String) {
    let all_channels = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(ch) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
            ch.name = name;
        }
        cfg.save();
        cfg.input_channels.clone()
    };
    write_pipewire_conf(&all_channels);
}

#[tauri::command]
pub fn update_return_channel_name(state: State<AppState>, id: u32, name: String) {
    let sink_name = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(r) = cfg.return_channels.iter_mut().find(|r| r.id == id) {
            r.name = name.clone();
        }
        cfg.save();
        cfg.return_channels.iter().find(|r| r.id == id).map(|r| r.sink_name.clone())
    };

    // Reload remap-source (index 1) so apps see the updated name immediately.
    if let Some(sink) = sink_name {
        let src_name = format!("{}_src", sink);
        let monitor = format!("{}.monitor", sink);
        let mut ids = state.mixer_module_ids.lock().unwrap();
        if let Some(mods) = ids.get_mut(&id) {
            if mods.len() > 1 {
                // Unload old remap-source
                std::process::Command::new("pactl")
                    .args(["unload-module", &mods[1].to_string()])
                    .spawn_detached();
            }
            // Create new remap-source with updated description
            if let Some(mid) = create_remap_source(&monitor, &src_name, &name) {
                if mods.len() > 1 { mods[1] = mid; } else { mods.push(mid); }
            }
        }
    }
}


#[tauri::command]
pub fn toggle_send(state: State<AppState>, input_id: u32, return_id: u32, active: bool) {
    let (input_sink, ret_sink) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let input_sink = cfg.input_channels.iter()
            .find(|c| c.id == input_id)
            .map(|c| c.sink_name.clone());
        let ret_sink = cfg.return_channels.iter()
            .find(|r| r.id == return_id)
            .map(|r| r.sink_name.clone());
        if active {
            cfg.add_send(input_id, return_id);
        } else {
            cfg.remove_send(input_id, return_id);
        }
        cfg.save();
        (input_sink, ret_sink)
    };

    if let (Some(src), Some(dst)) = (input_sink, ret_sink) {
        if active {
            let monitor = format!("{}.monitor", src);
            if let Some(mid) = create_loopback(&monitor, &dst) {
                debug!("Created loopback {} → {} as module {}", monitor, dst, mid);
                let level = state.mixer_config.lock().unwrap()
                    .get_send_level(input_id, return_id)
                    .unwrap_or(1.0);
                if (level - 1.0).abs() > f32::EPSILON {
                    set_loopback_volume(mid, level);
                }
                state.send_module_ids.lock().unwrap().insert((input_id, return_id), mid);
            }
        } else {
            if let Some(mid) = state.send_module_ids.lock().unwrap().remove(&(input_id, return_id)) {
                std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn_detached();
                debug!("Removed loopback input {} → return {}", input_id, return_id);
            }
        }
    }
}

#[tauri::command]
pub fn set_strip_volume(state: State<AppState>, id: u32, is_input: bool, volume: f32) {
    let sink_info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let (sink, pan, muted) = if is_input {
            let ch = cfg.input_channels.iter_mut().find(|c| c.id == id);
            match ch {
                Some(c) => {
                    c.fader = volume.clamp(0.0, 4.0);
                    (Some(c.sink_name.clone()), c.pan, c.muted)
                }
                None => (None, 0.0, false),
            }
        } else {
            let r = cfg.return_channels.iter_mut().find(|r| r.id == id);
            match r {
                Some(r) => {
                    r.fader = volume.clamp(0.0, 4.0);
                    (Some(r.sink_name.clone()), r.pan, r.muted)
                }
                None => (None, 0.0, false),
            }
        };
        cfg.save();
        sink.map(|s| (s, volume.clamp(0.0, 4.0), pan, muted))
    };

    if let Some((sink, fader, pan, muted)) = sink_info {
        let solos = state.solo_set.lock().unwrap();
        let key = strip_key(is_input, id);
        let effective_mute = muted || (!solos.is_empty() && !solos.contains(&key));
        apply_strip_pactl(&sink, fader, pan, effective_mute);
    }
}

#[tauri::command]
pub fn set_strip_pan(state: State<AppState>, id: u32, is_input: bool, pan: f32) {
    let info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let (sink, fader, muted) = if is_input {
            let ch = cfg.input_channels.iter_mut().find(|c| c.id == id);
            match ch {
                Some(c) => { c.pan = pan.clamp(-1.0, 1.0); (Some(c.sink_name.clone()), c.fader, c.muted) }
                None => (None, 1.0, false),
            }
        } else {
            let r = cfg.return_channels.iter_mut().find(|r| r.id == id);
            match r {
                Some(r) => { r.pan = pan.clamp(-1.0, 1.0); (Some(r.sink_name.clone()), r.fader, r.muted) }
                None => (None, 1.0, false),
            }
        };
        cfg.save();
        sink.map(|s| (s, fader, pan.clamp(-1.0, 1.0), muted))
    };

    if let Some((sink, fader, pan, muted)) = info {
        let solos = state.solo_set.lock().unwrap();
        let key = strip_key(is_input, id);
        let effective_mute = muted || (!solos.is_empty() && !solos.contains(&key));
        apply_strip_pactl(&sink, fader, pan, effective_mute);
    }
}

#[tauri::command]
pub fn set_strip_mute(state: State<AppState>, id: u32, is_input: bool, muted: bool) {
    let info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let (sink, fader, pan) = if is_input {
            let ch = cfg.input_channels.iter_mut().find(|c| c.id == id);
            match ch {
                Some(c) => { c.muted = muted; (Some(c.sink_name.clone()), c.fader, c.pan) }
                None => (None, 1.0, 0.0),
            }
        } else {
            let r = cfg.return_channels.iter_mut().find(|r| r.id == id);
            match r {
                Some(r) => { r.muted = muted; (Some(r.sink_name.clone()), r.fader, r.pan) }
                None => (None, 1.0, 0.0),
            }
        };
        cfg.save();
        sink.map(|s| (s, fader, pan))
    };

    if let Some((sink, fader, pan)) = info {
        let solos = state.solo_set.lock().unwrap();
        let key = strip_key(is_input, id);
        let effective_mute = muted || (!solos.is_empty() && !solos.contains(&key));
        apply_strip_pactl(&sink, fader, pan, effective_mute);
    }
}

#[tauri::command]
pub fn set_strip_solo(state: State<AppState>, id: u32, is_input: bool, solo: bool) {
    let key = strip_key(is_input, id);
    {
        let mut s = state.solo_set.lock().unwrap();
        if solo { s.insert(key); } else { s.remove(&key); }
    }
    reapply_solo_mutes(&state);
}

#[tauri::command]
pub fn get_solo_set(state: State<AppState>) -> Vec<String> {
    state.solo_set.lock().unwrap().iter().cloned().collect()
}

// ---------------------------------------------------------------------------
// MIDI channel strip controls (volume/pan/mute/solo). Separate from
// `set_strip_*` because those take a 2-way `is_input: bool` baked into
// their signature and callers throughout the mixer UI — adding a third
// channel kind there would mean touching every call site instead of just
// this one. Same underlying `apply_strip_pactl` / solo-set mechanics.
// ---------------------------------------------------------------------------

fn midi_strip_key(id: u32) -> String {
    format!("midi:{}", id)
}

#[tauri::command]
pub fn midi_channel_set_volume(state: State<AppState>, id: u32, volume: f32) {
    let info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let Some(c) = cfg.midi_channels.iter_mut().find(|c| c.id == id) else { return };
        c.fader = volume.clamp(0.0, 4.0);
        let info = (c.sink_name.clone(), c.fader, c.pan, c.muted);
        cfg.save();
        info
    };
    apply_strip_pactl(&info.0, info.1, info.2, info.3);
}

#[tauri::command]
pub fn midi_channel_set_pan(state: State<AppState>, id: u32, pan: f32) {
    let info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let Some(c) = cfg.midi_channels.iter_mut().find(|c| c.id == id) else { return };
        c.pan = pan.clamp(-1.0, 1.0);
        let info = (c.sink_name.clone(), c.fader, c.pan, c.muted);
        cfg.save();
        info
    };
    apply_strip_pactl(&info.0, info.1, info.2, info.3);
}

#[tauri::command]
pub fn midi_channel_set_mute(state: State<AppState>, id: u32, muted: bool) {
    let info = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let Some(c) = cfg.midi_channels.iter_mut().find(|c| c.id == id) else { return };
        c.muted = muted;
        let info = (c.sink_name.clone(), c.fader, c.pan);
        cfg.save();
        info
    };
    let solos = state.solo_set.lock().unwrap();
    let key = midi_strip_key(id);
    let effective_mute = muted || (!solos.is_empty() && !solos.contains(&key));
    apply_strip_pactl(&info.0, info.1, info.2, effective_mute);
}

#[tauri::command]
pub fn midi_channel_set_solo(state: State<AppState>, id: u32, solo: bool) {
    let key = midi_strip_key(id);
    {
        let mut s = state.solo_set.lock().unwrap();
        if solo { s.insert(key); } else { s.remove(&key); }
    }
    reapply_solo_mutes(&state);
}

#[tauri::command]
pub fn set_master_volume(state: State<AppState>, volume: f32) {
    let (fader, pan, muted) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.master_fader = volume.clamp(0.0, 4.0);
        cfg.save();
        (cfg.master_fader, cfg.master_pan, cfg.master_muted)
    };
    apply_strip_pactl(MASTER_SINK_NAME, fader, pan, muted);
}

#[tauri::command]
pub fn set_master_pan(state: State<AppState>, pan: f32) {
    let (fader, p, muted) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.master_pan = pan.clamp(-1.0, 1.0);
        cfg.save();
        (cfg.master_fader, cfg.master_pan, cfg.master_muted)
    };
    apply_strip_pactl(MASTER_SINK_NAME, fader, p, muted);
}

#[tauri::command]
pub fn set_master_mute(state: State<AppState>, muted: bool) {
    let (fader, pan, m) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.master_muted = muted;
        cfg.save();
        (cfg.master_fader, cfg.master_pan, cfg.master_muted)
    };
    apply_strip_pactl(MASTER_SINK_NAME, fader, pan, m);
}

#[tauri::command]
pub fn set_send_level(state: State<AppState>, input_id: u32, return_id: u32, level: f32) {
    {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.set_send_level(input_id, return_id, level);
        cfg.save();
    }
    let mid = state.send_module_ids.lock().unwrap().get(&(input_id, return_id)).copied();
    if let Some(mid) = mid {
        set_loopback_volume(mid, level);
    }
}

#[tauri::command]
pub fn set_master_sink(state: State<AppState>, sink_name: Option<String>) {
    // Persist new hw output choice first; everything else recreates around it.
    {
        let mut cfg = state.mixer_config.lock().unwrap();
        cfg.master_sink = sink_name.clone();
        cfg.save();
    }

    // Tear down the existing master null-sink + loopback (also drops all
    // sink-inputs feeding it from returns/inputs).
    let had_master = state.master_null_module.lock().unwrap().is_some();
    destroy_master_modules(&state);
    if had_master {
        state.meter_handles.lock().unwrap().remove(MASTER_SINK_NAME);
    }

    // Spawn the new master modules. Reactive NodeAdded in handle_pw_event will:
    //   - start the master meter on audibian_master.monitor
    //   - connect each return remap-source (send_to_master=true) to audibian_master
    //   - connect each input null-sink monitor (send_to_master=true) to audibian_master
    if let Some(hw) = sink_name.as_ref() {
        if let Some((null_id, lb_id)) = create_master_modules(hw) {
            *state.master_null_module.lock().unwrap() = Some(null_id);
            *state.master_loopback_module.lock().unwrap() = Some(lb_id);
        }
    }
}

#[tauri::command]
pub fn set_volume(node_name: String, volume: f64) {
    set_volume_pactl(&node_name, volume);
}

#[tauri::command]
pub fn set_mute(node_name: String, muted: bool) {
    set_mute_pactl(&node_name, muted);
}

#[tauri::command]
pub fn set_input_source(state: State<AppState>, id: u32, source_name: Option<String>) {
    let (sink_name, mono) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let mono = cfg.input_channels.iter().find(|c| c.id == id).map(|c| c.mono).unwrap_or(false);
        let sink = cfg.input_channels.iter().find(|c| c.id == id).map(|c| c.sink_name.clone());
        if let Some(ch) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
            ch.source_name = source_name.clone();
        }
        cfg.save();
        (sink, mono)
    };

    // Unload existing source loopback
    if let Some(mid) = state.input_source_ids.lock().unwrap().remove(&id) {
        std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn_detached();
    }

    // Create new source loopback if source and sink exist
    if let (Some(src), Some(sink)) = (source_name, sink_name) {
        if let Some(mid) = create_source_loopback(&src, &sink, mono) {
            debug!("Created source loopback {} → {} (mono={}) as module {}", src, sink, mono, mid);
            state.input_source_ids.lock().unwrap().insert(id, mid);
        }
    }
}

#[tauri::command]
pub fn set_input_mono(state: State<AppState>, id: u32, mono: bool) {
    let (source_name, sink_name) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(ch) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
            ch.mono = mono;
        }
        cfg.save();
        let ch = cfg.input_channels.iter().find(|c| c.id == id);
        let src = ch.and_then(|c| c.source_name.clone());
        let sink = ch.map(|c| c.sink_name.clone());
        (src, sink)
    };

    // Reload source loopback with new mono setting
    if let Some(mid) = state.input_source_ids.lock().unwrap().remove(&id) {
        std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn_detached();
    }
    if let (Some(src), Some(sink)) = (source_name, sink_name) {
        if let Some(mid) = create_source_loopback(&src, &sink, mono) {
            debug!("Reloaded source loopback {} → {} (mono={}) as module {}", src, sink, mono, mid);
            state.input_source_ids.lock().unwrap().insert(id, mid);
        }
    }
}

#[tauri::command]
pub fn set_return_send_to_master(state: State<AppState>, id: u32, _send_to_master: bool) {
    // Returns are not allowed to route to the master bus. Keep the flag off
    // in config and tear down any stale loopback if one exists.
    let sink_name = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(r) = cfg.return_channels.iter_mut().find(|r| r.id == id) {
            r.send_to_master = false;
        }
        cfg.save();
        cfg.return_channels.iter().find(|r| r.id == id).map(|r| r.sink_name.clone())
    };

    if let Some(sink) = sink_name {
        let src_name = format!("{}_src", sink);
        let graph = state.graph.lock().unwrap();
        disconnect_nodes(&graph, &src_name, MASTER_SINK_NAME, &state.pw);
    }
}

#[tauri::command]
pub fn set_input_send_to_master(state: State<AppState>, id: u32, send_to_master: bool) {
    let input_sink = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(c) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
            c.send_to_master = send_to_master;
        }
        cfg.save();
        cfg.input_channels.iter().find(|c| c.id == id).map(|c| c.sink_name.clone())
    };

    if let Some(sink) = input_sink {
        let graph = state.graph.lock().unwrap();
        if send_to_master {
            connect_nodes(&graph, &sink, MASTER_SINK_NAME, &state.pw, false);
        } else {
            disconnect_nodes(&graph, &sink, MASTER_SINK_NAME, &state.pw);
        }
    }
}

#[tauri::command]
pub fn reorder_channels(
    state: State<AppState>,
    input_order: Vec<u32>,
    return_order: Vec<u32>,
) {
    let mut cfg = state.mixer_config.lock().unwrap();
    for (i, id) in input_order.iter().enumerate() {
        if let Some(ch) = cfg.input_channels.iter_mut().find(|c| c.id == *id) {
            ch.order = i as u32;
        }
    }
    for (i, id) in return_order.iter().enumerate() {
        if let Some(r) = cfg.return_channels.iter_mut().find(|r| r.id == *id) {
            r.order = i as u32;
        }
    }
    cfg.save();
}

#[tauri::command]
pub fn set_channel_color(
    state: State<AppState>,
    id: u32,
    is_input: bool,
    color: String,
) {
    let mut cfg = state.mixer_config.lock().unwrap();
    if is_input {
        if let Some(ch) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
            ch.color = Some(color);
        }
    } else {
        if let Some(r) = cfg.return_channels.iter_mut().find(|r| r.id == id) {
            r.color = Some(color);
        }
    }
    cfg.save();
}

#[tauri::command]
pub fn set_global_scale(state: State<AppState>, scale: f32) {
    let mut cfg = state.mixer_config.lock().unwrap();
    cfg.global_scale = scale.clamp(0.5, 2.5);
    cfg.save();
}

// ---------------------------------------------------------------------------
// Per-strip EQ (filter-chain) + routing relink
// ---------------------------------------------------------------------------

/// Effective monitoring source name for an input strip, given its EQ state.
fn input_source_for(ch: &crate::mixer::InputChannel) -> String {
    match &ch.eq {
        Some(eq) if eq.enabled => crate::audio::strip_eq::StripEqInstance::source_name_for(&ch.sink_name),
        _ => format!("{}.monitor", ch.sink_name),
    }
}

/// Tear down all current outbound links/loopbacks of an input strip, then
/// recreate them sourcing from `source_name`. Sends keep their stored level.
fn regenerate_input_routing(state: &AppState, ch_id: u32) {
    let (sink_name, source_name, send_to_master, sends_for_strip) = {
        let cfg = state.mixer_config.lock().unwrap();
        let ch = match cfg.input_channels.iter().find(|c| c.id == ch_id) {
            Some(c) => c.clone(),
            None => return,
        };
        let sends: Vec<(u32, String, f32)> = cfg.sends.iter()
            .filter(|s| s.input_channel_id == ch_id)
            .filter_map(|s| {
                let ret = cfg.return_channels.iter().find(|r| r.id == s.return_channel_id)?;
                Some((s.return_channel_id, ret.sink_name.clone(), s.level))
            })
            .collect();
        (ch.sink_name.clone(), input_source_for(&ch), ch.send_to_master, sends)
    };

    // 1. Unload existing send loopbacks for this strip.
    {
        let mut send_mods = state.send_module_ids.lock().unwrap();
        let keys: Vec<(u32, u32)> = send_mods.keys()
            .filter(|(inp, _)| *inp == ch_id).cloned().collect();
        for key in keys {
            if let Some(mid) = send_mods.remove(&key) {
                std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn_detached();
            }
        }
    }

    // 2. Disconnect any existing links from sink or eq-source to master.
    {
        let graph = state.graph.lock().unwrap();
        let eq_source = crate::audio::strip_eq::StripEqInstance::source_name_for(&sink_name);
        disconnect_nodes(&graph, &sink_name, MASTER_SINK_NAME, &state.pw);
        disconnect_nodes(&graph, &eq_source, MASTER_SINK_NAME, &state.pw);
    }

    // 3. Recreate send loopbacks from new source.
    for (ret_id, ret_sink, level) in sends_for_strip {
        if let Some(mid) = create_loopback(&source_name, &ret_sink) {
            if (level - 1.0).abs() > f32::EPSILON {
                set_loopback_volume(mid, level);
            }
            state.send_module_ids.lock().unwrap().insert((ch_id, ret_id), mid);
        }
    }

    // 4. Recreate input → master from new source.
    if send_to_master {
        let graph = state.graph.lock().unwrap();
        connect_nodes(&graph, &source_name, MASTER_SINK_NAME, &state.pw, false);
    }
}

#[tauri::command]
pub fn set_strip_eq(
    state: State<AppState>,
    id: u32,
    is_input: bool,
    eq: crate::mixer::StripEq,
) {
    if !is_input {
        // Return strip EQ deferred to v2: needs remap-source rewiring.
        log::warn!("set_strip_eq: return-strip EQ not yet implemented");
        return;
    }

    let (sink_name, sample_rate) = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let sink_name = match cfg.input_channels.iter_mut().find(|c| c.id == id) {
            Some(c) => {
                c.eq = Some(eq.clone());
                c.sink_name.clone()
            }
            None => return,
        };
        cfg.save();
        (sink_name, 48000u32)
    };

    let key = strip_key(true, id);
    // Drop any existing instance for a clean restart.
    state.strip_eq_instances.lock().unwrap().remove(&key);

    if eq.enabled {
        if let Some(inst) = crate::audio::strip_eq::start_strip_eq(&sink_name, &eq.bands, sample_rate) {
            state.strip_eq_instances.lock().unwrap().insert(key, inst);
        }
    }

    // Wait for the filter-chain source to register, then relink.
    let mixer_cfg = state.mixer_config.clone();
    let send_ids = state.send_module_ids.clone();
    let graph_ref = state.graph.clone();
    let pw_ref = state.pw.clone();
    let was_enabled = eq.enabled;
    std::thread::spawn(move || {
        if was_enabled {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let cfg = mixer_cfg.lock().unwrap().clone();
        let ch = match cfg.input_channels.iter().find(|c| c.id == id) {
            Some(c) => c.clone(),
            None => return,
        };
        let source_name = input_source_for(&ch);
        let sends: Vec<(u32, String, f32)> = cfg.sends.iter()
            .filter(|s| s.input_channel_id == id)
            .filter_map(|s| {
                let ret = cfg.return_channels.iter().find(|r| r.id == s.return_channel_id)?;
                Some((s.return_channel_id, ret.sink_name.clone(), s.level))
            })
            .collect();

        {
            let mut send_mods = send_ids.lock().unwrap();
            let keys: Vec<(u32, u32)> = send_mods.keys()
                .filter(|(inp, _)| *inp == id).cloned().collect();
            for key in keys {
                if let Some(mid) = send_mods.remove(&key) {
                    std::process::Command::new("pactl")
                        .args(["unload-module", &mid.to_string()])
                        .spawn_detached();
                }
            }
        }
        {
            let graph = graph_ref.lock().unwrap();
            let eq_source = crate::audio::strip_eq::StripEqInstance::source_name_for(&ch.sink_name);
            disconnect_nodes(&graph, &ch.sink_name, MASTER_SINK_NAME, &pw_ref);
            disconnect_nodes(&graph, &eq_source, MASTER_SINK_NAME, &pw_ref);
        }
        for (ret_id, ret_sink, level) in sends {
            if let Some(mid) = create_loopback(&source_name, &ret_sink) {
                if (level - 1.0).abs() > f32::EPSILON {
                    set_loopback_volume(mid, level);
                }
                send_ids.lock().unwrap().insert((id, ret_id), mid);
            }
        }
        if ch.send_to_master {
            let graph = graph_ref.lock().unwrap();
            connect_nodes(&graph, &source_name, MASTER_SINK_NAME, &pw_ref, false);
        }
    });

    let _ = regenerate_input_routing;
}

// ---------------------------------------------------------------------------
// Internal: restore mixer sends on startup via module-loopback
// ---------------------------------------------------------------------------

pub fn restore_mixer_sends(
    cfg: &crate::mixer::MixerConfig,
    send_module_ids: &std::sync::Arc<std::sync::Mutex<std::collections::HashMap<(u32, u32), u32>>>,
) {
    for send in &cfg.sends {
        let src = cfg.input_channels.iter().find(|c| c.id == send.input_channel_id);
        let dst = cfg.return_channels.iter().find(|r| r.id == send.return_channel_id);
        if let (Some(inp), Some(ret)) = (src, dst) {
            let monitor = format!("{}.monitor", inp.sink_name);
            if let Some(mid) = create_loopback(&monitor, &ret.sink_name) {
                send_module_ids.lock().unwrap().insert((inp.id, ret.id), mid);
            }
        }
    }
}


// ---------------------------------------------------------------------------
// PipeWire link helpers
// ---------------------------------------------------------------------------

pub(crate) fn connect_nodes(graph: &AudioGraph, src_name: &str, dst_name: &str, pw: &PwThread, mono_expand: bool) {
    let src = graph.nodes.values().find(|n| n.name == src_name);
    let dst = graph.nodes.values().find(|n| n.name == dst_name);
    if let (Some(src), Some(dst)) = (src, dst) {
        let outs = graph.output_ports_for_node(src.id);
        let ins = graph.input_ports_for_node(dst.id);
        if mono_expand {
            for out_p in &outs {
                for in_p in &ins {
                    pw.send(PwCommand::CreateLink {
                        output_port_id: out_p.id,
                        input_port_id: in_p.id,
                    });
                }
            }
        } else {
            for (i, out_p) in outs.iter().enumerate() {
                if let Some(in_p) = ins.get(i).or_else(|| ins.first()) {
                    pw.send(PwCommand::CreateLink {
                        output_port_id: out_p.id,
                        input_port_id: in_p.id,
                    });
                }
            }
        }
    }
}

/// True when `name` is one of the mixer's own sinks (a strip, a return bus or
/// the master bus) — i.e. a node whose audio already reaches the hardware
/// through `audibian_master`.
pub(crate) fn is_audibian_sink(cfg: &crate::mixer::MixerConfig, name: &str) -> bool {
    name == MASTER_SINK_NAME
        || cfg.input_channels.iter().any(|c| c.sink_name == name)
        || cfg.return_channels.iter().any(|r| r.sink_name == name)
}

/// The mixer sink a stream currently plays into, if any.
fn strip_target_of(
    graph: &AudioGraph,
    cfg: &crate::mixer::MixerConfig,
    stream_node_id: u32,
) -> Option<u32> {
    graph.links.values()
        .filter(|l| l.output_node_id == stream_node_id)
        .find_map(|l| {
            let node = graph.nodes.get(&l.input_node_id)?;
            is_audibian_sink(cfg, &node.name).then_some(node.id)
        })
}

/// True when `name` is a source the mixer exposes to applications: a return
/// bus remap-source (`audibian_return_N_src`).
pub(crate) fn is_audibian_source(cfg: &crate::mixer::MixerConfig, name: &str) -> bool {
    cfg.return_channels.iter().any(|r| format!("{}_src", r.sink_name) == name)
}

/// The mixer source a capture stream currently records from, if any.
fn capture_source_of(
    graph: &AudioGraph,
    cfg: &crate::mixer::MixerConfig,
    stream_node_id: u32,
) -> Option<u32> {
    graph.links.values()
        .filter(|l| l.input_node_id == stream_node_id)
        .find_map(|l| {
            let node = graph.nodes.get(&l.output_node_id)?;
            is_audibian_source(cfg, &node.name).then_some(node.id)
        })
}

/// The node a `pactl` module carries its audio over to. Both modules the mixer
/// is built on show up as two nodes with no link between them, so a plain link
/// walk stops dead at every send, mic feed and return bus:
///
///   - `module-loopback`: `input.loopback-N` swallows, `output.loopback-N` emits.
///   - `module-remap-source`: `input.audibian_return_N_src` swallows, the source
///     `audibian_return_N_src` is what applications record from.
fn module_peer(graph: &AudioGraph, node_id: u32) -> Option<u32> {
    let rest = graph.nodes.get(&node_id)?.name.strip_prefix("input.")?.to_string();
    let out_side = format!("output.{rest}");
    graph.nodes.values()
        .find(|n| n.name == out_side || n.name == rest)
        .map(|n| n.id)
}

/// Whether audio leaving `from` ends up at `to`, following links downstream and
/// bridging the mixer's loopback / remap-source module pairs.
fn signal_reaches(graph: &AudioGraph, from: u32, to: u32) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::from([from]);
    while let Some(id) = queue.pop_front() {
        if id == to { return true; }
        if !seen.insert(id) { continue; }
        for link in graph.links.values().filter(|l| l.output_node_id == id) {
            queue.push_back(link.input_node_id);
        }
        if let Some(peer) = module_peer(graph, id) {
            queue.push_back(peer);
        }
    }
    false
}

/// True when linking `src_node` → `dst_node` would deliver a signal that
/// already gets there by another route, i.e. the destination would hear it
/// twice with different latency.
pub(crate) fn link_would_duplicate(
    graph: &AudioGraph,
    cfg: &crate::mixer::MixerConfig,
    src_id: u32,
    dst_id: u32,
) -> bool {
    // Playback: the source is an app stream living in a strip, and the strip's
    // output already reaches this destination through the master bus.
    if let Some(strip_id) = strip_target_of(graph, cfg, src_id) {
        if strip_id != dst_id && signal_reaches(graph, strip_id, dst_id) {
            return true;
        }
    }
    // Capture: the destination is an app already recording from one of our
    // return buses, and this source is part of what that bus carries.
    if let Some(our_src) = capture_source_of(graph, cfg, dst_id) {
        if our_src != src_id && signal_reaches(graph, src_id, our_src) {
            return true;
        }
    }
    false
}

/// An application stream that plays into a strip must not also reach the
/// hardware directly, and an application recording from a return bus must not
/// also record the raw microphone: in both cases the same audio arrives twice a
/// few ms apart, which sounds like a doubled/robotic signal.
///
/// These duplicates come from links that outlive a stream being moved into a
/// strip, and from stale Matrix entries restored on the app's next launch.
/// The mixer's own path always wins; the redundant one is cut. Links carrying
/// a genuinely different signal are left alone.
///
/// Returns the names of the nodes that were disconnected.
pub(crate) fn enforce_single_route(
    graph: &AudioGraph,
    pw: &PwThread,
    cfg: &crate::mixer::MixerConfig,
    stream_node_id: u32,
) -> Vec<String> {
    let mut cut = Vec::new();
    for (link_id, peer_name) in duplicate_links_of(graph, cfg, stream_node_id) {
        pw.send(PwCommand::DestroyLink { link_id });
        if !cut.contains(&peer_name) {
            cut.push(peer_name);
        }
    }
    cut
}

/// The links of `stream_node_id` that carry audio the other end already gets
/// through the mixer, as `(link id, name of the node on the other end)`.
fn duplicate_links_of(
    graph: &AudioGraph,
    cfg: &crate::mixer::MixerConfig,
    stream_node_id: u32,
) -> Vec<(u32, String)> {
    let mut dupes = Vec::new();
    for link in graph.links.values() {
        let peer_id = if link.output_node_id == stream_node_id {
            link.input_node_id
        } else if link.input_node_id == stream_node_id {
            link.output_node_id
        } else {
            continue;
        };
        if !link_would_duplicate(graph, cfg, link.output_node_id, link.input_node_id) {
            continue;
        }
        if let Some(peer) = graph.nodes.get(&peer_id) {
            dupes.push((link.id, peer.name.clone()));
        }
    }
    dupes
}

pub(crate) fn disconnect_nodes(graph: &AudioGraph, src_name: &str, dst_name: &str, pw: &PwThread) {
    let src = graph.nodes.values().find(|n| n.name == src_name);
    let dst = graph.nodes.values().find(|n| n.name == dst_name);
    if let (Some(src), Some(dst)) = (src, dst) {
        for link in graph.links.values() {
            if link.output_node_id == src.id && link.input_node_id == dst.id {
                pw.send(PwCommand::DestroyLink { link_id: link.id });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Auto-routing
// ---------------------------------------------------------------------------

/// Move a Stream/Output (app playback stream) to a specific sink by name.
pub fn move_stream_to_sink(stream_id: u32, sink_name: &str) {
    std::process::Command::new("pactl")
        .args(["move-sink-input", &stream_id.to_string(), sink_name])
        .spawn_detached();
}

/// Decide which strip's sink should host a new stream based on the strip's
/// `app_match_rules` (case-insensitive substring against `app_name`). Falls back
/// to the strip flagged `is_default`. Returns the sink name to move into.
pub fn pick_strip_sink_for_app(
    cfg: &crate::mixer::MixerConfig,
    app_name: &str,
) -> Option<String> {
    let lower = app_name.to_lowercase();
    let by_rule = cfg.input_channels.iter()
        .find(|c| c.app_match_rules.iter().any(|r| !r.is_empty() && lower.contains(&r.to_lowercase())))
        .map(|c| c.sink_name.clone());
    if by_rule.is_some() { return by_rule; }
    cfg.input_channels.iter()
        .find(|c| c.is_default)
        .map(|c| c.sink_name.clone())
}

#[tauri::command]
pub fn move_app_to_strip(stream_id: u32, sink_name: String) {
    move_stream_to_sink(stream_id, &sink_name);
}

/// Parse `pactl list sink-inputs` and return `(sink_input_id, app_name, owner_module_id, current_sink)` tuples.
fn list_sink_inputs() -> Vec<(u32, String, Option<u32>, Option<u32>)> {
    let Ok(out) = std::process::Command::new("pactl").args(["list", "sink-inputs"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut result = Vec::new();
    let mut id: Option<u32> = None;
    let mut module: Option<u32> = None;
    let mut sink: Option<u32> = None;
    let mut app: String = String::new();

    let push = |result: &mut Vec<_>, id: Option<u32>, app: &str, module: Option<u32>, sink: Option<u32>| {
        if let Some(id) = id {
            result.push((id, app.to_string(), module, sink));
        }
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Sink Input #") {
            push(&mut result, id, &app, module, sink);
            id = rest.parse().ok();
            module = None;
            sink = None;
            app.clear();
        } else if let Some(rest) = trimmed.strip_prefix("Module: ") {
            module = rest.trim().parse().ok();
        } else if let Some(rest) = trimmed.strip_prefix("Sink: ") {
            sink = rest.trim().parse().ok();
        } else if let Some(rest) = trimmed.strip_prefix("application.name = ") {
            app = rest.trim().trim_matches('"').to_string();
        } else if app.is_empty() {
            if let Some(rest) = trimmed.strip_prefix("application.process.binary = ") {
                app = rest.trim().trim_matches('"').to_string();
            }
        }
    }
    push(&mut result, id, &app, module, sink);
    result
}

/// Resolve a sink name (`audibian_xxx`) to its current pactl sink id, if alive.
fn sink_name_to_id(name: &str) -> Option<u32> {
    let out = std::process::Command::new("pactl").args(["list", "short", "sinks"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut cols = line.split_whitespace();
        let id = cols.next()?.parse::<u32>().ok()?;
        let sink_name = cols.next()?;
        if sink_name == name {
            return Some(id);
        }
    }
    None
}

/// Reroute every existing app playback stream that is NOT already pointed at
/// one of our virtual sinks. Used at startup so apps that were already playing
/// (Spotify, browser, etc.) don't stay stuck on the old default sink.
#[tauri::command]
pub fn reroute_existing_streams(state: State<AppState>) -> usize {
    let cfg = state.mixer_config.lock().unwrap().clone();

    // Build a set of pactl sink ids that belong to Audibian so we don't bounce
    // already-routed streams.
    let mut audibian_sinks: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for c in &cfg.input_channels {
        if let Some(id) = sink_name_to_id(&c.sink_name) {
            audibian_sinks.insert(id);
        }
    }
    for r in &cfg.return_channels {
        if let Some(id) = sink_name_to_id(&r.sink_name) {
            audibian_sinks.insert(id);
        }
    }
    if let Some(id) = sink_name_to_id(MASTER_SINK_NAME) {
        audibian_sinks.insert(id);
    }

    // Skip our own internal modules (loopbacks, master loopback, send loopbacks).
    let mut moved = 0;
    for (si_id, app_name, _module, cur_sink) in list_sink_inputs() {
        if app_name.starts_with("audibian") || app_name == "Loopback" || app_name == "Loopback Streams" {
            continue;
        }
        if let Some(s) = cur_sink {
            if audibian_sinks.contains(&s) { continue; }
        }
        if let Some(sink) = pick_strip_sink_for_app(&cfg, &app_name) {
            move_stream_to_sink(si_id, &sink);
            moved += 1;
        }
    }
    moved
}

#[tauri::command]
pub fn set_input_match_rules(state: State<AppState>, id: u32, rules: Vec<String>) {
    let mut cfg = state.mixer_config.lock().unwrap();
    if let Some(c) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
        c.app_match_rules = rules;
    }
    cfg.save();
}

#[tauri::command]
pub fn set_input_is_default(state: State<AppState>, id: u32, is_default: bool) {
    let mut cfg = state.mixer_config.lock().unwrap();
    // Only one strip can be default at a time.
    if is_default {
        for c in cfg.input_channels.iter_mut() {
            c.is_default = c.id == id;
        }
    } else if let Some(c) = cfg.input_channels.iter_mut().find(|c| c.id == id) {
        c.is_default = false;
    }
    cfg.save();
}

// ---------------------------------------------------------------------------
// Master null-sink helpers
// ---------------------------------------------------------------------------

/// Internal node name of the master bus (audibian_master).
/// All strips with send_to_master loopback into this sink; its monitor is then
/// loopbacked to the user-selected hardware sink.
pub const MASTER_SINK_NAME: &str = "audibian_master";

/// Create the audibian_master null-sink + a loopback from its monitor to `hw_sink`.
/// Returns (null_sink_module_id, loopback_module_id) on success.
pub fn create_master_modules(hw_sink: &str) -> Option<(u32, u32)> {
    let null_id = create_null_sink(MASTER_SINK_NAME)?;
    let monitor = format!("{}.monitor", MASTER_SINK_NAME);
    let lb_id = create_loopback(&monitor, hw_sink)?;
    Some((null_id, lb_id))
}

/// Unload the master null-sink + loopback if they exist.
/// Clears the module-id slots in `AppState`.
pub fn destroy_master_modules(state: &AppState) {
    if let Some(id) = state.master_loopback_module.lock().unwrap().take() {
        unload_module(id);
    }
    if let Some(id) = state.master_null_module.lock().unwrap().take() {
        unload_module(id);
    }
}

// ---------------------------------------------------------------------------
// pactl helpers (pub so main.rs can call them)
// ---------------------------------------------------------------------------

pub fn cleanup_stale_modules() {
    let Ok(out) = std::process::Command::new("pactl")
        .args(["list", "modules", "short"])
        .output()
    else { return };

    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let is_stale =
            ((line.contains("module-null-sink") || line.contains("module-remap-source"))
                && (line.contains("audibian_return") || line.contains("audibian_")))
            || (line.contains("module-loopback") && line.contains("audibian_"));
        if is_stale {
            if let Some(id_str) = line.split('\t').next() {
                if let Ok(id) = id_str.trim().parse::<u32>() {
                    std::process::Command::new("pactl")
                        .args(["unload-module", &id.to_string()])
                        .spawn_detached();
                }
            }
        }
    }

    // Give pactl a moment to tear nodes down before scanning for orphans.
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Destroy any remaining `audibian_*` PipeWire nodes that no module owns.
    // These come from legacy static `~/.config/pipewire/pipewire.conf.d/
    // audibian-inputs.conf` drop-ins: they survive `unload-module` because
    // pipewire created them directly from context.objects, not via pactl.
    // Apps then resolve the `audibian_*` name to the lowest-id ghost and
    // audio dead-ends there because matrix links only target the runtime
    // sinks we just recreated.
    destroy_orphan_audibian_nodes();
}

fn destroy_orphan_audibian_nodes() {
    let Ok(out) = std::process::Command::new("pw-cli")
        .args(["ls", "Node"])
        .output()
    else { return };
    let txt = String::from_utf8_lossy(&out.stdout);

    let mut current_id: Option<u32> = None;
    let mut to_destroy: Vec<u32> = Vec::new();
    for raw in txt.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("id ") {
            current_id = rest.split(',').next()
                .and_then(|s| s.trim().parse::<u32>().ok());
        } else if line.starts_with("node.name = \"audibian_") {
            if let Some(id) = current_id.take() {
                to_destroy.push(id);
            }
        }
    }

    for id in to_destroy {
        std::process::Command::new("pw-cli")
            .args(["destroy", &id.to_string()])
            .spawn_detached();
    }
}

pub fn create_null_sink(sink_name: &str) -> Option<u32> {
    let out = std::process::Command::new("pactl")
        .args(["load-module", "module-null-sink", &format!("sink_name={}", sink_name)])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok()
}

/// Creates a module-remap-source so the null-sink's monitor appears as a
/// proper Audio/Source (virtual microphone) visible in all applications.
pub fn create_remap_source(monitor_name: &str, source_name: &str, description: &str) -> Option<u32> {
    let out = std::process::Command::new("pactl")
        .args([
            "load-module", "module-remap-source",
            &format!("source_name={}", source_name),
            &format!("master={}", monitor_name),
            &format!("source_properties=device.description=\"{}\"", description),
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok()
}

pub fn create_loopback(source: &str, sink: &str) -> Option<u32> {
    // latency_msec is the loopback module's internal target buffer, NOT the
    // user-visible end-to-end latency (PipeWire's quantum dictates that). A
    // value below ~1.5× quantum forces the loopback to refill faster than
    // the graph schedules it → snd_pcm_mmap_commit EPIPE storms on whichever
    // ALSA device sits at the end of the chain. 20ms covers quantum up to
    // 1024 samples @ 48k with margin and does not add audible delay.
    let out = std::process::Command::new("pactl")
        .args([
            "load-module", "module-loopback",
            &format!("source={}", source),
            &format!("sink={}", sink),
            "latency_msec=20",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok()
}

/// Find the sink-input id owned by a given module (typically a module-loopback).
/// Parses verbose `pactl list sink-inputs` because the short form omits owner module.
fn loopback_sink_input(module_id: u32) -> Option<u32> {
    let out = std::process::Command::new("pactl")
        .args(["list", "sink-inputs"])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut current: Option<u32> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Sink Input #") {
            current = rest.parse::<u32>().ok();
        } else if let Some(rest) = trimmed.strip_prefix("Module: ") {
            if let Ok(mid) = rest.trim().parse::<u32>() {
                if mid == module_id {
                    return current;
                }
            }
        }
    }
    None
}

/// Apply `volume` (1.0 = unity, max 4.0 = +12dB) to the sink-input owned by
/// `module_id`. Loopback creation is settled by the time `create_loopback`
/// returns, so this can be called immediately after.
pub fn set_loopback_volume(module_id: u32, volume: f32) {
    let Some(si) = loopback_sink_input(module_id) else { return };
    let pct = format!("{:.0}%", (volume.clamp(0.0, 4.0) * 100.0).round());
    std::process::Command::new("pactl")
        .args(["set-sink-input-volume", &si.to_string(), &pct])
        .spawn_detached();
}

pub fn create_source_loopback(source: &str, sink: &str, mono: bool) -> Option<u32> {
    let mut args = vec![
        "load-module".to_string(),
        "module-loopback".to_string(),
        format!("source={}", source),
        format!("sink={}", sink),
        // See create_loopback above for rationale on this value.
        "latency_msec=20".to_string(),
    ];
    if mono {
        args.push("channels=1".to_string());
        args.push("channel_map=mono".to_string());
    }
    let out = std::process::Command::new("pactl")
        .args(&args)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<u32>().ok()
}

/// Delete the legacy static `audibian-inputs.conf` pipewire drop-in.
/// Earlier versions wrote a context.objects file that declared null-sinks
/// statically; pipewire then created ghost sinks at startup with the same
/// `audibian_*` names as the runtime pactl modules. Apps (Spotify, etc.)
/// resolved the name to the static ghost — which had no monitor→master
/// route — so audio dead-ended and the runtime sinks stayed IDLE.
/// Runtime pactl modules created by `persistent::apply_persistent_state`
/// fully cover what the static conf did, so the file is now removed on every
/// configuration mutation and at startup to clear stale ghosts.
pub fn write_pipewire_conf(_input_channels: &[crate::mixer::InputChannel]) {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let path = std::path::PathBuf::from(&home)
        .join(".config/pipewire/pipewire.conf.d/audibian-inputs.conf");
    let _ = std::fs::remove_file(&path);
}

fn unload_module(module_id: u32) {
    std::process::Command::new("pactl")
        .args(["unload-module", &module_id.to_string()])
        .spawn_detached();
}

/// Push fader+pan+mute to a stereo sink via pactl per-channel volume.
/// Linear pan law: pan=-1 → only L, pan=+1 → only R, pan=0 → both equal.
pub fn apply_strip_pactl(sink: &str, fader: f32, pan: f32, muted: bool) {
    let f = fader.clamp(0.0, 4.0);
    let p = pan.clamp(-1.0, 1.0);
    let l = f * (1.0 - p.max(0.0));
    let r = f * (1.0 + p.min(0.0));
    let l_pct = format!("{:.0}%", (l * 100.0).round());
    let r_pct = format!("{:.0}%", (r * 100.0).round());
    std::process::Command::new("pactl")
        .args(["set-sink-volume", sink, &l_pct, &r_pct])
        .spawn_detached();
    let m = if muted { "1" } else { "0" };
    std::process::Command::new("pactl")
        .args(["set-sink-mute", sink, m])
        .spawn_detached();
    // Mute every sink-input currently feeding this sink (e.g. Spotify, browser).
    // Sink-mute alone is reliable on hardware sinks but on pipewire-pulse
    // null-sinks the propagation to active streams can lag until another
    // mute event is dispatched. Hitting the streams directly guarantees
    // the strip is silent immediately for any app routed into it.
    apply_sink_input_mute(sink, muted);
}

/// Mute/unmute every sink-input currently routed to `sink` via pactl.
/// Best-effort: runs `pactl list short sink-inputs`, filters by sink id.
fn apply_sink_input_mute(sink: &str, muted: bool) {
    let Some(sink_id) = lookup_sink_id(sink) else { return };
    let Ok(out) = std::process::Command::new("pactl")
        .args(["list", "short", "sink-inputs"])
        .output()
    else { return };
    let txt = String::from_utf8_lossy(&out.stdout);
    let m = if muted { "1" } else { "0" };
    for line in txt.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 { continue; }
        let Ok(si_id) = cols[0].parse::<u32>() else { continue };
        let Ok(si_sink) = cols[1].parse::<u32>() else { continue };
        if si_sink != sink_id { continue; }
        std::process::Command::new("pactl")
            .args(["set-sink-input-mute", &si_id.to_string(), m])
            .spawn_detached();
    }
}

fn lookup_sink_id(sink_name: &str) -> Option<u32> {
    let out = std::process::Command::new("pactl")
        .args(["list", "short", "sinks"])
        .output()
        .ok()?;
    let txt = String::from_utf8_lossy(&out.stdout);
    for line in txt.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 { continue; }
        if cols[1] == sink_name {
            return cols[0].parse().ok();
        }
    }
    None
}

/// Build the runtime solo key for a strip.
pub fn strip_key(is_input: bool, id: u32) -> String {
    if is_input { format!("in:{}", id) } else { format!("ret:{}", id) }
}

/// Re-apply effective mute to every strip given the current solo set:
///   effective_mute = config.muted OR (solo_set non-empty AND strip not in solo_set)
/// Master is never affected by solo.
fn reapply_solo_mutes(state: &AppState) {
    let cfg = state.mixer_config.lock().unwrap().clone();
    let solos = state.solo_set.lock().unwrap().clone();
    let any_solo = !solos.is_empty();

    for ch in &cfg.input_channels {
        let key = strip_key(true, ch.id);
        let effective = ch.muted || (any_solo && !solos.contains(&key));
        apply_strip_pactl(&ch.sink_name, ch.fader, ch.pan, effective);
    }
    for r in &cfg.return_channels {
        let key = strip_key(false, r.id);
        let effective = r.muted || (any_solo && !solos.contains(&key));
        apply_strip_pactl(&r.sink_name, r.fader, r.pan, effective);
    }
    for c in &cfg.midi_channels {
        let key = midi_strip_key(c.id);
        let effective = c.muted || (any_solo && !solos.contains(&key));
        apply_strip_pactl(&c.sink_name, c.fader, c.pan, effective);
    }
}

fn set_volume_pactl(node_name: &str, volume: f64) {
    let pct = format!("{:.0}%", (volume * 100.0).round());
    std::process::Command::new("pactl")
        .args(["set-sink-volume", node_name, &pct])
        .spawn_detached();
    std::process::Command::new("pactl")
        .args(["set-source-volume", node_name, &pct])
        .spawn_detached();
}

fn set_mute_pactl(node_name: &str, muted: bool) {
    let state = if muted { "1" } else { "0" };
    std::process::Command::new("pactl")
        .args(["set-sink-mute", node_name, state])
        .spawn_detached();
    std::process::Command::new("pactl")
        .args(["set-source-mute", node_name, state])
        .spawn_detached();
}

// ---------------------------------------------------------------------------
// Matrix config
// ---------------------------------------------------------------------------

/// Save persisted port-level connections for a src/dst node name pair.
/// `links` is a list of [src_port_name, dst_port_name] pairs from the frontend.
/// Passing an empty list removes the entry.
#[tauri::command]
pub fn save_matrix_connections(
    state: State<AppState>,
    src_node: String,
    dst_node: String,
    links: Vec<Vec<String>>,
) {
    let port_links: Vec<crate::matrix_config::PortLink> = links.iter()
        .filter_map(|pair| {
            if pair.len() >= 2 {
                Some(crate::matrix_config::PortLink { src: pair[0].clone(), dst: pair[1].clone() })
            } else {
                None
            }
        })
        .collect();
    let mut cfg = state.matrix_config.lock().unwrap();
    cfg.set_node_pair(&src_node, &dst_node, port_links);
    cfg.save();
}

#[tauri::command]
pub fn get_matrix_config(state: State<AppState>) -> crate::matrix_config::MatrixConfig {
    state.matrix_config.lock().unwrap().clone()
}

/// Re-create saved Matrix links involving `node_name` using current port IDs.
///
/// Connections that would deliver a signal the destination already receives
/// through the mixer are skipped — recreating them is what made an app play or
/// record its own audio twice (see `link_would_duplicate`).
pub fn restore_matrix_connections(
    matrix_cfg: &crate::matrix_config::MatrixConfig,
    graph: &AudioGraph,
    pw: &PwThread,
    mixer_cfg: &crate::mixer::MixerConfig,
    node_name: &str,
) {
    for conn in matrix_cfg.connections_involving(node_name) {
        let src = graph.nodes.values().find(|n| n.name == conn.src_node);
        let dst = graph.nodes.values().find(|n| n.name == conn.dst_node);
        if let (Some(src), Some(dst)) = (src, dst) {
            if link_would_duplicate(graph, mixer_cfg, src.id, dst.id) {
                debug!(
                    "Matrix: skipping '{}' → '{}', that signal already gets there through the mixer",
                    conn.src_node, conn.dst_node,
                );
                continue;
            }
            let src_ports = graph.output_ports_for_node(src.id);
            let dst_ports = graph.input_ports_for_node(dst.id);
            for link in &conn.links {
                let out_p = src_ports.iter().find(|p| p.name == link.src);
                let in_p = dst_ports.iter().find(|p| p.name == link.dst);
                if let (Some(out), Some(inp)) = (out_p, in_p) {
                    pw.send(PwCommand::CreateLink {
                        output_port_id: out.id,
                        input_port_id: inp.id,
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Soundboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn soundboard_list(state: State<AppState>) -> Vec<Sound> {
    state.soundboard_config.lock().unwrap().sounds.clone()
}

/// Open a native file picker (`zenity` then `kdialog` as fallback) and
/// return the chosen path(s). `--multiple` lets the user import a batch
/// from one dialog. Empty vec = cancelled / picker not installed.
#[tauri::command]
pub fn soundboard_pick_file() -> Vec<String> {
    let run = |bin: &str, args: &[&str], sep: &str| -> Option<Vec<String>> {
        let out = std::process::Command::new(bin).args(args).output().ok()?;
        if !out.status.success() { return None; }
        let s = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<String> = s.trim()
            .split(sep)
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect();
        if parts.is_empty() { None } else { Some(parts) }
    };
    run("zenity", &[
        "--file-selection",
        "--multiple",
        "--separator=\n",
        "--title=Audibian — Pick sounds",
        "--file-filter=Audio | *.mp3 *.wav *.ogg *.flac *.m4a *.opus",
        "--file-filter=All files | *",
    ], "\n")
    .or_else(|| run("kdialog", &[
        "--multiple",
        "--separator", "\n",
        "--getopenfilename", ".",
        "Audio (*.mp3 *.wav *.ogg *.flac *.m4a *.opus)",
    ], "\n"))
    .unwrap_or_default()
}

/// Register a sound. Reserves an id + final destination path, persists the
/// entry immediately so the UI updates without waiting, then copies the
/// file and probes its duration on a background thread. When the probe
/// finishes, mixer.toml gets a second save and the UI re-fetches to pick
/// up the duration. Returns the placeholder Sound (duration=None).
#[tauri::command]
pub fn soundboard_add(
    state: State<AppState>,
    source_path: String,
    display_name: Option<String>,
) -> Option<Sound> {
    let src = std::path::PathBuf::from(&source_path);
    if !src.is_file() { return None; }
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("snd").to_string();
    let dir = SoundboardConfig::sounds_dir();
    std::fs::create_dir_all(&dir).ok()?;

    let sound = {
        let mut cfg = state.soundboard_config.lock().unwrap();
        let id = cfg.next_id();
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
        let name = display_name.unwrap_or_else(|| stem.to_string());
        let dest = dir.join(format!("{}.{}", id, ext));
        let s = Sound {
            id,
            name,
            path: dest.to_string_lossy().to_string(),
            duration_ms: None,
            start_ms: None,
            end_ms: None,
        };
        cfg.sounds.push(s.clone());
        cfg.save();
        s
    };

    // Offload copy + probe to a worker so the tauri command thread returns
    // immediately. Large WAV imports no longer freeze the UI.
    let cfg_handle = state.soundboard_config.clone();
    let src_clone = src.clone();
    let id = sound.id;
    let dest_path = std::path::PathBuf::from(&sound.path);
    std::thread::spawn(move || {
        if std::fs::copy(&src_clone, &dest_path).is_err() {
            // Roll back the registration on copy failure.
            let mut cfg = cfg_handle.lock().unwrap();
            cfg.sounds.retain(|s| s.id != id);
            cfg.save();
            return;
        }
        let dur = probe_duration_ms(&dest_path);
        if dur.is_some() {
            let mut cfg = cfg_handle.lock().unwrap();
            if let Some(s) = cfg.sounds.iter_mut().find(|s| s.id == id) {
                s.duration_ms = dur;
                cfg.save();
            }
        }
    });

    Some(sound)
}

#[tauri::command]
pub fn soundboard_remove(state: State<AppState>, id: u32) {
    let mut cfg = state.soundboard_config.lock().unwrap();
    if let Some(pos) = cfg.sounds.iter().position(|s| s.id == id) {
        let s = cfg.sounds.remove(pos);
        let _ = std::fs::remove_file(&s.path);
        cfg.save();
    }
}

#[tauri::command]
pub fn soundboard_rename(state: State<AppState>, id: u32, name: String) {
    let mut cfg = state.soundboard_config.lock().unwrap();
    if let Some(s) = cfg.sounds.iter_mut().find(|s| s.id == id) {
        s.name = name;
        cfg.save();
    }
}

/// Set or clear the trim window. Either bound may be `None` to disable
/// that side (None/None plays the full file). Stored in milliseconds.
#[tauri::command]
pub fn soundboard_set_trim(
    state: State<AppState>,
    id: u32,
    start_ms: Option<u32>,
    end_ms: Option<u32>,
) {
    let mut cfg = state.soundboard_config.lock().unwrap();
    if let Some(s) = cfg.sounds.iter_mut().find(|s| s.id == id) {
        // Normalise: swap if reversed, drop end if <= start.
        let (a, b) = match (start_ms, end_ms) {
            (Some(a), Some(b)) if a > b => (Some(b), Some(a)),
            other => other,
        };
        s.start_ms = a;
        s.end_ms = match (a, b) {
            (Some(a), Some(b)) if b <= a => None,
            _ => b,
        };
        cfg.save();
    }
}

/// Play a sound by id into the soundboard sink. Untrimmed sounds run
/// `paplay` directly. Trimmed sounds pipe `ffmpeg -ss/-to … -f wav -`
/// into `paplay --raw`, so the cut happens on the fly without writing a
/// temp file. Tracks every child for stop-all.
#[tauri::command]
pub fn soundboard_play(state: State<AppState>, id: u32) {
    let sound = {
        let cfg = state.soundboard_config.lock().unwrap();
        match cfg.sounds.iter().find(|s| s.id == id) {
            Some(s) => s.clone(),
            None => return,
        }
    };

    reap_finished_soundboard_procs(&state);

    let trimmed = sound.start_ms.is_some() || sound.end_ms.is_some();
    if !trimmed {
        let child = std::process::Command::new("paplay")
            .args(["--device", SOUNDBOARD_SINK_NAME, &sound.path])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(child) = child {
            state.soundboard_procs.lock().unwrap().push(child);
        }
        return;
    }

    // Build the ffmpeg pipe. `-ss` before `-i` is a fast seek; pair with
    // `-to` (absolute end timestamp). Output s16le 48k stereo so paplay
    // doesn't need to negotiate format.
    let mut ff_args: Vec<String> = vec!["-nostdin".into(), "-loglevel".into(), "error".into()];
    if let Some(start) = sound.start_ms {
        ff_args.push("-ss".into());
        ff_args.push(format!("{:.3}", start as f64 / 1000.0));
    }
    ff_args.push("-i".into());
    ff_args.push(sound.path.clone());
    if let Some(end) = sound.end_ms {
        let start = sound.start_ms.unwrap_or(0);
        if end > start {
            ff_args.push("-t".into());
            ff_args.push(format!("{:.3}", (end - start) as f64 / 1000.0));
        }
    }
    ff_args.extend([
        "-f".into(), "s16le".into(),
        "-ar".into(), "48000".into(),
        "-ac".into(), "2".into(),
        "pipe:1".into(),
    ]);

    let ff = std::process::Command::new("ffmpeg")
        .args(&ff_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut ff = match ff { Ok(c) => c, Err(_) => return };
    let ff_stdout = match ff.stdout.take() { Some(s) => s, None => return };

    let pap = std::process::Command::new("paplay")
        .args([
            "--device", SOUNDBOARD_SINK_NAME,
            "--raw",
            "--format=s16le",
            "--rate=48000",
            "--channels=2",
        ])
        .stdin(ff_stdout)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    let mut procs = state.soundboard_procs.lock().unwrap();
    match pap {
        Ok(pap) => {
            procs.push(ff);
            procs.push(pap);
        }
        Err(_) => { let _ = ff.kill(); let _ = ff.wait(); }
    }
}

#[tauri::command]
pub fn soundboard_stop_all(state: State<AppState>) {
    let mut procs = state.soundboard_procs.lock().unwrap();
    for child in procs.iter_mut() {
        let _ = child.kill();
        // Reap before `clear` drops the handles, otherwise every stopped
        // sound leaves a defunct paplay/ffmpeg behind.
        let _ = child.wait();
    }
    procs.clear();
}

fn reap_finished_soundboard_procs(state: &State<AppState>) {
    let mut procs = state.soundboard_procs.lock().unwrap();
    procs.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
}

/// Run `ffprobe -show_entries format=duration` and parse the seconds
/// value into milliseconds. Returns None on any failure.
fn probe_duration_ms(path: &std::path::Path) -> Option<u32> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout);
    let secs: f64 = s.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 { return None; }
    Some((secs * 1000.0).round() as u32)
}

// ---------------------------------------------------------------------------
// MIDI / VST channels (in-process VST3 host — see `src/midi/`)
//
// Previously these channels spawned `carla-rack` and drove it over OSC.
// That's gone: the packaged `carla` build on this system has no OSC/liblo
// support compiled in at all (confirmed via `ldd` — zero `liblo` linkage —
// and empirically, no UDP socket ever opened on the configured OSC port
// regardless of which port was used), so every remote-control message sent
// nowhere. Plugins are now hosted directly inside audibian's own process.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn midi_channel_list(state: State<AppState>) -> Vec<MidiChannel> {
    state.mixer_config.lock().unwrap().midi_channels.clone()
}

/// Create a new MIDI strip. Reserves an id, creates the backing audibian
/// null-sink, wires its monitor → master so the strip is audible as soon
/// as a plugin is loaded. Does NOT load a plugin here — that happens on
/// `midi_plugin_load`, so headless boot is cheap.
#[tauri::command]
pub fn midi_channel_add(state: State<AppState>, name: Option<String>) -> Option<MidiChannel> {
    let ch = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let id = cfg.next_channel_id();
        let order = cfg.midi_channels.len() as u32;
        let display = name.unwrap_or_else(|| format!("MIDI {}", id));
        let sink_name = format!("audibian_midi_{}", id);
        let ch = MidiChannel {
            id,
            name: display,
            sink_name: sink_name.clone(),
            order,
            color: Some("#7a638a".to_string()),
            send_to_master: true,
            pan: 0.0,
            fader: 1.0,
            muted: false,
            plugins: Vec::new(),
            ..Default::default()
        };
        cfg.midi_channels.push(ch.clone());
        cfg.save();
        ch
    };

    let _ = create_null_sink(&ch.sink_name);

    // Auto-routing sink → master and meter spawning both happen reactively
    // in main.rs's PwEvent::NodeAdded handler once this sink actually shows
    // up in the graph (same mechanism `add_input_channel` relies on) — no
    // fixed-delay guess here.

    Some(ch)
}

#[tauri::command]
pub fn midi_channel_remove(state: State<AppState>, id: u32) {
    // Tear down any running plugin host for this channel first.
    if let Some(handle) = state.midi_plugin_hosts.lock().unwrap().remove(&id) {
        handle.stop();
    }

    let sink_name = {
        let mut cfg = state.mixer_config.lock().unwrap();
        let removed = cfg.midi_channels.iter()
            .find(|c| c.id == id)
            .map(|c| c.sink_name.clone());
        cfg.midi_channels.retain(|c| c.id != id);
        cfg.save();
        removed
    };

    if let Some(sink) = sink_name {
        // No persisted pactl module id for midi sinks (they're created
        // by persistent.rs / midi_channel_add), so address by name.
        if let Some(mid) = lookup_module_id_by_sink(&sink) {
            unload_module(mid);
        }
    }
}

/// Locate the pactl module-null-sink that owns a sink by name. Returns
/// None when the sink wasn't created via pactl (e.g. left over from a
/// previous session that lost its module).
fn lookup_module_id_by_sink(sink_name: &str) -> Option<u32> {
    let out = std::process::Command::new("pactl")
        .args(["list", "short", "modules"])
        .output()
        .ok()?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let needle = format!("sink_name={}", sink_name);
    for line in txt.lines() {
        if line.contains("module-null-sink") && line.contains(&needle) {
            if let Some(id_str) = line.split('\t').next() {
                if let Ok(id) = id_str.trim().parse::<u32>() {
                    return Some(id);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn midi_channel_rename(state: State<AppState>, id: u32, name: String) {
    let mut cfg = state.mixer_config.lock().unwrap();
    if let Some(c) = cfg.midi_channels.iter_mut().find(|c| c.id == id) {
        c.name = name;
        cfg.save();
    }
}

#[tauri::command]
pub fn midi_plugin_add(
    state: State<AppState>,
    channel_id: u32,
    format: String,
    identifier: String,
    name: Option<String>,
) -> Option<MidiPlugin> {
    let mut cfg = state.mixer_config.lock().unwrap();
    let ch = cfg.midi_channels.iter_mut().find(|c| c.id == channel_id)?;
    let pid = ch.next_plugin_id();
    let display = name.unwrap_or_else(|| {
        // Best-effort label: tail of URI or basename of path.
        identifier
            .rsplit_once('/')
            .map(|(_, t)| t.to_string())
            .unwrap_or_else(|| identifier.clone())
    });
    let plugin = MidiPlugin {
        id: pid,
        name: display,
        identifier,
        format,
    };
    ch.plugins.push(plugin.clone());
    cfg.save();
    Some(plugin)
}

#[tauri::command]
pub fn midi_plugin_remove(state: State<AppState>, channel_id: u32, plugin_id: u32) {
    let mut cfg = state.mixer_config.lock().unwrap();
    if let Some(ch) = cfg.midi_channels.iter_mut().find(|c| c.id == channel_id) {
        ch.plugins.retain(|p| p.id != plugin_id);
        cfg.save();
    }
}

/// Reorder the plugin chain. `plugin_ids` is the new order; any ids not
/// present in the channel are ignored, any missing existing ids stay at
/// their original tail position (defensive against UI/state drift).
#[tauri::command]
pub fn midi_plugin_reorder(state: State<AppState>, channel_id: u32, plugin_ids: Vec<u32>) {
    let mut cfg = state.mixer_config.lock().unwrap();
    let Some(ch) = cfg.midi_channels.iter_mut().find(|c| c.id == channel_id) else { return };
    let mut reordered: Vec<MidiPlugin> = Vec::with_capacity(ch.plugins.len());
    for id in &plugin_ids {
        if let Some(pos) = ch.plugins.iter().position(|p| p.id == *id) {
            reordered.push(ch.plugins.remove(pos));
        }
    }
    reordered.extend(ch.plugins.drain(..));
    ch.plugins = reordered;
    cfg.save();
}

/// List available VST3 bundles (fast filesystem scan — see
/// `midi::host::scan_paths`). Backs the "Add Plugin" picker.
#[tauri::command]
pub fn midi_plugin_scan() -> Vec<std::path::PathBuf> {
    crate::midi::host::scan_paths()
}

/// Load the channel's first plugin into the in-process host and start
/// producing audio into its sink. MVP: one plugin per channel — chaining
/// several in series is a later phase, so only `plugins[0]` is used.
/// Replaces any already-running host for this channel (relaunch = fresh
/// load, e.g. after picking a different plugin).
#[tauri::command]
pub fn midi_plugin_load(state: State<AppState>, channel_id: u32) -> bool {
    if let Some(handle) = state.midi_plugin_hosts.lock().unwrap().remove(&channel_id) {
        handle.stop();
    }

    let (sink_name, plugin_path) = {
        let cfg = state.mixer_config.lock().unwrap();
        let Some(ch) = cfg.midi_channels.iter().find(|c| c.id == channel_id) else { return false };
        let Some(p) = ch.plugins.first() else { return false };
        if p.format != "VST3" { return false; }
        (ch.sink_name.clone(), std::path::PathBuf::from(&p.identifier))
    };

    match crate::midi::host::PluginHostHandle::start(channel_id, &sink_name, &plugin_path) {
        Ok(handle) => {
            state.midi_plugin_hosts.lock().unwrap().insert(channel_id, handle);
            true
        }
        Err(e) => {
            debug!("midi_plugin_load {channel_id}: {e}");
            false
        }
    }
}

/// Stop the channel's running plugin (state is saved first — see
/// `PluginHostHandle::stop`) without removing the channel itself.
#[tauri::command]
pub fn midi_plugin_unload(state: State<AppState>, channel_id: u32) {
    if let Some(handle) = state.midi_plugin_hosts.lock().unwrap().remove(&channel_id) {
        handle.stop();
    }
}

/// Channel ids with a currently-running plugin host. The load state is
/// in-memory only (a fresh `PluginHostHandle`, not something persisted in
/// `MixerConfig`), so the UI polls this instead of inferring it from the
/// config it already has.
#[tauri::command]
pub fn midi_loaded_channel_ids(state: State<AppState>) -> Vec<u32> {
    state.midi_plugin_hosts.lock().unwrap().keys().copied().collect()
}

/// Fire a test MIDI note directly into a running channel's plugin. The live
/// keyboard bridge now feeds real MIDI input into loaded plugins, but this
/// remains a quick sanity check for instruments that are already loaded.
#[tauri::command]
pub fn midi_plugin_test_note(state: State<AppState>, channel_id: u32) -> bool {
    let hosts = state.midi_plugin_hosts.lock().unwrap();
    let Some(handle) = hosts.get(&channel_id) else { return false };
    let Ok(mut plugin) = handle.plugin.lock() else { return false };
    let _ = plugin.send_midi_note(60, 100, vst3_host::midi::MidiChannel::Ch1);
    true
}

/// Report whether the current session can embed plugin windows inline.
/// Always false for now — native GUI embedding (via `Plugin::open_editor` +
/// `WindowHandle::from_x11`, reusing `x11_embed.rs`) is a follow-up phase.
#[tauri::command]
pub fn midi_embed_available(_state: State<AppState>) -> bool {
    false
}

#[tauri::command]
pub fn midi_plugin_show_native_gui(state: State<AppState>, channel_id: u32, _plugin_id: u32) -> bool {
    // MVP hosts one plugin per channel, so `plugin_id` doesn't disambiguate
    // anything yet — matches `midi_plugin_load`.
    let hosts = state.midi_plugin_hosts.lock().unwrap();
    let Some(handle) = hosts.get(&channel_id) else { return false };
    match handle.show_gui() {
        Ok(()) => true,
        Err(e) => { debug!("midi_plugin_show_native_gui {channel_id}: {e}"); false }
    }
}

#[tauri::command]
pub fn midi_plugin_hide_native_gui(state: State<AppState>, channel_id: u32, _plugin_id: u32) -> bool {
    let hosts = state.midi_plugin_hosts.lock().unwrap();
    let Some(handle) = hosts.get(&channel_id) else { return false };
    handle.hide_gui();
    true
}

#[tauri::command]
pub fn midi_plugin_embed_gui(
    _state: State<AppState>,
    _channel_id: u32,
    _plugin_id: u32,
    _x: i32,
    _y: i32,
    _width: u32,
    _height: u32,
) -> bool {
    false
}

#[tauri::command]
pub fn midi_plugin_position_gui(
    _state: State<AppState>,
    _channel_id: u32,
    _plugin_id: u32,
    _x: i32,
    _y: i32,
    _width: u32,
    _height: u32,
) -> bool {
    false
}

#[tauri::command]
pub fn midi_plugin_unembed_gui(_state: State<AppState>, _channel_id: u32, _plugin_id: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::graph::{AudioLink, AudioNode, NodeType};

    fn node(id: u32, name: &str, media_class: &str) -> AudioNode {
        AudioNode {
            id,
            name: name.into(),
            nick: None,
            description: None,
            app_name: None,
            node_type: NodeType::Unknown,
            media_class: Some(media_class.into()),
            x: 0.0,
            y: 0.0,
            volume: 1.0,
            muted: false,
        }
    }

    fn link(id: u32, out_node: u32, in_node: u32) -> AudioLink {
        AudioLink {
            id,
            output_node_id: out_node,
            output_port_id: id * 100,
            input_node_id: in_node,
            input_port_id: id * 100 + 1,
            active: true,
        }
    }

    /// Mirrors the real setup: a Brave strip and a Discord return bus, mic
    /// feeding the strip and the strip feeding the master, master looped back
    /// to the hardware sink.
    ///
    /// ```text
    ///   Brave ──> audibian_brave ──> audibian_master ═loop 1═> hw sink
    ///   mic   ═loop 2═> audibian_microfono ──┘   └──═loop 3═> audibian_return_8
    ///                                                          ║ remap
    ///   Pianoteq ────────────────────────────────────────────> ║
    ///                                                    return_8_src ──> Discord
    /// ```
    fn fixture() -> (AudioGraph, crate::mixer::MixerConfig) {
        let mut cfg = crate::mixer::MixerConfig::default();
        cfg.input_channels = vec![
            serde_json::from_value(serde_json::json!({
                "id": 1, "name": "Brave", "sink_name": "audibian_brave"
            })).unwrap(),
            serde_json::from_value(serde_json::json!({
                "id": 2, "name": "Microfono", "sink_name": "audibian_microfono"
            })).unwrap(),
        ];
        cfg.return_channels = vec![
            serde_json::from_value(serde_json::json!({
                "id": 8, "name": "Discord", "sink_name": "audibian_return_8"
            })).unwrap(),
        ];

        let mut g = AudioGraph::new();
        for n in [
            node(1, "Brave", "Stream/Output"),
            node(2, "audibian_brave", "Audio/Sink"),
            node(3, "audibian_master", "Audio/Sink"),
            node(4, "input.loopback-1", "Stream/Input"),
            node(5, "output.loopback-1", "Stream/Output"),
            node(6, "hw_sink", "Audio/Sink"),
            node(7, "hw_mic", "Audio/Source"),
            node(8, "input.loopback-2", "Stream/Input"),
            node(9, "output.loopback-2", "Stream/Output"),
            node(10, "audibian_microfono", "Audio/Sink"),
            node(11, "input.loopback-3", "Stream/Input"),
            node(12, "output.loopback-3", "Stream/Output"),
            node(13, "audibian_return_8", "Audio/Sink"),
            node(14, "audibian_return_8_src", "Audio/Source"),
            node(15, "WEBRTC VoiceEngine", "Stream/Input"),
            node(16, "FluidSynth", "Stream/Output"),
            node(17, "input.audibian_return_8_src", "Stream/Input"),
            node(18, "alsa_playback.Pianoteq 9", "Stream/Output"),
        ] {
            g.add_node(n);
        }
        for l in [
            link(1, 1, 2),    // Brave      -> strip
            link(2, 2, 3),    // strip      -> master
            link(3, 3, 4),    // master     -> loopback 1 in
            link(4, 5, 6),    // loopback 1 -> hw sink
            link(5, 7, 8),    // mic        -> loopback 2 in
            link(6, 9, 10),   // loopback 2 -> mic strip
            link(7, 10, 3),   // mic strip  -> master
            link(8, 10, 11),  // mic strip  -> loopback 3 in (send)
            link(9, 12, 13),  // loopback 3 -> return bus
            link(10, 13, 17), // return bus -> remap source in
            link(11, 14, 15), // remap src  -> Discord capture
            link(12, 16, 6),  // FluidSynth -> hw sink
            link(13, 18, 17), // Pianoteq   -> return bus (remap source in)
        ] {
            g.add_link(l);
        }
        (g, cfg)
    }

    #[test]
    fn playback_duplicate_is_detected() {
        let (g, cfg) = fixture();
        // Brave already reaches the hardware through its strip and the master.
        assert!(link_would_duplicate(&g, &cfg, 1, 6));
    }

    #[test]
    fn capture_duplicate_is_detected() {
        let (g, cfg) = fixture();
        // Discord already records the mic through the return bus.
        assert!(link_would_duplicate(&g, &cfg, 7, 15));
    }

    #[test]
    fn distinct_signals_are_left_alone() {
        let (g, cfg) = fixture();
        // FluidSynth is not part of what the Discord return bus carries.
        assert!(!link_would_duplicate(&g, &cfg, 16, 15));
        // A strip feeding the master is the normal path, not a duplicate.
        assert!(!link_would_duplicate(&g, &cfg, 1, 2));
        // Brave has no route to the mic strip.
        assert!(!link_would_duplicate(&g, &cfg, 1, 10));
    }

    #[test]
    fn a_source_already_carried_by_the_return_bus_is_a_duplicate() {
        let (g, cfg) = fixture();
        // Pianoteq feeds the Discord return bus, so wiring it straight into
        // Discord as well would send the piano twice.
        assert!(link_would_duplicate(&g, &cfg, 18, 15));
    }

    #[test]
    fn only_the_duplicate_link_is_cut() {
        let (mut g, cfg) = fixture();
        g.add_link(link(20, 1, 6)); // Brave -> hw sink, the doubling link
        assert_eq!(duplicate_links_of(&g, &cfg, 1), vec![(20, "hw_sink".to_string())]);
    }

    #[test]
    fn the_raw_mic_link_into_discord_is_cut() {
        let (mut g, cfg) = fixture();
        g.add_link(link(20, 7, 15)); // hw mic -> Discord, the robotic-voice link
        assert_eq!(duplicate_links_of(&g, &cfg, 15), vec![(20, "hw_mic".to_string())]);
    }

    #[test]
    fn a_clean_graph_has_nothing_to_cut() {
        let (g, cfg) = fixture();
        for stream in [1, 15, 16, 18] {
            assert!(duplicate_links_of(&g, &cfg, stream).is_empty());
        }
    }
}
