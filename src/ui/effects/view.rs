/// EQ and effects panel.
///
/// Shows two sections:
///   1. Parametric EQ — target-sink selector + 5-band EQ curve + band controls
///   2. Noise Suppression — per-source toggle + VAD-threshold slider (builtin rnnoise)
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use cairo::Context;
use gtk4::prelude::*;

use crate::audio::{
    eq::{combined_magnitude_db, default_bands, EqBand},
    effects::{start_eq, start_noise_suppression, EqInstance, NsInstance},
    AudioGraph,
};

#[derive(Clone)]
pub struct EffectsView {
    root: gtk4::Box,
    graph: Rc<RefCell<AudioGraph>>,
    // EQ state
    #[allow(dead_code)]
    bands: Rc<RefCell<Vec<EqBand>>>,
    #[allow(dead_code)]
    eq_instance: Rc<RefCell<Option<EqInstance>>>,
    #[allow(dead_code)]
    curve_canvas: gtk4::DrawingArea,
    sink_model: gtk4::StringList,
    target_dropdown: gtk4::DropDown,
    // NS state
    ns_instances: Rc<RefCell<HashMap<String, NsInstance>>>,
    ns_list_box: gtk4::ListBox,
}

impl EffectsView {
    pub fn new(graph: Rc<RefCell<AudioGraph>>) -> Self {
        let bands = Rc::new(RefCell::new(default_bands()));
        let eq_instance: Rc<RefCell<Option<EqInstance>>> = Rc::new(RefCell::new(None));

        // ── EQ: Target sink selector ──────────────────────────────────────
        let sink_model = gtk4::StringList::new(&["(sin selección)"]);
        let target_dropdown = gtk4::DropDown::new(
            Some(sink_model.clone()),
            gtk4::Expression::NONE,
        );
        target_dropdown.set_selected(0);

        // ── EQ: Curve canvas ──────────────────────────────────────────────
        let curve_canvas = gtk4::DrawingArea::builder()
            .content_width(600)
            .content_height(200)
            .hexpand(true)
            .build();

        {
            let bands_ref = bands.clone();
            curve_canvas.set_draw_func(move |_, ctx, w, h| {
                draw_eq_curve(ctx, w, h, &bands_ref.borrow());
            });
        }

        // ── EQ: Band controls ─────────────────────────────────────────────
        let bands_grid = build_band_controls(&bands, &curve_canvas);

        // ── EQ: Apply / Remove buttons ────────────────────────────────────
        let btn_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .build();

        let apply_btn = gtk4::Button::builder().label("Aplicar EQ").build();
        let remove_btn = gtk4::Button::builder().label("Quitar EQ").build();
        btn_row.append(&apply_btn);
        btn_row.append(&remove_btn);

        {
            let bands_ref = bands.clone();
            let eq_ref = eq_instance.clone();
            let dd_ref = target_dropdown.clone();
            apply_btn.connect_clicked(move |_| {
                let sink = selected_sink_name(&dd_ref);
                if sink.is_empty() || sink == "(sin selección)" {
                    return;
                }
                let bs = bands_ref.borrow();
                *eq_ref.borrow_mut() = start_eq(&sink, &bs, 48000);
            });
        }

        {
            let eq_ref2 = eq_instance.clone();
            remove_btn.connect_clicked(move |_| {
                *eq_ref2.borrow_mut() = None;
            });
        }

        // ── NS: ListBox ───────────────────────────────────────────────────
        let ns_instances: Rc<RefCell<HashMap<String, NsInstance>>> =
            Rc::new(RefCell::new(HashMap::new()));
        let ns_list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::None)
            .build();
        ns_list_box.add_css_class("boxed-list");

        let ns_scroll = gtk4::ScrolledWindow::builder()
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .vscrollbar_policy(gtk4::PolicyType::Automatic)
            .max_content_height(300)
            .propagate_natural_height(true)
            .child(&ns_list_box)
            .build();

