/// Patchbay canvas: GTK4 DrawingArea with Cairo rendering.
///
/// Draws audio nodes as rounded rectangles with port circles, and
/// links as cubic bezier cables.  Supports:
///   - Drag nodes to reposition them
///   - Click an output port and drag to an input port to create a link
///   - Right-click on a link to remove it
use std::cell::RefCell;
use std::rc::Rc;

use cairo::Context;
use gtk4::prelude::*;

use crate::audio::{AudioGraph, Direction, PwCommand, PwThread};

use super::layout::auto_layout;
use super::matrix::{build_matrix_container, refresh_matrix};

// --- Visual constants ---
const NODE_WIDTH: f64 = 180.0;
const NODE_CORNER_RADIUS: f64 = 8.0;
const NODE_HEADER_HEIGHT: f64 = 28.0;
const PORT_RADIUS: f64 = 6.0;
const PORT_ROW_HEIGHT: f64 = 20.0;
const PORT_PADDING_TOP: f64 = 6.0;

// --- Colors (RGB) ---
const COLOR_BG: (f64, f64, f64) = (0.12, 0.12, 0.14);
const COLOR_NODE_BG: (f64, f64, f64) = (0.22, 0.22, 0.26);
const COLOR_NODE_HEADER: (f64, f64, f64) = (0.28, 0.28, 0.36);
const COLOR_NODE_BORDER: (f64, f64, f64) = (0.4, 0.4, 0.5);
const COLOR_PORT_OUT: (f64, f64, f64) = (0.3, 0.7, 1.0);
const COLOR_PORT_IN: (f64, f64, f64) = (1.0, 0.6, 0.2);
const COLOR_LINK_DRAG: (f64, f64, f64) = (0.9, 0.9, 0.3);
const COLOR_TEXT: (f64, f64, f64) = (0.9, 0.9, 0.95);

// ---------------------------------------------------------------------------
// Interaction state
// ---------------------------------------------------------------------------

#[derive(Default)]
struct DragState {
    dragging_node: Option<u32>,
    /// Node's original x when drag started
    node_start_x: f64,
    /// Node's original y when drag started
    node_start_y: f64,
}

#[derive(Clone, Copy)]
struct PortRef {
    node_id: u32,
    port_id: u32,
    direction: Direction,
}

#[derive(Default)]
struct ConnectState {
    source_port: Option<PortRef>,
    /// Canvas position where the drag started
    start_x: f64,
    start_y: f64,
    /// Current cursor position (updated each drag-update tick)
    cursor_x: f64,
    cursor_y: f64,
}

#[derive(Default)]
struct CanvasState {
    drag: DragState,
    connect: ConnectState,
}

// ---------------------------------------------------------------------------
// PatchbayView
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct PatchbayView {
    main_box: gtk4::Box,
    canvas: gtk4::DrawingArea,
    matrix_container: gtk4::Box,
    graph: Rc<RefCell<AudioGraph>>,
    pw: Rc<PwThread>,
    state: Rc<RefCell<CanvasState>>,
}

impl PatchbayView {
    pub fn new(graph: Rc<RefCell<AudioGraph>>, pw: Rc<PwThread>) -> Self {
        let canvas = gtk4::DrawingArea::builder()
            .content_width(3000)
            .content_height(2000)
            .hexpand(true)
            .vexpand(true)
            .focusable(true)
            .build();

        let scrolled = gtk4::ScrolledWindow::builder()
            .child(&canvas)
            .hexpand(true)
            .vexpand(true)
            .build();

        let (matrix_scrolled, matrix_container) = build_matrix_container(graph.clone(), pw.clone());

        let stack = gtk4::Stack::builder()
            .transition_type(gtk4::StackTransitionType::Crossfade)
            .hexpand(true)
            .vexpand(true)
            .build();
            
        stack.add_titled(&scrolled, Some("canvas"), "Lienzo");
        stack.add_titled(&matrix_scrolled, Some("matrix"), "Matriz Detallada");

        let switcher = gtk4::StackSwitcher::builder()
            .stack(&stack)
            .halign(gtk4::Align::Center)
            .margin_top(8)
            .margin_bottom(8)
            .build();

        let main_box = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Vertical)
            .build();
            
        main_box.append(&switcher);
        main_box.append(&stack);

        let state = Rc::new(RefCell::new(CanvasState::default()));

        let view = Self {
            main_box,
            canvas,
            matrix_container,
            graph,
            pw,
            state,
        };

