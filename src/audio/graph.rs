use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Input,
    Output,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MediaType {
    Audio,
    #[allow(dead_code)]
    Video,
    #[allow(dead_code)]
    Midi,
    #[allow(dead_code)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeType {
    Source,
    Sink,
    Duplex,
    Filter,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPort {
    pub id: u32,
    pub node_id: u32,
    pub name: String,
    pub direction: Direction,
    #[allow(dead_code)]
    pub media_type: MediaType,
    /// Port number/order within the node
    pub port_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioNode {
    pub id: u32,
    pub name: String,
    pub nick: Option<String>,
    pub description: Option<String>,
    pub app_name: Option<String>,
    pub node_type: NodeType,
    pub media_class: Option<String>,
    /// Logical position on the patchbay canvas (in pixels)
    pub x: f64,
    pub y: f64,
    /// Cached volume [0.0..1.0], filled once we query params
    pub volume: f32,
    pub muted: bool,
}

impl AudioNode {
    pub fn display_name(&self) -> &str {
        self.nick
            .as_deref()
            .or(self.description.as_deref())
            .or(self.app_name.as_deref())
            .unwrap_or(&self.name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioLink {
    pub id: u32,
    pub output_node_id: u32,
    pub output_port_id: u32,
    pub input_node_id: u32,
    pub input_port_id: u32,
    #[allow(dead_code)]
    pub active: bool,
}

/// Central audio graph model. Kept in sync by pw_thread signals.
/// All mutations happen on the GTK main thread (no locking needed).
#[derive(Debug, Default)]
pub struct AudioGraph {
    pub nodes: HashMap<u32, AudioNode>,
    pub ports: HashMap<u32, AudioPort>,
    pub links: HashMap<u32, AudioLink>,
}

impl AudioGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: AudioNode) {
        self.nodes.insert(node.id, node);
    }

    pub fn remove_node(&mut self, id: u32) {
        self.nodes.remove(&id);
        // Clean up associated ports
        self.ports.retain(|_, p| p.node_id != id);
        // Clean up associated links
        self.links
            .retain(|_, l| l.output_node_id != id && l.input_node_id != id);
    }

    pub fn add_port(&mut self, port: AudioPort) {
        self.ports.insert(port.id, port);
    }

    pub fn remove_port(&mut self, id: u32) {
        self.ports.remove(&id);
        self.links
            .retain(|_, l| l.output_port_id != id && l.input_port_id != id);
    }

    pub fn add_link(&mut self, link: AudioLink) {
        self.links.insert(link.id, link);
    }

    pub fn remove_link(&mut self, id: u32) {
        self.links.remove(&id);
    }

    pub fn ports_for_node(&self, node_id: u32) -> Vec<&AudioPort> {
        let mut ports: Vec<&AudioPort> = self
            .ports
            .values()
            .filter(|p| p.node_id == node_id)
            .collect();
        ports.sort_by_key(|p| p.port_index);
        ports
    }

    pub fn output_ports_for_node(&self, node_id: u32) -> Vec<&AudioPort> {
        self.ports_for_node(node_id)
            .into_iter()
            .filter(|p| p.direction == Direction::Output)
            .collect()
    }

    pub fn input_ports_for_node(&self, node_id: u32) -> Vec<&AudioPort> {
        self.ports_for_node(node_id)
            .into_iter()
            .filter(|p| p.direction == Direction::Input)
            .collect()
    }

    /// Audio-only nodes sorted: sources first, then filters, then sinks
    pub fn audio_nodes_sorted(&self) -> Vec<&AudioNode> {
        let mut nodes: Vec<&AudioNode> = self
            .nodes
            .values()
            .filter(|n| {
                // Only show nodes with a recognised audio media.class
                // (excludes internal PW nodes like Dummy-Driver/Freewheel-Driver)
                n.media_class
                    .as_deref()
                    .map(|c| c.starts_with("Audio") || c.starts_with("Stream"))
                    .unwrap_or(false)
            })
            .collect();
        nodes.sort_by(|a, b| {
            let order = |n: &AudioNode| match n.node_type {
                NodeType::Source => 0,
                NodeType::Filter => 1,
                NodeType::Duplex => 2,
                NodeType::Sink => 3,
                NodeType::Unknown => 4,
            };
            order(a)
                .cmp(&order(b))
                .then(a.display_name().cmp(b.display_name()))
        });
        nodes
    }
}

/// Parse a `media.class` property string into a NodeType.
pub fn node_type_from_media_class(class: &str) -> NodeType {
    if class.contains("Source") || class.starts_with("Stream/Output") {
        NodeType::Source
    } else if class.contains("Sink") || class.starts_with("Stream/Input") {
        NodeType::Sink
    } else if class.contains("Duplex") {
        NodeType::Duplex
    } else if class.contains("Filter") {
        NodeType::Filter
    } else {
        NodeType::Unknown
    }
}

#[allow(dead_code)]
pub fn media_type_from_str(s: &str) -> MediaType {
    match s {
        "Audio" => MediaType::Audio,
        "Video" => MediaType::Video,
        "Midi" | "MIDI" => MediaType::Midi,
        _ => MediaType::Unknown,
    }
}