        // ── Layout ────────────────────────────────────────────────────────
        let root = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Vertical)
            .spacing(8)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(12)
            .margin_end(12)
            .build();

        // EQ section
        let eq_label = gtk4::Label::builder()
            .label("<b>Ecualizador Paramétrico</b>")
            .use_markup(true)
            .halign(gtk4::Align::Start)
            .build();

        let header_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .build();
        header_row.append(&gtk4::Label::new(Some("Sink destino:")));
        header_row.append(&target_dropdown);
        header_row.append(&btn_row);

        root.append(&eq_label);
        root.append(&header_row);
        root.append(&curve_canvas);
        root.append(&bands_grid);

        // Separator
        root.append(&gtk4::Separator::new(gtk4::Orientation::Horizontal));

        // NS section
        let ns_label = gtk4::Label::builder()
            .label("<b>Supresión de Ruido</b>")
            .use_markup(true)
            .halign(gtk4::Align::Start)
            .build();
        let ns_hint = gtk4::Label::builder()
            .label("Usa el procesador WebRTC para suprimir ruido de fondo. La fuente limpia aparece como «audibian-ns-…» en las apps.")
            .halign(gtk4::Align::Start)
            .wrap(true)
            .build();
        ns_hint.add_css_class("dim-label");

        root.append(&ns_label);
        root.append(&ns_hint);
        root.append(&ns_scroll);

        Self {
            root,
            graph,
            bands,
            eq_instance,
            curve_canvas,
            sink_model,
            target_dropdown,
            ns_instances,
            ns_list_box,
        }
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.root.upcast_ref()
    }

    /// Rebuild the sink DropDown from the current audio graph.
    pub fn refresh_sinks(&self) {
        let current = selected_sink_name(&self.target_dropdown);

        let n = self.sink_model.n_items();
        for _ in 0..n {
            self.sink_model.remove(0);
        }
        self.sink_model.append("(sin selección)");

        let graph = self.graph.borrow();
        let mut sink_names: Vec<String> = Vec::new();
        for node in graph.audio_nodes_sorted() {
            if node
                .media_class
                .as_deref()
                .map(|c| c.contains("Sink"))
                .unwrap_or(false)
            {
                self.sink_model.append(&node.name);
                sink_names.push(node.name.clone());
            }
        }

        if !current.is_empty() && current != "(sin selección)" {
            if let Some(pos) = sink_names.iter().position(|n| n == &current) {
                self.target_dropdown.set_selected((pos + 1) as u32);
            }
        }
    }

    /// Rebuild the noise-suppression source list from the current audio graph.
    pub fn refresh_sources(&self) {
        rebuild_ns_rows(&self.ns_list_box, &self.graph.borrow(), &self.ns_instances);
    }
}

// ---------------------------------------------------------------------------
// EQ helpers
// ---------------------------------------------------------------------------

fn selected_sink_name(dd: &gtk4::DropDown) -> String {
    dd.selected_item()
        .and_then(|o| o.downcast::<gtk4::StringObject>().ok())
        .map(|s| s.string().to_string())
        .unwrap_or_default()
}