        view.setup_draw();
        view.setup_gestures();
        view
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.main_box.upcast_ref()
    }

    pub fn refresh(&self) {
        {
            let mut g = self.graph.borrow_mut();
            auto_layout(&mut g);
        }
        self.canvas.queue_draw();
        refresh_matrix(&self.matrix_container, &self.graph.borrow(), self.pw.clone());
    }

    fn setup_draw(&self) {
        let graph = self.graph.clone();
        let state = self.state.clone();

        self.canvas.set_draw_func(move |_widget, ctx, _width, _height| {
            draw_canvas(ctx, &graph.borrow(), &state.borrow());
        });
    }

    fn setup_gestures(&self) {
        // Primary button: drag nodes + connect ports
        let gesture_drag = gtk4::GestureDrag::new();
        gesture_drag.set_button(gtk4::gdk::BUTTON_PRIMARY);

        let graph_b = self.graph.clone();
        let state_b = self.state.clone();
        let canvas_b = self.canvas.clone();
        gesture_drag.connect_drag_begin(move |_, x, y| {
            on_drag_begin(x, y, &graph_b.borrow(), &mut state_b.borrow_mut());
            canvas_b.queue_draw();
        });

        let graph_u = self.graph.clone();
        let state_u = self.state.clone();
        let canvas_u = self.canvas.clone();
        gesture_drag.connect_drag_update(move |_, offset_x, offset_y| {
            on_drag_update(offset_x, offset_y, &mut graph_u.borrow_mut(), &mut state_u.borrow_mut());
            canvas_u.queue_draw();
        });

        let graph_e = self.graph.clone();
        let state_e = self.state.clone();
        let canvas_e = self.canvas.clone();
        let pw_e = self.pw.clone();
        gesture_drag.connect_drag_end(move |_, offset_x, offset_y| {
            on_drag_end(offset_x, offset_y, &graph_e.borrow(), &mut state_e.borrow_mut(), &pw_e);
            canvas_e.queue_draw();
        });

        self.canvas.add_controller(gesture_drag);

        // Right-click: remove link
        let gesture_click = gtk4::GestureClick::new();
        gesture_click.set_button(gtk4::gdk::BUTTON_SECONDARY);

        let graph_r = self.graph.clone();
        let pw_r = self.pw.clone();
        let canvas_r = self.canvas.clone();
        gesture_click.connect_released(move |_, _, x, y| {
            on_right_click(x, y, &graph_r.borrow(), &pw_r);
            canvas_r.queue_draw();
        });

        self.canvas.add_controller(gesture_click);
    }
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

fn on_drag_begin(x: f64, y: f64, graph: &AudioGraph, state: &mut CanvasState) {
    state.drag.dragging_node = None;
    state.connect.source_port = None;

    // Check if clicked on a port first
    if let Some(port_ref) = hit_test_port(x, y, graph) {
        if port_ref.direction == Direction::Output {
            state.connect.source_port = Some(port_ref);
            state.connect.start_x = x;
            state.connect.start_y = y;
            state.connect.cursor_x = x;
            state.connect.cursor_y = y;
        }
        return;
    }

    // Then check node body
    if let Some(node_id) = hit_test_node(x, y, graph) {
        if let Some(node) = graph.nodes.get(&node_id) {
            state.drag.dragging_node = Some(node_id);
            state.drag.node_start_x = node.x;
            state.drag.node_start_y = node.y;
        }
    }
}

/// `offset_x/y` are the TOTAL offset from the drag start (not deltas).
fn on_drag_update(offset_x: f64, offset_y: f64, graph: &mut AudioGraph, state: &mut CanvasState) {
    if let Some(node_id) = state.drag.dragging_node {
        if let Some(node) = graph.nodes.get_mut(&node_id) {
            node.x = (state.drag.node_start_x + offset_x).max(0.0);
            node.y = (state.drag.node_start_y + offset_y).max(0.0);
        }
    } else if state.connect.source_port.is_some() {
        state.connect.cursor_x = state.connect.start_x + offset_x;
        state.connect.cursor_y = state.connect.start_y + offset_y;
    }
}

/// `offset_x/y` are the final total offset from drag start.
fn on_drag_end(
    offset_x: f64,
    offset_y: f64,
    graph: &AudioGraph,
    state: &mut CanvasState,
    pw: &PwThread,
) {
    if let Some(src) = state.connect.source_port.take() {
        let end_x = state.connect.start_x + offset_x;
        let end_y = state.connect.start_y + offset_y;
        if let Some(dst) = hit_test_port(end_x, end_y, graph) {
            if dst.direction == Direction::Input && dst.node_id != src.node_id {
                pw.send(PwCommand::CreateLink {
                    output_port_id: src.port_id,
                    input_port_id: dst.port_id,
                });
            }
        }
    }
    state.drag.dragging_node = None;
}

