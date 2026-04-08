use crate::audio::{AudioGraph, NodeType};

pub const NODE_WIDTH: f64 = 180.0;
const COL_GAP_X: f64 = 120.0; // horizontal gap between columns
const NODE_GAP_Y: f64 = 24.0;  // vertical gap between nodes in same column
const START_X: f64 = 40.0;
const START_Y: f64 = 40.0;

/// Assign initial x/y positions to nodes that haven't been placed yet.
/// Nodes with x == 0.0 && y == 0.0 are considered "unplaced".
/// Already-placed nodes (including user-dragged ones) keep their position.
/// Internal PipeWire nodes (no media.class) are skipped entirely.
///
/// Column layout:  Sources | [Filters] | Sinks
pub fn auto_layout(graph: &mut AudioGraph) {
    // Separate audio nodes into placed / unplaced, grouped by node type.
    let mut placed_sources: Vec<(u32, f64)> = vec![]; // (id, y)
    let mut placed_filters: Vec<(u32, f64)> = vec![];
    let mut placed_sinks:   Vec<(u32, f64)> = vec![];
    let mut new_sources: Vec<u32> = vec![];
    let mut new_filters: Vec<u32> = vec![];
    let mut new_sinks:   Vec<u32> = vec![];

    for node in graph.nodes.values() {
        // Skip internal PipeWire nodes (Dummy-Driver, Freewheel-Driver, …)
        if node.media_class.is_none() {
            continue;
        }

        let is_placed = node.x != 0.0 || node.y != 0.0;

        match node.node_type {
            NodeType::Source => {
                if is_placed { placed_sources.push((node.id, node.y)); }
                else         { new_sources.push(node.id); }
            }
            NodeType::Sink => {
                if is_placed { placed_sinks.push((node.id, node.y)); }
                else         { new_sinks.push(node.id); }
            }
            // Filter, Duplex, Unknown all go in the middle column
            _ => {
                if is_placed { placed_filters.push((node.id, node.y)); }
                else         { new_filters.push(node.id); }
            }
        }
    }

    // Nothing to place → early exit
    if new_sources.is_empty() && new_filters.is_empty() && new_sinks.is_empty() {
        return;
    }

    // Decide whether we need a filter column
    let need_filter_col = !new_filters.is_empty() || !placed_filters.is_empty();

    let source_x = START_X;
    let filter_x = START_X + (NODE_WIDTH + COL_GAP_X);
    let sink_x   = if need_filter_col {
        START_X + (NODE_WIDTH + COL_GAP_X) * 2.0
    } else {
        filter_x // no filter col → sinks go in col 1
    };

    // Starting y for each column = bottom of the last placed node in that group
    let source_y = next_y_after(&placed_sources, graph);
    let filter_y = next_y_after(&placed_filters, graph);
    let sink_y   = next_y_after(&placed_sinks,   graph);

    place_column(graph, &new_sources, source_x, source_y);
    if need_filter_col {
        place_column(graph, &new_filters, filter_x, filter_y);
    }
    place_column(graph, &new_sinks, sink_x, sink_y);

    // After placing new nodes, already-placed nodes might overlap
    // because their height increases when ports are added asynchronously.
    // We do a pass to push down overlapping nodes in each column.
    let all_sources: Vec<u32> = graph.nodes.values().filter(|n| n.media_class.is_some() && n.node_type == NodeType::Source).map(|n| n.id).collect();
    let all_filters: Vec<u32> = graph.nodes.values().filter(|n| n.media_class.is_some() && matches!(n.node_type, NodeType::Filter | NodeType::Duplex | NodeType::Unknown)).map(|n| n.id).collect();
    let all_sinks: Vec<u32>   = graph.nodes.values().filter(|n| n.media_class.is_some() && n.node_type == NodeType::Sink).map(|n| n.id).collect();

    resolve_overlaps(graph, &all_sources);
    resolve_overlaps(graph, &all_filters);
    resolve_overlaps(graph, &all_sinks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find the y coordinate to start placing new nodes after the already-placed
/// ones in the same column.
fn next_y_after(placed: &[(u32, f64)], graph: &AudioGraph) -> f64 {
    placed
        .iter()
        .map(|(id, y)| y + node_height(*id, graph) + NODE_GAP_Y)
        .fold(START_Y, f64::max)
}

/// Place a list of node IDs vertically in a column at x, starting from start_y.
fn place_column(graph: &mut AudioGraph, ids: &[u32], x: f64, start_y: f64) {
    let mut y = start_y;
    for &id in ids {
        let h = node_height(id, graph);
        if let Some(node) = graph.nodes.get_mut(&id) {
            node.x = x;
            node.y = y;
        }
        y += h + NODE_GAP_Y;
    }
}

/// Height of a node based on actual port count — matches canvas.rs constants exactly.
///   NODE_HEADER_HEIGHT = 28.0
///   PORT_PADDING_TOP   = 6.0
///   PORT_ROW_HEIGHT    = 20.0
///   bottom padding     = 8.0
pub fn node_height(node_id: u32, graph: &AudioGraph) -> f64 {
    let in_count  = graph.input_ports_for_node(node_id).len();
    let out_count = graph.output_ports_for_node(node_id).len();
    let rows = in_count.max(out_count).max(1);
    28.0 + 6.0 + rows as f64 * 20.0 + 8.0
}

/// Sort nodes by Y and push down any nodes that overlap with the bounding box
/// of the node directly above them. This preserves user-dragged vertical
/// spacing unless it causes an intersection.
fn resolve_overlaps(graph: &mut AudioGraph, ids: &[u32]) {
    if ids.is_empty() {
        return;
    }

    // Read initial Ys
    let mut pairs = Vec::new();
    for &id in ids {
        if let Some(n) = graph.nodes.get(&id) {
            pairs.push((id, n.y));
        }
    }

    // Sort top-to-bottom
    pairs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut current_bottom = START_Y;
    
    // If the topmost node is above START_Y and we want to allow user placement anywhere,
    // we only bound current_bottom relative to the first node's Y.
    if let Some(&(_, first_y)) = pairs.first() {
        if first_y < START_Y {
            current_bottom = first_y;
        }
    }

    for (id, y) in pairs {
        // Evaluate new Y (must be at least current_bottom, and at least its original y)
        let new_y = y.max(current_bottom);
        
        // Apply back to graph
        if let Some(node) = graph.nodes.get_mut(&id) {
            node.y = new_y;
        }

        // Advance current_bottom
        let h = node_height(id, graph);
        current_bottom = new_y + h + NODE_GAP_Y;
    }
}
