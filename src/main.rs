mod audio;
mod profiles;
mod commands;
mod state;
mod mixer;
mod matrix_config;
mod meter;
mod persistent;
mod soundboard;
#[cfg(target_os = "linux")]
mod x11_embed;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use audio::{AudioGraph, PwEvent, PwThread};
use profiles::{AppConfig, ProfileStore};
use mixer::MixerConfig;
use matrix_config::MatrixConfig;
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

            // Meter channel
            let (meter_tx, meter_rx) = async_channel::unbounded::<(String, f32)>();
            let meter_handles = Arc::new(Mutex::new(HashMap::<String, meter::MeterHandle>::new()));

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
                    *m_null.lock().unwrap() = restored.master_null_module;
                    *m_loop.lock().unwrap() = restored.master_loopback_module;
                    *inp_ids.lock().unwrap() = restored.input_module_ids;
                    *ret_ids.lock().unwrap() = restored.return_module_ids;
                    *snd_ids.lock().unwrap() = restored.send_module_ids;
                    *src_ids.lock().unwrap() = restored.input_source_ids;
                    *seq_instances.lock().unwrap() = restored.strip_eq_instances;
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
                meter_rx: meter_rx.clone(),
                soundboard_config: Arc::new(Mutex::new(soundboard_cfg)),
                soundboard_procs: Arc::new(Mutex::new(Vec::new())),
                midi_carla_procs: Arc::new(Mutex::new(HashMap::new())),
                #[cfg(target_os = "linux")]
                main_xid: Arc::new(Mutex::new(0)),
                #[cfg(target_os = "linux")]
                embedded_plugin_windows: Arc::new(Mutex::new(HashMap::new())),
            };
            app.manage(state);

            // Resolve the main toplevel's X11 window id from the raw window
            // handle. Stored in AppState so the MIDI rack can later reparent
            // plugin GUIs into us. Zero on Wayland or if the handle is not
            // an Xlib handle (which means embedding is unavailable).
            #[cfg(target_os = "linux")]
            if let Some(win) = app.get_webview_window("main") {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(handle) = win.window_handle() {
                    if let RawWindowHandle::Xlib(xh) = handle.as_raw() {
                        let xid = xh.window as u32;
                        if xid != 0 {
                            *app.state::<AppState>().main_xid.lock().unwrap() = xid;
                        }
                    }
                }
            }

            // Bridge: meter peaks → emit pw-node-peak events
            let app_handle_meter = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok((node_name, db)) = meter_rx.recv().await {
                    app_handle_meter.emit("pw-node-peak", serde_json::json!({
                        "node_name": node_name,
                        "db": db
                    })).ok();
                }
            });

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
                        commands::cleanup_stale_modules();
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
            commands::midi_carla_available,
            commands::midi_channel_list,
            commands::midi_channel_add,
            commands::midi_channel_remove,
            commands::midi_channel_rename,
            commands::midi_plugin_add,
            commands::midi_plugin_remove,
            commands::midi_plugin_reorder,
            commands::midi_channel_open_gui,
            commands::midi_channel_close_gui,
            commands::midi_plugin_show_native_gui,
            commands::midi_plugin_hide_native_gui,
            commands::midi_channel_sync_plugins,
            commands::midi_plugin_embed_gui,
            commands::midi_plugin_position_gui,
            commands::midi_plugin_unembed_gui,
            commands::midi_embed_available,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

fn handle_pw_event(event: PwEvent, graph: &Arc<Mutex<AudioGraph>>, app: &tauri::AppHandle) {
    match event {
        PwEvent::NodeAdded(node) => {
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
                } else {
                    None
                };

                if let Some(key) = meter_key {
                    let mut handles = state.meter_handles.lock().unwrap();
                    if !handles.contains_key(&key) {
                        if let Some(handle) = crate::meter::spawn_meter(
                            node.id, key.clone(), state.meter_tx.clone(),
                        ) {
                            handles.insert(key, handle);
                        }
                    }
                }

                // Input channel sink appears → force-loopback its monitor to
                // audibian_master so every input always reaches the master.
                let input_ch = mixer_cfg.input_channels.iter()
                    .find(|c| c.sink_name == node.name)
                    .cloned();
                if let Some(ch) = input_ch {
                    let app_clone = app.clone();
                    let sink_name = ch.sink_name.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let state = app_clone.state::<crate::state::AppState>();
                        let graph = state.graph.lock().unwrap();
                        crate::commands::connect_nodes(
                            &graph, &sink_name,
                            crate::commands::MASTER_SINK_NAME,
                            &state.pw, false,
                        );
                    });
                }

                if node.name == crate::commands::MASTER_SINK_NAME {
                    let app_clone = app.clone();
                    // Returns NEVER auto-route to master — only inputs do.
                    let returns: Vec<String> = Vec::new();
                    let inputs: Vec<String> = mixer_cfg.input_channels.iter()
                        .map(|c| c.sink_name.clone())
                        .collect();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let state = app_clone.state::<crate::state::AppState>();
                        let graph = state.graph.lock().unwrap();
                        for src in &returns {
                            crate::commands::connect_nodes(
                                &graph, src,
                                crate::commands::MASTER_SINK_NAME,
                                &state.pw, false,
                            );
                        }
                        for src in &inputs {
                            crate::commands::connect_nodes(
                                &graph, src,
                                crate::commands::MASTER_SINK_NAME,
                                &state.pw, false,
                            );
                        }
                    });
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
                    let graph = state.graph.lock().unwrap();
                    crate::commands::restore_matrix_connections(&matrix_cfg, &graph, &state.pw, &node_name);
                }
            });
        }
        PwEvent::NodeRemoved(id) => {
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
                        let _ = std::process::Command::new("pactl")
                            .args(["unload-module", &mid.to_string()])
                            .spawn();
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
            graph.lock().unwrap().add_link(link);
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