fn on_right_click(x: f64, y: f64, graph: &AudioGraph, pw: &PwThread) {
    if let Some(link_id) = hit_test_link(x, y, graph) {
        pw.send(PwCommand::DestroyLink { link_id });
    }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

fn node_height(in_count: usize, out_count: usize) -> f64 {
    let rows = in_count.max(out_count).max(1);
    NODE_HEADER_HEIGHT + PORT_PADDING_TOP + rows as f64 * PORT_ROW_HEIGHT + 8.0
}

fn port_pos_in_node(node_x: f64, node_y: f64, idx: usize, dir: Direction) -> (f64, f64) {
    let y = node_y
        + NODE_HEADER_HEIGHT
        + PORT_PADDING_TOP
        + idx as f64 * PORT_ROW_HEIGHT
        + PORT_ROW_HEIGHT / 2.0;
    let x = match dir {
        Direction::Output => node_x + NODE_WIDTH,
        Direction::Input => node_x,
    };
    (x, y)
}

fn hit_test_node(x: f64, y: f64, graph: &AudioGraph) -> Option<u32> {
    for node in graph.nodes.values() {
        let in_count = graph.input_ports_for_node(node.id).len();
        let out_count = graph.output_ports_for_node(node.id).len();
        let h = node_height(in_count, out_count);
        if x >= node.x && x <= node.x + NODE_WIDTH && y >= node.y && y <= node.y + h {
            return Some(node.id);
        }
    }
    None
}

fn hit_test_port(x: f64, y: f64, graph: &AudioGraph) -> Option<PortRef> {
    for node in graph.nodes.values() {
        for (idx, port) in graph.output_ports_for_node(node.id).into_iter().enumerate() {
            let (px, py) = port_pos_in_node(node.x, node.y, idx, Direction::Output);
            if (x - px).powi(2) + (y - py).powi(2) <= (PORT_RADIUS + 4.0).powi(2) {
                return Some(PortRef {
                    node_id: node.id,
                    port_id: port.id,
                    direction: Direction::Output,
                });
            }
        }
        for (idx, port) in graph.input_ports_for_node(node.id).into_iter().enumerate() {
            let (px, py) = port_pos_in_node(node.x, node.y, idx, Direction::Input);
            if (x - px).powi(2) + (y - py).powi(2) <= (PORT_RADIUS + 4.0).powi(2) {
                return Some(PortRef {
                    node_id: node.id,
                    port_id: port.id,
                    direction: Direction::Input,
                });
            }
        }
    }
    None
}

fn port_world_pos(port_id: u32, graph: &AudioGraph) -> Option<(f64, f64)> {
    let port = graph.ports.get(&port_id)?;
    let node = graph.nodes.get(&port.node_id)?;
    let dir = port.direction;

    let same_dir: Vec<_> = match dir {
        Direction::Output => graph.output_ports_for_node(node.id),
        Direction::Input => graph.input_ports_for_node(node.id),
    };

    let idx = same_dir.iter().position(|p| p.id == port_id)?;
    Some(port_pos_in_node(node.x, node.y, idx, dir))
}

fn hit_test_link(x: f64, y: f64, graph: &AudioGraph) -> Option<u32> {
    for link in graph.links.values() {
        let (ox, oy) = port_world_pos(link.output_port_id, graph)?;
        let (ix, iy) = port_world_pos(link.input_port_id, graph)?;
        if min_bezier_dist(x, y, ox, oy, ix, iy) < 8.0 {
            return Some(link.id);
        }
    }
    None
}

fn min_bezier_dist(px: f64, py: f64, x0: f64, y0: f64, x3: f64, y3: f64) -> f64 {
    let dx = (x3 - x0).abs() * 0.5;
    let x1 = x0 + dx;
    let x2 = x3 - dx;
    // Control points: (x1,y0) and (x2,y3)
    let mut min_d = f64::MAX;
    for i in 0..=20 {
        let t = i as f64 / 20.0;
        let mt = 1.0 - t;
        let bx = mt * mt * mt * x0
            + 3.0 * mt * mt * t * x1
            + 3.0 * mt * t * t * x2
            + t * t * t * x3;
        let by = mt * mt * mt * y0
            + 3.0 * mt * mt * t * y0
            + 3.0 * mt * t * t * y3
            + t * t * t * y3;
        let d = ((px - bx).powi(2) + (py - by).powi(2)).sqrt();
        if d < min_d {
            min_d = d;
        }
    }
    min_d
}

// ---------------------------------------------------------------------------
// Cairo drawing
// ---------------------------------------------------------------------------

fn draw_canvas(ctx: &Context, graph: &AudioGraph, state: &CanvasState) {
    // Background
    let (r, g, b) = COLOR_BG;
    ctx.set_source_rgb(r, g, b);
    ctx.paint().ok();

    // Dot Grid
    ctx.set_source_rgba(1.0, 1.0, 1.0, 0.05);
    for x in (0..3000).step_by(20) {
        for y in (0..2000).step_by(20) {
            ctx.rectangle(x as f64, y as f64, 2.0, 2.0);
        }
    }
    ctx.fill().ok();

    // Links
    for link in graph.links.values() {
        if let (Some((ox, oy)), Some((ix, iy))) = (
            port_world_pos(link.output_port_id, graph),
            port_world_pos(link.input_port_id, graph),
        ) {
            let link_color = color_for_port(link.output_port_id);
            draw_cable(ctx, ox, oy, ix, iy, link_color, 3.0);
        }
    }

    // Dragging cable
    if let Some(src) = &state.connect.source_port {
        if let Some((ox, oy)) = port_world_pos(src.port_id, graph) {
            draw_cable(
                ctx,
                ox,
                oy,
                state.connect.cursor_x,
                state.connect.cursor_y,
                COLOR_LINK_DRAG,
                3.0,
            );
        }
    }

    // Nodes — skip internal PipeWire nodes with no media.class
    for node in graph.nodes.values() {
        if node.media_class.is_none() {
            continue;
        }
        draw_node(ctx, node.id, graph, state);
    }
}

fn draw_node(ctx: &Context, node_id: u32, graph: &AudioGraph, state: &CanvasState) {
    let node = match graph.nodes.get(&node_id) {
        Some(n) => n,
        None => return,
    };

    let in_ports = graph.input_ports_for_node(node_id);
    let out_ports = graph.output_ports_for_node(node_id);
    let h = node_height(in_ports.len(), out_ports.len());
    let x = node.x;
    let y = node.y;

    let is_dragged = state.drag.dragging_node == Some(node_id);

    // Shadow
    ctx.set_source_rgba(0.0, 0.0, 0.0, if is_dragged { 0.6 } else { 0.3 });
    rounded_rect(ctx, x + 4.0, y + 4.0, NODE_WIDTH, h, NODE_CORNER_RADIUS);
    ctx.fill().ok();
    
    // Soft shadow expansion
    ctx.set_source_rgba(0.0, 0.0, 0.0, 0.1);
    rounded_rect(ctx, x - 2.0, y - 2.0, NODE_WIDTH + 4.0, h + 4.0, NODE_CORNER_RADIUS + 2.0);
    ctx.fill().ok();

    // Node body
    let (r, g, b) = COLOR_NODE_BG;
    ctx.set_source_rgb(r, g, b);
    rounded_rect(ctx, x, y, NODE_WIDTH, h, NODE_CORNER_RADIUS);
    ctx.fill_preserve().ok();

    // Border
    let (r, g, b) = COLOR_NODE_BORDER;
    ctx.set_source_rgb(r, g, b);
    ctx.set_line_width(1.0);
    ctx.stroke().ok();

    // Header
    let (r, g, b) = match node.node_type {
        crate::audio::NodeType::Source => (0.28, 0.38, 0.36),
        crate::audio::NodeType::Sink => (0.36, 0.28, 0.38),
        crate::audio::NodeType::Filter | crate::audio::NodeType::Duplex => (0.36, 0.36, 0.28),
        _ => COLOR_NODE_HEADER,
    };
    ctx.set_source_rgb(r, g, b);
    rounded_rect_top(ctx, x, y, NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_CORNER_RADIUS);
    ctx.fill().ok();

    // Node title
    let (r, g, b) = COLOR_TEXT;
    ctx.set_source_rgb(r, g, b);
    let layout = pangocairo::functions::create_layout(ctx);
    layout.set_width(((NODE_WIDTH - 16.0) * pango::SCALE as f64) as i32);
    layout.set_ellipsize(pango::EllipsizeMode::End);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 9")));
    layout.set_text(node.display_name());
    ctx.move_to(x + 8.0, y + (NODE_HEADER_HEIGHT - 12.0) / 2.0);
    pangocairo::functions::show_layout(ctx, &layout);

    // Output ports (right side)
    for (idx, port) in out_ports.iter().enumerate() {
        let (px, py) = port_pos_in_node(x, y, idx, Direction::Output);
        draw_port_circle(ctx, px, py, COLOR_PORT_OUT);
        draw_port_label_left(ctx, px, py, &port.name);
    }

    // Input ports (left side)
    for (idx, port) in in_ports.iter().enumerate() {
        let (px, py) = port_pos_in_node(x, y, idx, Direction::Input);
        draw_port_circle(ctx, px, py, COLOR_PORT_IN);
        draw_port_label_right(ctx, px, py, &port.name);
    }
}

fn draw_port_circle(ctx: &Context, px: f64, py: f64, color: (f64, f64, f64)) {
    let (r, g, b) = color;
    ctx.set_source_rgb(r, g, b);
    ctx.arc(px, py, PORT_RADIUS, 0.0, std::f64::consts::TAU);
    ctx.fill().ok();

    ctx.set_source_rgb(0.0, 0.0, 0.0);
    ctx.arc(px, py, PORT_RADIUS, 0.0, std::f64::consts::TAU);
    ctx.set_line_width(1.0);
    ctx.stroke().ok();
}

fn draw_port_label_left(ctx: &Context, px: f64, py: f64, name: &str) {
    let layout = pangocairo::functions::create_layout(ctx);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 8")));
    layout.set_text(name);
    let (w, _) = layout.pixel_size();
    let (r, g, b) = COLOR_TEXT;
    ctx.set_source_rgba(r, g, b, 0.7);
    ctx.move_to(px - PORT_RADIUS - 4.0 - w as f64, py - 6.0);
    pangocairo::functions::show_layout(ctx, &layout);
}

fn draw_port_label_right(ctx: &Context, px: f64, py: f64, name: &str) {
    let layout = pangocairo::functions::create_layout(ctx);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 8")));
    layout.set_text(name);
    let (r, g, b) = COLOR_TEXT;
    ctx.set_source_rgba(r, g, b, 0.7);
    ctx.move_to(px + PORT_RADIUS + 4.0, py - 6.0);
    pangocairo::functions::show_layout(ctx, &layout);
}

const CABLE_COLORS: &[(f64, f64, f64)] = &[
    (0.4, 0.8, 0.4), // Green
    (0.4, 0.6, 0.9), // Blue
    (0.9, 0.8, 0.3), // Yellow
    (0.8, 0.4, 0.8), // Purple
    (0.4, 0.8, 0.8), // Cyan
    (0.9, 0.6, 0.3), // Orange
    (0.9, 0.4, 0.7), // Pink
    (0.9, 0.4, 0.4), // Red
];

fn color_for_port(port_id: u32) -> (f64, f64, f64) {
    let mut hash = port_id;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85ebca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2ae35);
    hash ^= hash >> 16;
    CABLE_COLORS[(hash as usize) % CABLE_COLORS.len()]
}

