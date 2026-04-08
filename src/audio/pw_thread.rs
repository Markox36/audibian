/// PipeWire monitoring thread + link management helpers.
///
/// Architecture:
///   - A background thread runs a `pipewire::MainLoop` and listens to the
///     registry for node/port/link events, forwarding them to the GTK main
///     thread via a `async_channel::Sender<PwEvent>`.
///   - Creating/destroying links is done via `pw-link` subprocess calls
///     directly from the GTK thread (no need to round-trip through PW thread).
use std::thread;

use log::{debug, error, info};
use pipewire::{
    context::Context,
    main_loop::MainLoop,
    registry::GlobalObject,
    spa::utils::dict::DictRef,
    types::ObjectType,
};

use super::graph::{
    AudioLink, AudioNode, AudioPort, Direction, MediaType,
    node_type_from_media_class, NodeType,
};

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/// Events sent from the PipeWire thread to the GTK main thread.
#[derive(Debug, Clone)]
pub enum PwEvent {
    NodeAdded(AudioNode),
    NodeRemoved(u32),
    PortAdded(AudioPort),
    PortRemoved(u32),
    LinkAdded(AudioLink),
    LinkRemoved(u32),
    #[allow(dead_code)]
    NodeVolume { node_id: u32, volume: f32, muted: bool },
    Disconnected,
}

/// Commands from GTK → executed directly (not sent to PW thread).
#[derive(Debug, Clone)]
pub enum PwCommand {
    CreateLink { output_port_id: u32, input_port_id: u32 },
    DestroyLink { link_id: u32 },
    #[allow(dead_code)]
    Quit,
}

// ---------------------------------------------------------------------------
// PwThread handle
// ---------------------------------------------------------------------------

pub struct PwThread {
    _handle: thread::JoinHandle<()>,
}

impl PwThread {
    /// Spawn the monitoring thread.
    pub fn spawn(event_tx: async_channel::Sender<PwEvent>) -> Self {
        let handle = thread::Builder::new()
            .name("audibian-pw".into())
            .spawn(move || pw_monitor_thread(event_tx))
            .expect("failed to spawn PipeWire thread");

        Self { _handle: handle }
    }

    /// Create a link between two ports using `pw-link`.
    pub fn create_link(&self, output_port_id: u32, input_port_id: u32) {
        debug!("pw-link {output_port_id} {input_port_id}");
        let _ = std::process::Command::new("pw-link")
            .args([output_port_id.to_string(), input_port_id.to_string()])
            .spawn();
    }

    /// Destroy a link by its ID using `pw-link -d`.
    pub fn destroy_link(&self, link_id: u32) {
        debug!("pw-link -d {link_id}");
        let _ = std::process::Command::new("pw-link")
            .args(["-d".to_string(), link_id.to_string()])
            .spawn();
    }

    /// Execute a command (CreateLink/DestroyLink handled locally, Quit is a no-op).
    pub fn send(&self, cmd: PwCommand) {
        match cmd {
            PwCommand::CreateLink { output_port_id, input_port_id } => {
                self.create_link(output_port_id, input_port_id);
            }
            PwCommand::DestroyLink { link_id } => {
                self.destroy_link(link_id);
            }
            PwCommand::Quit => {}
        }
    }
}

// ---------------------------------------------------------------------------
// PipeWire monitoring thread
// ---------------------------------------------------------------------------