fn build_band_controls(
    bands: &Rc<RefCell<Vec<EqBand>>>,
    canvas: &gtk4::DrawingArea,
) -> gtk4::Grid {
    let grid = gtk4::Grid::builder()
        .row_spacing(4)
        .column_spacing(8)
        .margin_top(8)
        .build();

    for (col, label) in ["Banda", "Tipo", "Frecuencia (Hz)", "Ganancia (dB)", "Q", "Act."]
        .iter()
        .enumerate()
    {
        let lbl = gtk4::Label::new(Some(label));
        lbl.set_halign(gtk4::Align::Center);
        grid.attach(&lbl, col as i32, 0, 1, 1);
    }

    let band_count = bands.borrow().len();
    for i in 0..band_count {
        let row = (i + 1) as i32;

        grid.attach(&gtk4::Label::new(Some(&format!("{}", i + 1))), 0, row, 1, 1);
        grid.attach(&gtk4::Label::new(Some(filter_type_name(i))), 1, row, 1, 1);

        let freq_val = bands.borrow()[i].frequency;
        let freq_adj = gtk4::Adjustment::new(freq_val, 20.0, 20000.0, 1.0, 100.0, 0.0);
        let freq_spin = gtk4::SpinButton::new(Some(&freq_adj), 1.0, 0);
        {
            let bands_ref = bands.clone();
            let canvas_ref = canvas.clone();
            freq_spin.connect_value_changed(move |spin| {
                bands_ref.borrow_mut()[i].frequency = spin.value();
                canvas_ref.queue_draw();
            });
        }
        grid.attach(&freq_spin, 2, row, 1, 1);

        let gain_adj = gtk4::Adjustment::new(0.0, -18.0, 18.0, 0.5, 1.0, 0.0);
        let gain_spin = gtk4::SpinButton::new(Some(&gain_adj), 0.5, 1);
        {
            let bands_ref = bands.clone();
            let canvas_ref = canvas.clone();
            gain_spin.connect_value_changed(move |spin| {
                bands_ref.borrow_mut()[i].gain_db = spin.value();
                canvas_ref.queue_draw();
            });
        }
        grid.attach(&gain_spin, 3, row, 1, 1);

        let q_adj = gtk4::Adjustment::new(1.0, 0.1, 10.0, 0.1, 1.0, 0.0);
        let q_spin = gtk4::SpinButton::new(Some(&q_adj), 0.1, 2);
        {
            let bands_ref = bands.clone();
            let canvas_ref = canvas.clone();
            q_spin.connect_value_changed(move |spin| {
                bands_ref.borrow_mut()[i].q = spin.value();
                canvas_ref.queue_draw();
            });
        }
        grid.attach(&q_spin, 4, row, 1, 1);

        let enable_check = gtk4::CheckButton::builder().active(true).build();
        {
            let bands_ref = bands.clone();
            let canvas_ref = canvas.clone();
            enable_check.connect_toggled(move |btn| {
                bands_ref.borrow_mut()[i].enabled = btn.is_active();
                canvas_ref.queue_draw();
            });
        }
        grid.attach(&enable_check, 5, row, 1, 1);
    }

    grid
}

fn filter_type_name(idx: usize) -> &'static str {
    match idx {
        0 => "Low Shelf",
        1 | 2 | 3 => "Peak",
        4 => "High Shelf",
        _ => "Peak",
    }
}

// ---------------------------------------------------------------------------
// EQ curve Cairo drawing
// ---------------------------------------------------------------------------

const FS: f64 = 48000.0;
const FREQ_MIN: f64 = 20.0;
const FREQ_MAX: f64 = 20000.0;
const DB_MIN: f64 = -18.0;
const DB_MAX: f64 = 18.0;

fn freq_to_x(f: f64, width: f64) -> f64 {
    let log_min = FREQ_MIN.log10();
    let log_max = FREQ_MAX.log10();
    let t = (f.log10() - log_min) / (log_max - log_min);
    t * width
}

fn db_to_y(db: f64, height: f64) -> f64 {
    let t = 1.0 - (db - DB_MIN) / (DB_MAX - DB_MIN);
    t * height
}

fn draw_eq_curve(ctx: &Context, width: i32, height: i32, bands: &[EqBand]) {
    let w = width as f64;
    let h = height as f64;

    ctx.set_source_rgb(0.1, 0.1, 0.12);
    ctx.rectangle(0.0, 0.0, w, h);
    ctx.fill().ok();

    ctx.set_line_width(0.5);
    ctx.set_source_rgba(0.4, 0.4, 0.4, 0.6);
    let y0 = db_to_y(0.0, h);
    ctx.move_to(0.0, y0);
    ctx.line_to(w, y0);
    ctx.stroke().ok();

    for f in [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0] {
        let x = freq_to_x(f, w);
        ctx.move_to(x, 0.0);
        ctx.line_to(x, h);
        ctx.stroke().ok();
    }

    ctx.set_source_rgba(0.3, 0.3, 0.3, 0.4);
    for db in [-12.0, -6.0, 6.0, 12.0] {
        let y = db_to_y(db, h);
        ctx.move_to(0.0, y);
        ctx.line_to(w, y);
        ctx.stroke().ok();
    }

    if bands.iter().any(|b| b.enabled) {
        ctx.set_source_rgb(0.3, 0.8, 0.4);
        ctx.set_line_width(2.0);

        let steps = 512usize;
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            let log_f = FREQ_MIN.log10() + t * (FREQ_MAX.log10() - FREQ_MIN.log10());
            let f = 10f64.powf(log_f);
            let db = combined_magnitude_db(bands, f, FS).clamp(DB_MIN, DB_MAX);
            let x = freq_to_x(f, w);
            let y = db_to_y(db, h);
            if i == 0 {
                ctx.move_to(x, y);
            } else {
                ctx.line_to(x, y);
            }
        }
        ctx.stroke().ok();
    }

    ctx.set_source_rgba(0.7, 0.7, 0.7, 0.8);
    let layout = pangocairo::functions::create_layout(ctx);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 8")));
    layout.set_text("0 dB");
    ctx.move_to(4.0, y0 - 12.0);
    pangocairo::functions::show_layout(ctx, &layout);
}