fn draw_cable(ctx: &Context, x0: f64, y0: f64, x3: f64, y3: f64, color: (f64, f64, f64), width: f64) {
    let dx = ((x3 - x0).abs() * 0.5).max(60.0);
    let (r, g, b) = color;
    
    // Background stroke (outline)
    ctx.set_source_rgba(0.0, 0.0, 0.0, 0.8);
    ctx.set_line_width(width + 2.0);
    ctx.move_to(x0, y0);
    ctx.curve_to(x0 + dx, y0, x3 - dx, y3, x3, y3);
    ctx.stroke().ok();

    // Foreground stroke
    ctx.set_source_rgb(r, g, b);
    ctx.set_line_width(width);
    ctx.move_to(x0, y0);
    ctx.curve_to(x0 + dx, y0, x3 - dx, y3, x3, y3);
    ctx.stroke().ok();
}

// --- Cairo shape helpers ---

fn rounded_rect(ctx: &Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    use std::f64::consts::{FRAC_PI_2, PI};
    let r = r.min(w / 2.0).min(h / 2.0);
    ctx.new_sub_path();
    ctx.arc(x + w - r, y + r, r, -FRAC_PI_2, 0.0);
    ctx.arc(x + w - r, y + h - r, r, 0.0, FRAC_PI_2);
    ctx.arc(x + r, y + h - r, r, FRAC_PI_2, PI);
    ctx.arc(x + r, y + r, r, PI, PI * 1.5);
    ctx.close_path();
}

fn rounded_rect_top(ctx: &Context, x: f64, y: f64, w: f64, h: f64, r: f64) {
    use std::f64::consts::{FRAC_PI_2, PI};
    let r = r.min(w / 2.0).min(h);
    ctx.new_sub_path();
    ctx.arc(x + w - r, y + r, r, -FRAC_PI_2, 0.0);
    ctx.line_to(x + w, y + h);
    ctx.line_to(x, y + h);
    ctx.arc(x + r, y + r, r, PI, PI * 1.5);
    ctx.close_path();
}