fn pw_monitor_thread(event_tx: async_channel::Sender<PwEvent>) {
    let main_loop = match MainLoop::new(None) {
        Ok(ml) => ml,
        Err(e) => {
            error!("Failed to create PipeWire main loop: {e}");
            return;
        }
    };

    let context = match Context::new(&main_loop) {
        Ok(ctx) => ctx,
        Err(e) => {
            error!("Failed to create PipeWire context: {e}");
            return;
        }
    };

    let core = match context.connect(None) {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to connect to PipeWire: {e}");
            let _ = event_tx.send_blocking(PwEvent::Disconnected);
            return;
        }
    };

    let registry = match core.get_registry() {
        Ok(r) => r,
        Err(e) => {
            error!("Failed to get PipeWire registry: {e}");
            return;
        }
    };

    info!("Connected to PipeWire — monitoring registry");

    let tx_global = event_tx.clone();
    let tx_remove = event_tx.clone();

    let _listener = registry
        .add_listener_local()
        .global(move |global| {
            handle_global(&tx_global, global);
        })
        .global_remove(move |id| {
            // Send all three remove events; the graph ignores IDs it doesn't know.
            let _ = tx_remove.send_blocking(PwEvent::NodeRemoved(id));
            let _ = tx_remove.send_blocking(PwEvent::PortRemoved(id));
            let _ = tx_remove.send_blocking(PwEvent::LinkRemoved(id));
        })
        .register();

    // Block until PipeWire disconnects or the process exits
    main_loop.run();
    info!("PipeWire main loop exited");
}

// ---------------------------------------------------------------------------
// Global object handler
// ---------------------------------------------------------------------------

fn handle_global(event_tx: &async_channel::Sender<PwEvent>, global: &GlobalObject<&DictRef>) {
    let props = match global.props {
        Some(p) => p,
        None => return,
    };

    let get = |key: &str| -> Option<String> { props.get(key).map(|s| s.to_string()) };

    match global.type_ {
        ObjectType::Node => {
            let media_class = get("media.class").unwrap_or_default();

            // Skip video-only and MIDI-only nodes
            if !media_class.is_empty()
                && !media_class.contains("Audio")
                && !media_class.starts_with("Stream")
            {
                return;
            }

            let node_type = if media_class.is_empty() {
                NodeType::Unknown
            } else {
                node_type_from_media_class(&media_class)
            };

            let node = AudioNode {
                id: global.id,
                name: get("node.name")
                    .unwrap_or_else(|| format!("node-{}", global.id)),
                nick: get("node.nick"),
                description: get("node.description"),
                app_name: get("application.name"),
                node_type,
                media_class: if media_class.is_empty() {
                    None
                } else {
                    Some(media_class)
                },
                x: 0.0,
                y: 0.0,
                volume: 1.0,
                muted: false,
            };

            debug!("Node {} added: '{}'", node.id, node.display_name());
            let _ = event_tx.send_blocking(PwEvent::NodeAdded(node));
        }

        ObjectType::Port => {
            let node_id: u32 = match get("node.id").and_then(|s| s.parse().ok()) {
                Some(id) => id,
                None => return,
            };

            let direction = match get("port.direction").as_deref() {
                Some("out") => Direction::Output,
                Some("in") => Direction::Input,
                _ => return,
            };

            let port_index: u32 = get("port.id")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            let port = AudioPort {
                id: global.id,
                node_id,
                name: get("port.name")
                    .unwrap_or_else(|| format!("port-{}", global.id)),
                direction,
                media_type: MediaType::Audio,
                port_index,
            };

            debug!("Port {} added: '{}' on node {}", port.id, port.name, port.node_id);
            let _ = event_tx.send_blocking(PwEvent::PortAdded(port));
        }

        ObjectType::Link => {
            let output_node_id: u32 =
                match get("link.output.node").and_then(|s| s.parse().ok()) {
                    Some(id) => id,
                    None => return,
                };
            let output_port_id: u32 =
                match get("link.output.port").and_then(|s| s.parse().ok()) {
                    Some(id) => id,
                    None => return,
                };
            let input_node_id: u32 =
                match get("link.input.node").and_then(|s| s.parse().ok()) {
                    Some(id) => id,
                    None => return,
                };
            let input_port_id: u32 =
                match get("link.input.port").and_then(|s| s.parse().ok()) {
                    Some(id) => id,
                    None => return,
                };

            let link = AudioLink {
                id: global.id,
                output_node_id,
                output_port_id,
                input_node_id,
                input_port_id,
                active: true,
            };

            debug!(
                "Link {} added: port {} → port {}",
                link.id, link.output_port_id, link.input_port_id
            );
            let _ = event_tx.send_blocking(PwEvent::LinkAdded(link));
        }

        _ => {}
    }
}
