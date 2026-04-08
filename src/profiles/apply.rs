/// Apply a saved `AudioProfile` to the current PipeWire graph.
///
/// Strategy:
///   1. Match saved node names against current graph nodes by name.
///   2. Emit `PwCommand::CreateLink` for each saved link where both endpoints match.
///   3. Volume is applied via libpulse (handled by the mixer layer).
///
/// Returns a list of links that could not be resolved (for user feedback).
use log::{info, warn};

use crate::audio::{AudioGraph, PwCommand, PwThread};
use super::model::AudioProfile;

pub struct ApplyResult {
    /// Number of links successfully requested
    pub links_applied: usize,
    /// Link specs that could not be resolved (node not found)
    pub unresolved_links: Vec<String>,
}

pub fn apply_profile(profile: &AudioProfile, graph: &AudioGraph, pw: &PwThread) -> ApplyResult {
    let mut links_applied = 0;
    let mut unresolved_links = Vec::new();

    // Build a name → node map for quick lookup
    let node_by_name: std::collections::HashMap<&str, &crate::audio::AudioNode> = graph
        .nodes
        .values()
        .map(|n| (n.name.as_str(), n))
        .collect();

    for link_spec in &profile.links {
        // Find output node
        let out_node = match node_by_name.get(link_spec.output_node.as_str()) {
            Some(n) => n,
            None => {
                warn!(
                    "Profile '{}': output node '{}' not found",
                    profile.name, link_spec.output_node
                );
                unresolved_links.push(format!(
                    "{}:{} → {}:{}",
                    link_spec.output_node,
                    link_spec.output_port,
                    link_spec.input_node,
                    link_spec.input_port,
                ));
                continue;
            }
        };

        // Find input node
        let in_node = match node_by_name.get(link_spec.input_node.as_str()) {
            Some(n) => n,
            None => {
                warn!(
                    "Profile '{}': input node '{}' not found",
                    profile.name, link_spec.input_node
                );
                unresolved_links.push(format!(
                    "{}:{} → {}:{}",
                    link_spec.output_node,
                    link_spec.output_port,
                    link_spec.input_node,
                    link_spec.input_port,
                ));
                continue;
            }
        };

        // Find matching ports by name
        let out_port = graph
            .output_ports_for_node(out_node.id)
            .into_iter()
            .find(|p| p.name == link_spec.output_port)
            .or_else(|| graph.output_ports_for_node(out_node.id).into_iter().next()); // fallback: first

        let in_port = graph
            .input_ports_for_node(in_node.id)
            .into_iter()
            .find(|p| p.name == link_spec.input_port)
            .or_else(|| graph.input_ports_for_node(in_node.id).into_iter().next());

        match (out_port, in_port) {
            (Some(op), Some(ip)) => {
                pw.send(PwCommand::CreateLink {
                    output_port_id: op.id,
                    input_port_id: ip.id,
                });
                links_applied += 1;
                info!(
                    "Profile '{}': linking {}:{} → {}:{}",
                    profile.name, out_node.name, op.name, in_node.name, ip.name
                );
            }
            _ => {
                warn!(
                    "Profile '{}': ports not found for {}→{}",
                    profile.name, link_spec.output_node, link_spec.input_node
                );
                unresolved_links.push(format!(
                    "{}:{} → {}:{}",
                    link_spec.output_node,
                    link_spec.output_port,
                    link_spec.input_node,
                    link_spec.input_port,
                ));
            }
        }
    }

    ApplyResult {
        links_applied,
        unresolved_links,
    }
}

/// Capture the current graph state as a profile snapshot.
pub fn snapshot_profile(
    name: &str,
    graph: &AudioGraph,
) -> AudioProfile {
    let mut profile = AudioProfile::new(name);

    // Capture all active links
    for link in graph.links.values() {
        let out_port = graph.ports.get(&link.output_port_id);
        let in_port = graph.ports.get(&link.input_port_id);
        let out_node = graph.nodes.get(&link.output_node_id);
        let in_node = graph.nodes.get(&link.input_node_id);

        if let (Some(op), Some(ip), Some(on), Some(inn)) = (out_port, in_port, out_node, in_node) {
            profile.links.push(crate::profiles::model::LinkSpec {
                output_node: on.name.clone(),
                output_port: op.name.clone(),
                input_node: inn.name.clone(),
                input_port: ip.name.clone(),
            });
        }
    }

    // Capture volumes
    for node in graph.nodes.values() {
        profile.volumes.push(crate::profiles::model::VolumeSpec {
            node_name: node.name.clone(),
            volume: node.volume,
            muted: node.muted,
        });
    }

    profile
}
