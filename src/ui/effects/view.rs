/// EQ and effects panel.
///
/// Shows a target-sink selector (DropDown) and a 5-band parametric EQ with:
///   - Interactive curve editor (DrawingArea + Cairo)
///   - Per-band SpinButtons for frequency, gain, Q
///   - Apply / Remove buttons that manage a PipeWire filter-chain subprocess
use std::cell::RefCell;
use std::rc::Rc;

use cairo::Context;
use gtk4::prelude::*;

use crate::audio::{
    eq::{combined_magnitude_db, default_bands, EqBand},
    effects::{start_eq, EqInstance},
    AudioGraph,
};

#[derive(Clone)]
pub struct EffectsView {
    root: gtk4::Box,
    graph: Rc<RefCell<AudioGraph>>,
    // These fields are "owned" to keep closures alive; accessed via Rc clones
    #[allow(dead_code)]
    bands: Rc<RefCell<Vec<EqBand>>>,
    #[allow(dead_code)]
    eq_instance: Rc<RefCell<Option<EqInstance>>>,
    #[allow(dead_code)]
    curve_canvas: gtk4::DrawingArea,
    sink_model: gtk4::StringList,
    target_dropdown: gtk4::DropDown,
}

impl EffectsView {
    pub fn new(graph: Rc<RefCell<AudioGraph>>) -> Self {
        let bands = Rc::new(RefCell::new(default_bands()));
        let eq_instance: Rc<RefCell<Option<EqInstance>>> = Rc::new(RefCell::new(None));

        // --- Target sink selector ---
        let sink_model = gtk4::StringList::new(&["(sin selección)"]);
        let target_dropdown = gtk4::DropDown::new(
            Some(sink_model.clone()),
            gtk4::Expression::NONE,
        );
        target_dropdown.set_selected(0);

        // --- EQ curve canvas ---
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

        // --- Band controls ---
        let bands_grid = build_band_controls(&bands, &curve_canvas);

        // --- Apply / Remove buttons ---
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

        // --- Layout ---
        let root = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Vertical)
            .spacing(8)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(12)
            .margin_end(12)
            .build();

        let header_row = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(8)
            .build();
        header_row.append(&gtk4::Label::new(Some("Sink destino:")));
        header_row.append(&target_dropdown);
        header_row.append(&btn_row);

        root.append(&header_row);
        root.append(&curve_canvas);
        root.append(&bands_grid);

        Self {
            root,
            graph,
            bands,
            eq_instance,
            curve_canvas,
            sink_model,
            target_dropdown,
        }
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.root.upcast_ref()
    }

    /// Update the sink list from the current audio graph.
    pub fn refresh_sinks(&self) {
        // Save current selection
        let current = selected_sink_name(&self.target_dropdown);

        // Rebuild model
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

        // Restore selection
        if !current.is_empty() && current != "(sin selección)" {
            if let Some(pos) = sink_names.iter().position(|n| n == &current) {
                self.target_dropdown.set_selected((pos + 1) as u32); // +1 for placeholder
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: get selected sink name from DropDown
// ---------------------------------------------------------------------------

fn selected_sink_name(dd: &gtk4::DropDown) -> String {
    dd.selected_item()
        .and_then(|o| o.downcast::<gtk4::StringObject>().ok())
        .map(|s| s.string().to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Band controls
// ---------------------------------------------------------------------------

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

        // Frequency
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

        // Gain
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

        // Q
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

        // Enable toggle
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

    // Background
    ctx.set_source_rgb(0.1, 0.1, 0.12);
    ctx.rectangle(0.0, 0.0, w, h);
    ctx.fill().ok();

    // 0 dB line
    ctx.set_line_width(0.5);
    ctx.set_source_rgba(0.4, 0.4, 0.4, 0.6);
    let y0 = db_to_y(0.0, h);
    ctx.move_to(0.0, y0);
    ctx.line_to(w, y0);
    ctx.stroke().ok();

    // Vertical grid: octave lines
    for f in [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0] {
        let x = freq_to_x(f, w);
        ctx.move_to(x, 0.0);
        ctx.line_to(x, h);
        ctx.stroke().ok();
    }

    // Horizontal grid: ±6, ±12 dB
    ctx.set_source_rgba(0.3, 0.3, 0.3, 0.4);
    for db in [-12.0, -6.0, 6.0, 12.0] {
        let y = db_to_y(db, h);
        ctx.move_to(0.0, y);
        ctx.line_to(w, y);
        ctx.stroke().ok();
    }

    // EQ curve
    if bands.iter().any(|b| b.enabled) {
        ctx.set_source_rgb(0.3, 0.8, 0.4);
        ctx.set_line_width(2.0);

        let steps = 512usize;
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            let log_f =
                FREQ_MIN.log10() + t * (FREQ_MAX.log10() - FREQ_MIN.log10());
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

    // Labels
    ctx.set_source_rgba(0.7, 0.7, 0.7, 0.8);
    let layout = pangocairo::functions::create_layout(ctx);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 8")));
    layout.set_text("0 dB");
    ctx.move_to(4.0, y0 - 12.0);
    pangocairo::functions::show_layout(ctx, &layout);
}
