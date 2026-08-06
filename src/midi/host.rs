//! Plugin load/lifecycle/state persistence, plus the handle `commands.rs`
//! keeps per running MIDI channel.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use vst3_host::plugin::{Plugin, PluginInfo};

use super::stream::StreamHandle;

/// Fixed engine format for the MVP. PipeWire negotiates its own quantum
/// with the graph; the stream resamples/rebuffers at its boundary rather
/// than reconfiguring the plugin on the fly (see `stream.rs`).
pub const SAMPLE_RATE: f64 = 48_000.0;
pub const BLOCK_SIZE: usize = 512;

/// Fast, load-free scan of the standard VST3 install locations
/// (`~/.vst3`, `/usr/lib/vst3`, `/usr/local/lib/vst3`, ...). Safe to call
/// often — unlike `discover_plugins`, this only walks the filesystem, it
/// never loads/initializes a plugin.
pub fn scan_paths() -> Vec<PathBuf> {
    vst3_host::Vst3Host::builder()
        .scan_default_paths()
        .build()
        .map(|h| h.scan_plugin_paths())
        .unwrap_or_default()
}

/// Read a bundle's metadata without keeping it loaded. Used by the
/// "Add Plugin" flow to show a name/vendor instead of a bare path.
pub fn probe(path: &Path) -> Option<PluginInfo> {
    vst3_host::discovery::get_plugin_info(path).ok()
}

fn load(path: &Path) -> vst3_host::Result<Plugin> {
    let mut host = vst3_host::Vst3Host::builder()
        .sample_rate(SAMPLE_RATE)
        .block_size(BLOCK_SIZE)
        .output_channels(2)
        .build()?;
    host.load_plugin(path)
}

fn state_path(channel_id: u32) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home)
        .join(".config/audibian/midi")
        .join(format!("{channel_id}.vst3state"))
}

fn save_state(plugin: &Plugin, channel_id: u32) {
    let Ok(bytes) = plugin.save_state() else { return };
    let path = state_path(channel_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, bytes);
}

fn restore_state(plugin: &mut Plugin, channel_id: u32) {
    if let Ok(bytes) = std::fs::read(state_path(channel_id)) {
        let _ = plugin.load_state(&bytes);
    }
}

/// A running plugin for one MIDI channel: the plugin itself (shared with
/// the audio thread via `Arc<Mutex<_>>` — correctness-first, matching what
/// `vst3-host`'s own `Vst3Host::play` does internally; can move to the
/// lock-free `RealtimePluginRunner` later if contention shows up), the
/// PipeWire stream driving it, and (optionally) its native editor window.
///
/// The editor is a floating top-level for now, not embedded inline into
/// Audibian's own layout — `vst3_host::window::PluginWindow` creates and
/// owns its own XCB window on Linux and XEMBEDs the plugin's editor into
/// it directly, so this needed no X11 plumbing of our own to get a real,
/// interactive plugin GUI. Inline embedding (reparenting that window into
/// a slot in the MIDI Channels tab) is a follow-up, not required for the
/// plugin to actually be usable.
pub struct PluginHostHandle {
    pub plugin: Arc<Mutex<Plugin>>,
    channel_id: u32,
    _stream: StreamHandle,
    gui: Mutex<Option<vst3_host::window::PluginWindow>>,
}

impl PluginHostHandle {
    /// Load `plugin_path`, restore any previously-saved state, start
    /// processing, and spin up the PipeWire stream that feeds it MIDI and
    /// pulls its audio into `sink_name`.
    pub fn start(channel_id: u32, sink_name: &str, plugin_path: &Path) -> vst3_host::Result<Self> {
        let mut plugin = load(plugin_path)?;
        restore_state(&mut plugin, channel_id);
        plugin.start_processing()?;
        let plugin = Arc::new(Mutex::new(plugin));
        let stream = super::stream::spawn(sink_name, plugin.clone());
        Ok(Self { plugin, channel_id, _stream: stream, gui: Mutex::new(None) })
    }

    /// Open the plugin's native editor as a floating window. No-op (returns
    /// Ok) if already open.
    pub fn show_gui(&self) -> vst3_host::Result<()> {
        let mut gui = self.gui.lock().unwrap();
        if gui.as_ref().is_some_and(|w| w.is_open()) {
            return Ok(());
        }
        let mut window = vst3_host::window::PluginWindow::new(self.plugin.clone());
        window.open()?;
        *gui = Some(window);
        Ok(())
    }

    /// Close the plugin's native editor window, if open.
    pub fn hide_gui(&self) {
        if let Some(mut window) = self.gui.lock().unwrap().take() {
            window.close();
        }
    }

    /// Persist the plugin's current state before it's torn down, so the
    /// next `start()` for this channel picks up where it left off.
    pub fn stop(self) {
        self.hide_gui();
        if let Ok(p) = self.plugin.lock() {
            save_state(&p, self.channel_id);
        }
        // `_stream`'s Drop stops the PipeWire thread.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs a real VST3 installed locally — not something CI can assume.
    // Run explicitly with `cargo test -- --ignored load_and_play_pianoteq`.
    #[test]
    #[ignore]
    fn load_and_play_pianoteq() {
        let path = Path::new(
            "/home/marcos/Descargas/pianoteq_trial_v912/Pianoteq 9/x86-64bit/Pianoteq 9.vst3",
        );
        let mut plugin = load(path).expect("load Pianoteq 9 VST3");
        plugin.start_processing().expect("start_processing");
        plugin
            .send_midi_note(60, 100, vst3_host::midi::MidiChannel::Ch1)
            .expect("send_midi_note");

        let mut buffers = vst3_host::audio::AudioBuffers::new(0, 2, BLOCK_SIZE, SAMPLE_RATE);
        let mut peak = 0.0_f32;
        // A few blocks so the note's attack has time to ramp in.
        for _ in 0..20 {
            buffers.clear();
            plugin.process_audio(&mut buffers).expect("process_audio");
            for ch in &buffers.outputs {
                for &s in ch {
                    peak = peak.max(s.abs());
                }
            }
        }
        assert!(peak > 0.001, "expected audible output from a held note, got peak {peak}");
    }
}
