mod audio;
mod config_io;
mod profiles;
mod commands;
mod state;
mod mixer;
mod matrix_config;
mod meter;
mod midi;
mod persistent;
mod proc;
mod soundboard;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use log::debug;
use audio::{AudioGraph, PwEvent, PwThread};
use profiles::{AppConfig, ProfileStore};
use mixer::MixerConfig;
use matrix_config::MatrixConfig;
use proc::CommandExt;
use state::AppState;
use tauri::{Emitter, Manager, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

fn main() {
    // WebKitGTK DMA-BUF renderer is broken on many Linux GPU/driver combos
    // (Mesa + NVIDIA + some Intel stacks), producing a blank window. Disable
    // it before WebKit initializes. User can override by exporting the var
    // themselves before launch.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: set before any WebKit/GTK init below.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1"); }
    }
    // Disabling DMABUF alone is not enough on Debian/Wayland when launched
    // via XDG autostart: WebKit still picks the accelerated compositor before
    // the session GL context is ready, producing a window with no UI. Force
    // the non-accelerated path so first paint always succeeds.
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        // SAFETY: set before any WebKit/GTK init below.
        unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1"); }
    }

    // Windows VST2/VST3 plugins bridged through yabridge need Wine — but
    // yabridge (as of 5.1.1) only works reliably against Wine <= 9.21; Wine
    // 10+ (including the staging builds most distros ship today) changed
    // window embedding enough that the bridged plugin process hangs or
    // crashes on load. Downgrading the system's default `wine` would break
    // everything else that uses it, so instead: if the user has dropped a
    // pinned Wine build at `~/.local/share/audibian/wine-yabridge/bin/wine`
    // (see README), point yabridge at it and at a dedicated prefix, without
    // touching `WINEPREFIX`/`WINELOADER` if the user already set them. Purely
    // additive — native (non-Wine) VST3 plugins never look at these vars.
    if let Ok(home) = std::env::var("HOME") {
        let wine_dir = std::path::PathBuf::from(&home).join(".local/share/audibian/wine-yabridge");
        let wine_bin = wine_dir.join("bin/wine");
        if wine_bin.is_file() {
            if std::env::var_os("WINELOADER").is_none() {
                // SAFETY: set before any child process (yabridge's Wine host) spawns.
                unsafe { std::env::set_var("WINELOADER", &wine_bin); }
            }
            if std::env::var_os("WINEPREFIX").is_none() {
                let prefix = std::path::PathBuf::from(&home)
                    .join(".local/share/audibian/wine-yabridge-prefix");
                // SAFETY: set before any child process (yabridge's Wine host) spawns.
                unsafe { std::env::set_var("WINEPREFIX", prefix); }
            }
        }
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Headless mode: recreate the persistent routing graph (virtual sinks,
    // returns, master, loopbacks, EQs) and exit. Used by the systemd user
    // service so the audio graph is live from boot without the GUI running.
    if std::env::args().any(|a| a == "--apply-persistent") {
        commands::apply_low_latency_conf(AppConfig::load().low_latency);
        let mut cfg = MixerConfig::load();
        if cfg.ensure_soundboard_channel() {
            cfg.save();
        }
        let restored = persistent::apply_persistent_state(&cfg);
        // pactl modules survive our exit on their own; the only thing tied to
        // this process is the StripEqInstance child handles. Leak the map so
        // Drop doesn't kill them.
        std::mem::forget(restored);
        log::info!("audibian --apply-persistent: restoration complete");
        return;
    }

    pipewire::init();

    tauri::Builder::default()
        .setup(|app| {
            let graph = Arc::new(Mutex::new(AudioGraph::new()));
            let (pw_event_tx, pw_event_rx) = async_channel::unbounded::<PwEvent>();
            let pw = Arc::new(PwThread::spawn(pw_event_tx));

            // Meter channel. Bounded on purpose: the producers are PipeWire RT
            // threads using `try_send`, so a stalled UI drops meter frames
            // instead of growing an unbounded queue until memory runs out.
            let (meter_tx, meter_rx) = async_channel::bounded::<meter::MeterSample>(512);
            let meter_handles = Arc::new(Mutex::new(HashMap::<String, meter::MeterHandle>::new()));

            // Drop filter-chain configs left behind by a previous run before
            // any new instance writes one.
            audio::effects::cleanup_orphaned_eq_sinks();

            // Re-apply low-latency PipeWire drop-in if user enabled it last session.
            commands::apply_low_latency_conf(AppConfig::load().low_latency);

            // Restore all mixer modules (input null-sinks, return null-sinks, loopback sends).
            // If `audibian --apply-persistent` already ran at session-start (via the
            // systemd user service), the audibian_* modules already exist; pactl will
            // create duplicates suffixed `.2`. To avoid that, check for an env var the
            // systemd unit can set, or skip restoration if the master sink is already
            // present in the running PipeWire state. For the prototype we rely on
            // `cleanup_stale_modules()` inside `apply_persistent_state` to wipe any
            // duplicates before recreating them.
            let mut mixer_cfg = MixerConfig::load();
            // Guarantee the soundboard input strip exists before we provision
            // virtual sinks, so persistent.rs creates `audibian_soundboard`.
            if mixer_cfg.ensure_soundboard_channel() {
                mixer_cfg.save();
            }
            let soundboard_cfg = soundboard::SoundboardConfig::load();
            let mixer_module_ids = Arc::new(Mutex::new(HashMap::<u32, Vec<u32>>::new()));
            let input_module_ids = Arc::new(Mutex::new(HashMap::<u32, Vec<u32>>::new()));
            let send_module_ids = Arc::new(Mutex::new(HashMap::<(u32, u32), u32>::new()));
            let input_source_ids = Arc::new(Mutex::new(HashMap::<u32, u32>::new()));
            let master_null_module = Arc::new(Mutex::new(None::<u32>));
            let master_loopback_module = Arc::new(Mutex::new(None::<u32>));
            let solo_set = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
            let strip_eq_instances = Arc::new(Mutex::new(HashMap::<String, audio::strip_eq::StripEqInstance>::new()));
            let midi_plugin_hosts = Arc::new(Mutex::new(HashMap::new()));
            let midi_input_router = Arc::new(Mutex::new(midi::input::MidiInputRouterHandle::start(midi_plugin_hosts.clone())));
            {
                let ret_ids = mixer_module_ids.clone();
                let inp_ids = input_module_ids.clone();
                let snd_ids = send_module_ids.clone();
                let src_ids = input_source_ids.clone();
                let m_null = master_null_module.clone();
                let m_loop = master_loopback_module.clone();
                let seq_instances = strip_eq_instances.clone();
                let cfg_clone = mixer_cfg.clone();
                std::thread::spawn(move || {
                    let restored = persistent::apply_persistent_state(&cfg_clone);
                    // Merge, never assign: a channel the user adds during the
                    // ~1 s restore would otherwise lose its module id here and
                    // could never be unloaded again.
                    {
                        let mut slot = m_null.lock().unwrap();
                        if slot.is_none() { *slot = restored.master_null_module; }
                    }
                    {
                        let mut slot = m_loop.lock().unwrap();
                        if slot.is_none() { *slot = restored.master_loopback_module; }
                    }
                    inp_ids.lock().unwrap().extend(restored.input_module_ids);
                    ret_ids.lock().unwrap().extend(restored.return_module_ids);
                    snd_ids.lock().unwrap().extend(restored.send_module_ids);
                    src_ids.lock().unwrap().extend(restored.input_source_ids);
                    seq_instances.lock().unwrap().extend(restored.strip_eq_instances);
                });
            }

            let state = AppState {
                graph: graph.clone(),
                pw: pw.clone(),
                profile_store: Arc::new(Mutex::new(ProfileStore::new())),
                eq_instance: Arc::new(Mutex::new(None)),
                ns_instances: Arc::new(Mutex::new(HashMap::new())),
                mixer_config: Arc::new(Mutex::new(mixer_cfg)),
                matrix_config: Arc::new(Mutex::new(MatrixConfig::load())),
                mixer_module_ids,
                input_module_ids,
                send_module_ids,
                input_source_ids,
                master_null_module,
                master_loopback_module,
                solo_set,
                strip_eq_instances,
                meter_handles,
                meter_tx,
                soundboard_config: Arc::new(parking_lot::Mutex::new(soundboard_cfg)),
                soundboard_procs: Arc::new(parking_lot::Mutex::new(Vec::new())),
                midi_plugin_hosts,
                midi_input_router,
            };
            app.manage(state);

            // Bridge: meter peaks → one batched `pw-node-peaks` event per frame.
            //
            // Previously this emitted one event per meter per PipeWire quantum:
            // ~9 sinks × 47-187 Hz, each building a `serde_json::Value` tree and
            // crossing the IPC boundary on its own. Coalescing into a single
            // array per frame collapses that to 25 messages/s total, and the
            // blocking `recv` means a silent machine costs zero wakeups.
            //
            // A plain thread, not an async task: it needs a periodic sleep and
            // the async runtime here has no timer API exposed.
            let app_handle_meter = app.handle().clone();
            std::thread::Builder::new()
                .name("meter-bridge".into())
                .spawn(move || {
                    const FRAME: std::time::Duration = std::time::Duration::from_millis(40);
                    let mut pending: HashMap<Arc<str>, (f32, f32)> = HashMap::new();

                    loop {
                        // Blocks while everything is silent — no polling.
                        let Ok((key, l, r)) = meter_rx.recv_blocking() else { break };
                        pending.insert(key, (l, r));

                        // Let the rest of the meters land in the same frame.
                        std::thread::sleep(FRAME);
                        while let Ok((key, l, r)) = meter_rx.try_recv() {
                            pending.insert(key, (l, r));
                        }

                        // Borrows `pending`; the borrow ends at the emit, which is
                        // why this cannot be hoisted out of the loop and reused.
                        let batch: Vec<(&str, f32, f32)> = pending
                            .iter()
                            .map(|(k, (l, r))| (k.as_ref(), *l, *r))
                            .collect();
                        app_handle_meter.emit("pw-node-peaks", &batch).ok();
                        pending.clear();
                    }
                })
                .ok();

            // Bridge: PW events → update Arc<Mutex<AudioGraph>> + emit Tauri events
            let app_handle = app.handle().clone();
            let graph_ref = graph.clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = pw_event_rx.recv().await {
                    handle_pw_event(event, &graph_ref, &app_handle);
                }
            });

            // Apply default profile after 3s via a background thread
            let app_handle2 = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let cfg = AppConfig::load();
                if let Some(name) = cfg.default_profile {
                    let _ = app_handle2.emit("default-profile", name);
                }
            });

            // Reroute apps already playing when Audibian launched (Spotify,
            // browser, etc). Done in two passes — first once virtual sinks
            // are live, then again after the default profile has reapplied
            // its matrix so streams land on the strip the user expects.
            let app_handle_rr = app.handle().clone();
            std::thread::spawn(move || {
                use crate::state::AppState;
                std::thread::sleep(std::time::Duration::from_millis(2500));
                let state = app_handle_rr.state::<AppState>();
                let _ = crate::commands::reroute_existing_streams(state);
                std::thread::sleep(std::time::Duration::from_millis(2500));
                let state = app_handle_rr.state::<AppState>();
                let _ = crate::commands::reroute_existing_streams(state);
            });

            // Tray icon: hide window on close, expose Show/Quit menu, run a
            // full pactl cleanup of audibian_* modules on actual quit.
            let show_item = MenuItem::with_id(app, "show", "Mostrar Audibian", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::with_id("audibian-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Audibian")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        // `exit` runs no destructors, so every child process
                        // and every pactl-level override has to go first.
                        commands::shutdown(&app.state::<AppState>());
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(main_win) = app.get_webview_window("main") {
                let win = main_win.clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_graph,
            commands::create_link,
            commands::destroy_link,
            commands::start_eq,
            commands::stop_eq,
            commands::get_eq_target,
            commands::start_ns,
            commands::stop_ns,
            commands::get_ns_active,
            commands::list_profiles,
            commands::load_profile,
            commands::save_profile,
            commands::delete_profile,
            commands::apply_profile_cmd,
            commands::snapshot_profile_cmd,
            commands::get_app_config,
            commands::save_app_config,
            commands::get_mixer_config,
            commands::add_input_channel,
            commands::add_return_channel,
            commands::remove_input_channel,
            commands::remove_return_channel,
            commands::update_input_channel_name,
            commands::update_return_channel_name,
            commands::toggle_send,
            commands::set_send_level,
            commands::set_strip_volume,
            commands::set_strip_pan,
            commands::set_strip_mute,
            commands::set_strip_solo,
            commands::get_solo_set,
            commands::set_master_volume,
            commands::set_master_pan,
            commands::set_master_mute,
            commands::move_app_to_strip,
            commands::reroute_existing_streams,
            commands::set_input_match_rules,
            commands::set_input_is_default,
            commands::set_strip_eq,
            commands::set_master_sink,
            commands::set_volume,
            commands::set_mute,
            commands::reorder_channels,
            commands::set_channel_color,
            commands::set_global_scale,
            commands::set_input_source,
            commands::set_input_mono,
            commands::set_return_send_to_master,
            commands::set_input_send_to_master,
            commands::save_matrix_connections,
            commands::get_matrix_config,
            commands::soundboard_list,
            commands::soundboard_pick_file,
            commands::soundboard_add,
            commands::soundboard_remove,
            commands::soundboard_rename,
            commands::soundboard_set_trim,
            commands::soundboard_play,
            commands::soundboard_stop_all,
            commands::midi_channel_list,
            commands::midi_channel_add,
            commands::midi_channel_remove,
            commands::midi_channel_rename,
            commands::midi_plugin_scan,
            commands::midi_plugin_add,
            commands::midi_plugin_remove,
            commands::midi_plugin_reorder,
            commands::midi_plugin_load,
            commands::midi_plugin_unload,
            commands::midi_loaded_channel_ids,
            commands::midi_plugin_test_note,
            commands::midi_channel_set_volume,
            commands::midi_channel_set_pan,
            commands::midi_channel_set_mute,
            commands::midi_channel_set_solo,
            commands::midi_plugin_show_native_gui,
            commands::midi_plugin_hide_native_gui,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

fn handle_pw_event(event: PwEvent, graph: &Arc<Mutex<AudioGraph>>, app: &tauri::AppHandle) {
    match event {
        PwEvent::NodeAdded(node) => {
            // Sink ids shift as nodes come and go.
            crate::commands::invalidate_sink_id_cache();
            app.emit("pw-node-added", &node).ok();
            graph.lock().unwrap().add_node(node.clone());

            // Reactive meters and routing: all driven by NodeAdded so we never
            // spawn a meter before its target exists (which causes AUTOCONNECT to
            // fall back to the default capture device / microphone).
            {
                let state = app.state::<crate::state::AppState>();
                let mixer_cfg = state.mixer_config.lock().unwrap().clone();

                // Meters are spawned on the SINK NodeAdded (not on a
                // `.monitor` source — pipewire native API does not expose
                // monitor sources as separate nodes; the `<name>.monitor`
                // entries `pactl` shows are pulse-compat illusions over the
                // sink's output ports). The meter stream binds via
                // AUTOCONNECT to the sink's output ports (monitor) and is
                // NOT passive, so it keeps the null-sink active and pulls
                // buffers continuously.
                let meter_key = if node.name == crate::commands::MASTER_SINK_NAME {
                    Some(crate::commands::MASTER_SINK_NAME.to_string())
                } else if mixer_cfg.return_channels.iter().any(|r| r.sink_name == node.name) {
                    Some(node.name.clone())
                } else if mixer_cfg.input_channels.iter().any(|c| c.sink_name == node.name) {
                    Some(node.name.clone())
                } else if mixer_cfg.midi_channels.iter().any(|c| c.sink_name == node.name) {
                    Some(node.name.clone())
                } else {
                    None
                };

                if let Some(key) = meter_key {
                    let mut handles = state.meter_handles.lock().unwrap();
                    if !handles.contains_key(&key) {
                        if let Some(handle) = crate::meter::spawn_meter(
                            node.id, Arc::from(key.as_str()), state.meter_tx.clone(),
                        ) {
                            handles.insert(key, handle);
                        }
                    }
                }

                // Restore the optional input-monitor → master route after the
                // sink ports appear; a NodeAdded delay alone can race them.
                let input_ch = mixer_cfg.input_channels.iter()
                    .find(|c| c.sink_name == node.name && c.send_to_master)
                    .cloned();
                if let Some(ch) = input_ch {
                    let sink_name = ch.sink_name.clone();
                    std::thread::spawn(move || {
                        crate::commands::connect_monitor_to_master(&sink_name);
                    });
                }

                // MIDI/plugin channels use the same retrying monitor route.
                let midi_ch = mixer_cfg.midi_channels.iter()
                    .find(|c| c.sink_name == node.name)
                    .cloned();
                if let Some(ch) = midi_ch {
                    let sink_name = ch.sink_name.clone();
                    std::thread::spawn(move || {
                        crate::commands::connect_monitor_to_master(&sink_name);
                    });
                }

                if node.name == crate::commands::MASTER_SINK_NAME {
                    for ch in mixer_cfg.input_channels.iter().filter(|c| c.send_to_master) {
                        let sink_name = ch.sink_name.clone();
                        std::thread::spawn(move || {
                            crate::commands::connect_monitor_to_master(&sink_name);
                        });
                    }

                    for ch in &mixer_cfg.midi_channels {
                        let sink_name = ch.sink_name.clone();
                        std::thread::spawn(move || {
                            crate::commands::connect_monitor_to_master(&sink_name);
                        });
                    }
                }

                // 3b. Hardware master sink reappears → recreate the
                //     audibian_master.monitor → hw loopback if we tore it down
                //     on its previous removal.
                let master_hw = mixer_cfg.master_sink.clone();
                if master_hw.as_deref() == Some(node.name.as_str())
                    && state.master_loopback_module.lock().unwrap().is_none()
                    && state.master_null_module.lock().unwrap().is_some()
                {
                    let monitor = format!("{}.monitor", crate::commands::MASTER_SINK_NAME);
                    if let Some(mid) = crate::commands::create_loopback(&monitor, &node.name) {
                        *state.master_loopback_module.lock().unwrap() = Some(mid);
                    }
                }

                // 4. Stream/Output (app playback) appears → auto-route to strip
                //    matching app_match_rules, or to the default strip.
                if node.media_class.as_deref() == Some("Stream/Output") {
                    if let Some(app_name) = node.app_name.as_ref() {
                        if let Some(sink) = crate::commands::pick_strip_sink_for_app(&mixer_cfg, app_name) {
                            let stream_id = node.id;
                            // Small delay so the stream is fully registered in PA emulation.
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                crate::commands::move_stream_to_sink(stream_id, &sink);
                            });
                        }
                    }
                }

                // 5. Returns intentionally do NOT auto-route to master. Their
                //    audio reaches the master only via explicit Matrix links.
            }

            // When a node reappears, restore its matrix connections.
            let app2 = app.clone();
            let node_name = node.name.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let state = app2.state::<crate::state::AppState>();
                let matrix_cfg = state.matrix_config.lock().unwrap().clone();
                if !matrix_cfg.connections_involving(&node_name).is_empty() {
                    let mixer_cfg = state.mixer_config.lock().unwrap().clone();
                    let graph = state.graph.lock().unwrap();
                    crate::commands::restore_matrix_connections(
                        &matrix_cfg, &graph, &state.pw, &mixer_cfg, &node_name,
                    );
                }
            });
        }
        PwEvent::NodeRemoved(id) => {
            crate::commands::invalidate_sink_id_cache();
            let removed_name = graph.lock().unwrap()
                .nodes.get(&id).map(|n| n.name.clone());
            graph.lock().unwrap().remove_node(id);
            app.emit("pw-node-removed", id).ok();

            // If the hw master output vanished (USB unplugged etc.), tear down
            // the master.monitor → hw loopback. The audibian_master null-sink
            // stays alive so apps keep playing into it; loopback gets recreated
            // when the hw node reappears.
            if let Some(name) = removed_name {
                let state = app.state::<crate::state::AppState>();

                // Tear down meter pinned to a monitor that just vanished, so
                // we re-spawn on the new node id when it reappears. Meters
                // are keyed by the parent sink name (without `.monitor`).
                let key = name.strip_suffix(".monitor").unwrap_or(name.as_str());
                state.meter_handles.lock().unwrap().remove(key);

                let master_hw = state.mixer_config.lock().unwrap().master_sink.clone();
                if master_hw.as_deref() == Some(name.as_str()) {
                    if let Some(mid) = state.master_loopback_module.lock().unwrap().take() {
                        std::process::Command::new("pactl")
                            .args(["unload-module", &mid.to_string()])
                            .spawn_detached();
                    }
                }
            }
        }
        PwEvent::PortAdded(port) => {
            app.emit("pw-port-added", &port).ok();
            graph.lock().unwrap().add_port(port);
        }
        PwEvent::PortRemoved(id) => {
            graph.lock().unwrap().remove_port(id);
            app.emit("pw-port-removed", id).ok();
        }
        PwEvent::LinkAdded(link) => {
            app.emit("pw-link-added", &link).ok();
            let (output_node_id, input_node_id) = (link.output_node_id, link.input_node_id);
            graph.lock().unwrap().add_link(link);

            // Whoever created this link — the session manager, a restored
            // Matrix entry, the user clicking a Matrix cell — an app stream
            // must never end up with two routes carrying the same audio: on
            // playback the app is heard twice, on capture the peers hear a
            // comb-filtered, robotic version of the microphone.
            let state = app.state::<crate::state::AppState>();
            let g = graph.lock().unwrap();
            let stream_id = [output_node_id, input_node_id].into_iter().find(|id| {
                g.nodes.get(id)
                    .and_then(|n| n.media_class.as_deref())
                    .is_some_and(|c| c.starts_with("Stream/"))
            });
            let duplicate = stream_id.map(|stream_id| {
                let mixer_cfg = state.mixer_config.lock().unwrap().clone();
                let cut = crate::commands::enforce_single_route(
                    &g, &state.pw, &mixer_cfg, stream_id,
                );
                let stream_name = g.nodes.get(&stream_id)
                    .map(|n| n.name.clone()).unwrap_or_default();
                (stream_name, cut)
            });
            // Saving the matrix serialises TOML and hits the disk. Never with
            // the graph lock held: every command that reads the graph would
            // queue behind that write.
            drop(g);

            if let Some((stream_name, cut)) = duplicate {
                if !cut.is_empty() {
                    debug!("'{stream_name}': dropped duplicate route(s) to/from {cut:?}");
                    // Drop the offending pairs from matrix.toml too, so they
                    // are not resurrected on the next launch of the app.
                    let mut mcfg = state.matrix_config.lock().unwrap();
                    for peer in &cut {
                        mcfg.set_node_pair(&stream_name, peer, Vec::new());
                        mcfg.set_node_pair(peer, &stream_name, Vec::new());
                    }
                    mcfg.save();
                }
            }
        }
        PwEvent::LinkRemoved(id) => {
            graph.lock().unwrap().remove_link(id);
            app.emit("pw-link-removed", id).ok();
        }
        PwEvent::NodeVolume { node_id, volume, muted } => {
            if let Ok(mut g) = graph.lock() {
                if let Some(node) = g.nodes.get_mut(&node_id) {
                    node.volume = volume;
                    node.muted = muted;
                }
            }
            app.emit("pw-node-volume", serde_json::json!({"node_id": node_id, "volume": volume, "muted": muted})).ok();
        }
        PwEvent::Disconnected => {
            app.emit("pw-disconnected", ()).ok();
        }
    }
}