// ---------------------------------------------------------------------------
// Noise suppression source rows
// ---------------------------------------------------------------------------

fn rebuild_ns_rows(
    list_box: &gtk4::ListBox,
    graph: &AudioGraph,
    ns_instances: &Rc<RefCell<HashMap<String, NsInstance>>>,
) {
    // Remove all existing rows
    while let Some(child) = list_box.first_child() {
        list_box.remove(&child);
    }

    for node in graph.audio_nodes_sorted() {
        // Only real Audio/Source nodes (microphones, line-in, etc.)
        let is_real_source = node
            .media_class
            .as_deref()
            .map(|c| c == "Audio/Source")
            .unwrap_or(false);
        if !is_real_source {
            continue;
        }
        // Skip virtual sources created by us
        if node.name.starts_with("audibian-ns-") {
            continue;
        }

        let node_name = node.name.clone();
        let display = node.display_name().to_string();
        let active = ns_instances.borrow().contains_key(&node_name);
        let row = build_ns_row(node_name, display, active, ns_instances.clone());
        list_box.append(&row);
    }

    // Show a placeholder when there are no sources
    if list_box.first_child().is_none() {
        let placeholder = gtk4::Label::builder()
            .label("No se encontraron micrófonos o fuentes de audio.")
            .margin_top(12)
            .margin_bottom(12)
            .build();
        placeholder.add_css_class("dim-label");
        let row = gtk4::ListBoxRow::new();
        row.set_child(Some(&placeholder));
        list_box.append(&row);
    }
}

fn build_ns_row(
    node_name: String,
    display: String,
    active: bool,
    ns_instances: Rc<RefCell<HashMap<String, NsInstance>>>,
) -> gtk4::ListBoxRow {
    let row_box = gtk4::Box::builder()
        .orientation(gtk4::Orientation::Horizontal)
        .spacing(12)
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(8)
        .margin_end(8)
        .build();

    // Source name label
    let label = gtk4::Label::new(Some(&display));
    label.set_hexpand(true);
    label.set_halign(gtk4::Align::Start);
    label.set_ellipsize(pango::EllipsizeMode::End);

    // Badge showing "WebRTC NS"
    let badge = gtk4::Label::new(Some("WebRTC NS"));
    badge.add_css_class("dim-label");

    // Enable/disable switch
    let sw = gtk4::Switch::new();
    sw.set_active(active);
    sw.set_valign(gtk4::Align::Center);

    let name_for_switch = node_name.clone();
    let instances_for_switch = ns_instances.clone();

    sw.connect_state_set(move |_, state| {
        if state {
            if let Some(inst) = start_noise_suppression(&name_for_switch) {
                instances_for_switch
                    .borrow_mut()
                    .insert(name_for_switch.clone(), inst);
            }
        } else {
            instances_for_switch.borrow_mut().remove(&name_for_switch);
        }
        glib::Propagation::Proceed
    });

    row_box.append(&label);
    row_box.append(&badge);
    row_box.append(&sw);

    let row = gtk4::ListBoxRow::new();
    row.set_child(Some(&row_box));
    row
}
