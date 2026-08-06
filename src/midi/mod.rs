//! In-process VST2/VST3 plugin hosting for MIDI channels.
//!
//! Replaces the previous design of spawning `carla-rack` and driving it over
//! OSC. That approach turned out to be unfixable on this machine: the
//! packaged `carla` build has no `liblo`/OSC support compiled in at all (see
//! git history on `commands.rs`'s old MIDI/VST section for the full chain of
//! bugs found before landing on that root cause), so every remote-control
//! message — add plugin, show GUI, sync the chain — went nowhere. Hosting
//! the plugin ourselves removes the external process, the OSC transport and
//! the packaging dependency entirely.
//!
//! `host` owns plugin load/lifecycle/state persistence. `input` owns the
//! MIDI keyboard bridge. `stream` owns the PipeWire audio-out stream that
//! actually drives the plugin's `process()` on an audio thread.

pub mod input;
pub mod host;
pub mod stream;
