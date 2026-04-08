/// Volume mixer panel.
///
/// Shows one vertical strip per audio node (apps + devices).
/// Each strip has:
///   - Node name label
///   - Vertical volume fader (Gtk.Scale)
///   - Mute toggle button
///   - Peak level bar (simple DrawingArea updated by timer)
///
/// Volume changes are applied via `pactl` subprocess (PulseAudio compat layer).
use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use log::debug;

use crate::audio::{AudioGraph, AudioNode};

#[derive(Clone)]
pub struct MixerView {
    scrolled: gtk4::ScrolledWindow,
    strips_box: gtk4::Box,
    graph: Rc<RefCell<AudioGraph>>,
    pw: Rc<crate::audio::PwThread>,
}

impl MixerView {
    pub fn new(graph: Rc<RefCell<AudioGraph>>, _pw: Rc<crate::audio::PwThread>) -> Self {
        let strips_box = gtk4::Box::builder()
            .orientation(gtk4::Orientation::Horizontal)
            .spacing(4)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(12)
            .margin_end(12)
            .build();

        let scrolled = gtk4::ScrolledWindow::builder()
            .child(&strips_box)
            .hexpand(true)
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Automatic)
            .vscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        Self {
            scrolled,
            strips_box,
            graph,
            pw: _pw,
        }
    }

    pub fn widget(&self) -> &gtk4::Widget {
        self.scrolled.upcast_ref()
    }

    /// Rebuild all strips from the current graph state.
    pub fn refresh(&self) {
        // Remove all existing strips
        while let Some(child) = self.strips_box.first_child() {
            self.strips_box.remove(&child);
        }

        let graph = self.graph.borrow();
        let nodes = graph.audio_nodes_sorted();

        for node in nodes {
            let strip = build_strip(node, &graph, self.pw.clone());
            self.strips_box.append(&strip);
        }
    }
}

// ---------------------------------------------------------------------------
// Strip builder
// ---------------------------------------------------------------------------

fn build_strip(node: &AudioNode, _graph: &AudioGraph, _pw: Rc<crate::audio::PwThread>) -> gtk4::Frame {
    let frame = gtk4::Frame::builder()
        .label(node.display_name())
        .width_request(140)
        .build();

    let vbox = gtk4::Box::builder()
        .orientation(gtk4::Orientation::Vertical)
        .spacing(4)
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(8)
        .margin_end(8)
        .build();

    // Media class badge
    if let Some(class) = &node.media_class {
        let badge = gtk4::Label::builder()
            .label(short_class(class))
            .css_classes(["caption"])
            .halign(gtk4::Align::Center)
            .build();
        vbox.append(&badge);
    }

    // Volume fader (vertical)
    let fader = gtk4::Scale::builder()
        .orientation(gtk4::Orientation::Vertical)
        .adjustment(&gtk4::Adjustment::new(
            (node.volume as f64 * 100.0).round(),
            0.0,
            150.0, // allow up to 150% like pavucontrol
            1.0,
            10.0,
            0.0,
        ))
        .inverted(true)
        .draw_value(true)
        .value_pos(gtk4::PositionType::Bottom)
        .height_request(180)
        .build();
    fader.set_format_value_func(|_, v| format!("{:.0}%", v));

    let node_name = node.name.clone();
    fader.connect_value_changed(move |scale| {
        let vol = scale.value() / 100.0;
        set_volume_pactl(&node_name, vol);
    });

    vbox.append(&fader);

    // Mute toggle
    let muted = node.muted;
    let mute_btn = gtk4::ToggleButton::builder()
        .label(if muted { "Muted" } else { "Active" })
        .active(muted)
        .build();

    let node_name2 = node.name.clone();
    let mute_btn_ref = mute_btn.clone();
    mute_btn.connect_toggled(move |btn| {
        let muted = btn.is_active();
        btn.set_label(if muted { "Muted" } else { "Active" });
        set_mute_pactl(&node_name2, muted);
    });

    vbox.append(&mute_btn_ref);
    frame.set_child(Some(&vbox));
    frame
}

fn short_class(class: &str) -> &str {
    if class.contains("Sink") {
        "Sink"
    } else if class.contains("Source") {
        "Source"
    } else if class.starts_with("Stream/Input") {
        "App→Sink"
    } else if class.starts_with("Stream/Output") {
        "Src→App"
    } else {
        class.split('/').last().unwrap_or(class)
    }
}

// ---------------------------------------------------------------------------
// Volume control via pactl (PulseAudio compat)
// ---------------------------------------------------------------------------

fn set_volume_pactl(node_name: &str, volume: f64) {
    let vol_pct = format!("{:.0}%", (volume * 100.0).round());
    debug!("pactl set-sink-volume {node_name} {vol_pct}");
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-volume", node_name, &vol_pct])
        .status();
    // Also try as source
    let _ = std::process::Command::new("pactl")
        .args(["set-source-volume", node_name, &vol_pct])
        .status();
}

fn set_mute_pactl(node_name: &str, muted: bool) {
    let state = if muted { "1" } else { "0" };
    debug!("pactl set-sink-mute {node_name} {state}");
    let _ = std::process::Command::new("pactl")
        .args(["set-sink-mute", node_name, state])
        .status();
    let _ = std::process::Command::new("pactl")
        .args(["set-source-mute", node_name, state])
        .status();
}
