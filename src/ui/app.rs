use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use log::info;

use crate::audio::{AudioGraph, PwEvent, PwThread};
use crate::audio::effects::cleanup_orphaned_eq_sinks;
use crate::profiles::{apply::apply_profile, AppConfig, ProfileStore};

use super::window::MainWindow;

pub struct AudibianApp {
    app: libadwaita::Application,
}

impl AudibianApp {
    pub fn new() -> Self {
        let app = libadwaita::Application::builder()
            .application_id("com.github.audibian")
            .flags(gio::ApplicationFlags::FLAGS_NONE)
            .build();

        app.connect_activate(|a| Self::on_activate(a));

        Self { app }
    }

    pub fn run(&self) {
        self.app.run();
    }

    fn on_activate(app: &libadwaita::Application) {
        // Register local icon path so the icon works without installing the app.
        // When installed, the icon is in the system hicolor theme and this is a no-op.
        let icon_theme = gtk4::IconTheme::for_display(&gtk4::gdk::Display::default().unwrap());
        if let Ok(mut exe_dir) = std::env::current_exe() {
            exe_dir.pop(); // strip binary name
            // dev layout: <repo>/target/debug|release/audibian → go up twice then into data/icons
            let candidate = exe_dir
                .join("../../data/icons")
                .canonicalize()
                .unwrap_or_default();
            if candidate.exists() {
                icon_theme.add_search_path(&candidate);
            }
        }
        app.set_application_id(Some("com.github.audibian"));

        cleanup_orphaned_eq_sinks();

        // Shared graph model (GTK main thread only — Rc is intentional)
        let graph = Rc::new(RefCell::new(AudioGraph::new()));

        // Channel: PipeWire thread → GTK main thread (async, bounded)
        let (pw_event_tx, pw_event_rx) = async_channel::unbounded::<PwEvent>();

        // Spawn PipeWire monitoring thread
        let pw_thread = Rc::new(PwThread::spawn(pw_event_tx));

        // Profile store
        let profile_store = Rc::new(RefCell::new(ProfileStore::new()));

        // Build main window
        let window = MainWindow::new(app, graph.clone(), pw_thread.clone(), profile_store.clone());

        // Attach event loop: receive PwEvents on the GLib main loop via spawn_local
        let graph_ref = graph.clone();
        let window_ref = window.clone();
        glib::MainContext::default().spawn_local(async move {
            while let Ok(event) = pw_event_rx.recv().await {
                handle_pw_event(event, &graph_ref, &window_ref);
            }
        });

        // Apply default profile after a short delay to let PipeWire discover nodes
        {
            let graph_ref2 = graph.clone();
            let pw_ref2 = pw_thread.clone();
            let store_ref2 = profile_store.clone();
            glib::MainContext::default().spawn_local(async move {
                // Wait 3 seconds for PipeWire to enumerate all nodes/ports
                glib::timeout_future(std::time::Duration::from_secs(3)).await;
                let cfg = AppConfig::load();
                if let Some(default_name) = &cfg.default_profile {
                    if let Some(profile) = store_ref2.borrow().load(default_name) {
                        let result = apply_profile(&profile, &graph_ref2.borrow(), &*pw_ref2);
                        info!(
                            "Default profile '{}' applied: {} links, {} unresolved",
                            default_name,
                            result.links_applied,
                            result.unresolved_links.len()
                        );
                    }
                }
            });
        }

        window.present();
        info!("Audibian started");
    }
}

fn handle_pw_event(event: PwEvent, graph: &Rc<RefCell<AudioGraph>>, window: &MainWindow) {
    let mut g = graph.borrow_mut();
    match event {
        PwEvent::NodeAdded(node) => {
            g.add_node(node);
            drop(g);
            window.refresh_patchbay();
            window.refresh_mixer();
            window.refresh_effects();
        }
        PwEvent::NodeRemoved(id) => {
            g.remove_node(id);
            drop(g);
            window.refresh_patchbay();
            window.refresh_mixer();
            window.refresh_effects();
        }
        PwEvent::PortAdded(port) => {
            g.add_port(port);
            drop(g);
            window.refresh_patchbay();
        }
        PwEvent::PortRemoved(id) => {
            g.remove_port(id);
            drop(g);
            window.refresh_patchbay();
        }
        PwEvent::LinkAdded(link) => {
            g.add_link(link);
            drop(g);
            window.refresh_patchbay();
        }
        PwEvent::LinkRemoved(id) => {
            g.remove_link(id);
            drop(g);
            window.refresh_patchbay();
        }
        PwEvent::NodeVolume { node_id, volume, muted } => {
            if let Some(node) = g.nodes.get_mut(&node_id) {
                node.volume = volume;
                node.muted = muted;
            }
            drop(g);
            window.refresh_mixer();
        }
        PwEvent::Disconnected => {
            drop(g);
            window.show_disconnected_banner();
        }
    }
}
