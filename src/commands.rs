use tauri::State;
use log::debug;

use crate::audio::eq::EqBand;
use crate::audio::effects;
use crate::audio::{AudioGraph, PwCommand, PwThread};
use crate::mixer::{InputChannel, ReturnChannel};
use crate::profiles::model::AudioProfile;
use crate::profiles::AppConfig;
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
            send_to_master: true,
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
    // Unload source loopback if any
    if let Some(mid) = state.input_source_ids.lock().unwrap().remove(&id) {
        let _ = std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn();
    }

    // Unload all send loopbacks where this channel is the input
    {
        let mut send_mods = state.send_module_ids.lock().unwrap();
        let keys: Vec<(u32, u32)> = send_mods.keys().filter(|(inp, _)| *inp == id).cloned().collect();
        for key in keys {
            if let Some(mid) = send_mods.remove(&key) {
                let _ = std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn();
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
                let _ = std::process::Command::new("pactl")
                    .args(["unload-module", &mods[1].to_string()])
                    .spawn();
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
                let _ = std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn();
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
        let _ = std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn();
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
        let _ = std::process::Command::new("pactl")
            .args(["unload-module", &mid.to_string()])
            .spawn();
    }
    if let (Some(src), Some(sink)) = (source_name, sink_name) {
        if let Some(mid) = create_source_loopback(&src, &sink, mono) {
            debug!("Reloaded source loopback {} → {} (mono={}) as module {}", src, sink, mono, mid);
            state.input_source_ids.lock().unwrap().insert(id, mid);
        }
    }
}

#[tauri::command]
pub fn set_return_send_to_master(state: State<AppState>, id: u32, send_to_master: bool) {
    let sink_name = {
        let mut cfg = state.mixer_config.lock().unwrap();
        if let Some(r) = cfg.return_channels.iter_mut().find(|r| r.id == id) {
            r.send_to_master = send_to_master;
        }
        cfg.save();
        cfg.return_channels.iter().find(|r| r.id == id).map(|r| r.sink_name.clone())
    };

    if let Some(sink) = sink_name {
        let src_name = format!("{}_src", sink);
        let graph = state.graph.lock().unwrap();
        if send_to_master {
            connect_nodes(&graph, &src_name, MASTER_SINK_NAME, &state.pw, false);
        } else {
            disconnect_nodes(&graph, &src_name, MASTER_SINK_NAME, &state.pw);
        }
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
                let _ = std::process::Command::new("pactl")
                    .args(["unload-module", &mid.to_string()])
                    .spawn();
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
                    let _ = std::process::Command::new("pactl")
                        .args(["unload-module", &mid.to_string()])
                        .spawn();
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
    let _ = std::process::Command::new("pactl")
        .args(["move-sink-input", &stream_id.to_string(), sink_name])
        .spawn();
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
                    let _ = std::process::Command::new("pactl")
                        .args(["unload-module", &id.to_string()])
                        .spawn();
                }
            }
        }
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
    let out = std::process::Command::new("pactl")
        .args([
            "load-module", "module-loopback",
            &format!("source={}", source),
            &format!("sink={}", sink),
            "latency_msec=1",
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
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-input-volume", &si.to_string(), &pct])
        .spawn();
}

pub fn create_source_loopback(source: &str, sink: &str, mono: bool) -> Option<u32> {
    let mut args = vec![
        "load-module".to_string(),
        "module-loopback".to_string(),
        format!("source={}", source),
        format!("sink={}", sink),
        "latency_msec=1".to_string(),
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

pub fn write_pipewire_conf(input_channels: &[crate::mixer::InputChannel]) {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = std::path::PathBuf::from(&home).join(".config/pipewire/pipewire.conf.d");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("audibian-inputs.conf");

    if input_channels.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }

    let mut conf = String::from("# Generated by audibian — do not edit manually\ncontext.objects = [\n");
    for ch in input_channels {
        conf.push_str(&format!(
            "    {{\n        factory = adapter\n        args = {{\n            factory.name = support.null-audio-sink\n            node.name = {}\n            node.description = \"{}\"\n            media.class = Audio/Sink\n            audio.position = [ FL FR ]\n        }}\n    }}\n",
            ch.sink_name, ch.name
        ));
    }
    conf.push_str("]\n");
    let _ = std::fs::write(path, conf);
}

fn unload_module(module_id: u32) {
    let _ = std::process::Command::new("pactl")
        .args(["unload-module", &module_id.to_string()])
        .spawn();
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
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-volume", sink, &l_pct, &r_pct])
        .spawn();
    let m = if muted { "1" } else { "0" };
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-mute", sink, m])
        .spawn();
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
}

fn set_volume_pactl(node_name: &str, volume: f64) {
    let pct = format!("{:.0}%", (volume * 100.0).round());
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-volume", node_name, &pct])
        .spawn();
    let _ = std::process::Command::new("pactl")
        .args(["set-source-volume", node_name, &pct])
        .spawn();
}

fn set_mute_pactl(node_name: &str, muted: bool) {
    let state = if muted { "1" } else { "0" };
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-mute", node_name, state])
        .spawn();
    let _ = std::process::Command::new("pactl")
        .args(["set-source-mute", node_name, state])
        .spawn();
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
pub fn restore_matrix_connections(
    matrix_cfg: &crate::matrix_config::MatrixConfig,
    graph: &AudioGraph,
    pw: &PwThread,
    node_name: &str,
) {
    for conn in matrix_cfg.connections_involving(node_name) {
        let src = graph.nodes.values().find(|n| n.name == conn.src_node);
        let dst = graph.nodes.values().find(|n| n.name == conn.dst_node);
        if let (Some(src), Some(dst)) = (src, dst) {
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
