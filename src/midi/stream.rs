//! PipeWire audio-out stream that drives a hosted plugin's `process()`.
//!
//! MIDI is handled separately by `input.rs`, which bridges keyboard events
//! from local MIDI input ports into the loaded plugins.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use log::debug;
use pipewire::{
    context::ContextRc,
    main_loop::MainLoopRc,
    properties::properties,
    spa,
    stream::{StreamBox, StreamFlags},
};
use spa::{
    param::audio::{AudioFormat, AudioInfoRaw},
    param::format::{MediaSubtype, MediaType},
    param::format_utils,
    pod::Pod,
    utils::Direction,
};
use vst3_host::{audio::AudioBuffers, plugin::Plugin};

use super::host::{BLOCK_SIZE, SAMPLE_RATE};

pub struct StreamHandle {
    stop: Arc<AtomicBool>,
    _thread: std::thread::JoinHandle<()>,
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Thread's process callback sees the flag and calls main_loop.quit()
    }
}

struct UserData {
    plugin: Arc<Mutex<Plugin>>,
    buffers: AudioBuffers,
    format: AudioInfoRaw,
    stop: Arc<AtomicBool>,
    main_loop: MainLoopRc,
}

/// Spawn the audio-out stream for a running plugin. `sink_name` is the
/// channel's existing null-sink (`audibian_midi_<id>`, created by
/// `create_null_sink` when the channel was added) — this stream becomes
/// its actual audio producer.
pub fn spawn(sink_name: &str, plugin: Arc<Mutex<Plugin>>) -> StreamHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();
    let sink_name = sink_name.to_string();

    let thread = std::thread::Builder::new()
        .name(format!("vst-out-{sink_name}"))
        .spawn(move || run(&sink_name, plugin, stop_clone))
        .expect("spawn vst audio-out thread");

    StreamHandle { stop, _thread: thread }
}

fn run(sink_name: &str, plugin: Arc<Mutex<Plugin>>, stop: Arc<AtomicBool>) {
    let main_loop = match MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(e) => { debug!("vst-out {sink_name}: MainLoop: {e}"); return; }
    };
    let context = match ContextRc::new(&main_loop, None) {
        Ok(c) => c,
        Err(e) => { debug!("vst-out {sink_name}: Context: {e}"); return; }
    };
    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(e) => { debug!("vst-out {sink_name}: connect: {e}"); return; }
    };

    let node_name = format!("audibian-vst-{sink_name}");
    let props = properties! {
        *pipewire::keys::MEDIA_TYPE      => "Audio",
        *pipewire::keys::MEDIA_CATEGORY  => "Playback",
        *pipewire::keys::MEDIA_ROLE      => "Music",
        *pipewire::keys::NODE_NAME       => node_name.as_str(),
        *pipewire::keys::APP_NAME        => "audibian-vst",
        // Bind straight to the channel's own null-sink by name — it's
        // ours, so binding by name is safe (no node-id lookup needed).
        *pipewire::keys::TARGET_OBJECT   => sink_name,
        "node.dont-reconnect" => "true",
    };

    let stream = match StreamBox::new(&core, &node_name, props) {
        Ok(s) => s,
        Err(e) => { debug!("vst-out {sink_name}: Stream: {e}"); return; }
    };

    let user_data = UserData {
        plugin,
        buffers: AudioBuffers::new(0, 2, BLOCK_SIZE, SAMPLE_RATE),
        format: Default::default(),
        stop,
        main_loop: main_loop.clone(),
    };

    let _listener = stream
        .add_local_listener_with_user_data(user_data)
        .param_changed(|_, ud, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() { return }

            let Ok((media_type, media_subtype)) = format_utils::parse_format(param) else { return };
            if media_type != MediaType::Audio || media_subtype != MediaSubtype::Raw { return }

            ud.format.parse(param).ok();
        })
        .process(|stream, ud| {
            if ud.stop.load(Ordering::Relaxed) {
                ud.main_loop.quit();
                return;
            }

            let mut buf = match stream.dequeue_buffer() {
                Some(b) => b,
                None => return,
            };

            let datas = buf.datas_mut();
            if datas.is_empty() { return; }

            let channels = ud.format.channels().max(1) as usize;
            let d = &mut datas[0];
            let Some(slice) = d.data() else { return };

            let capacity_frames = slice.len() / 4 / channels;
            let frames = capacity_frames.min(ud.buffers.block_size);
            if frames == 0 { return; }

            ud.buffers.clear();
            if let Ok(mut p) = ud.plugin.lock() {
                let _ = p.process_audio(&mut ud.buffers);
            }

            // Interleave the plugin's planar output into PipeWire's buffer.
            let out_channels = ud.buffers.output_channels().max(1);
            for frame in 0..frames {
                for ch in 0..channels {
                    let src_ch = ch.min(out_channels - 1);
                    let sample = ud.buffers.outputs[src_ch][frame];
                    let byte_off = (frame * channels + ch) * 4;
                    slice[byte_off..byte_off + 4].copy_from_slice(&sample.to_le_bytes());
                }
            }

            let chunk = d.chunk_mut();
            *chunk.offset_mut() = 0;
            *chunk.size_mut() = (frames * channels * 4) as u32;
            *chunk.stride_mut() = (channels * 4) as i32;
        })
        .register();

    let _listener = match _listener {
        Ok(l) => l,
        Err(e) => { debug!("vst-out {sink_name}: register listener: {e}"); return; }
    };

    let mut audio_info = AudioInfoRaw::new();
    audio_info.set_format(AudioFormat::F32LE);
    audio_info.set_rate(SAMPLE_RATE as u32);
    audio_info.set_channels(2);

    let obj = pipewire::spa::pod::Object {
        type_: pipewire::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id:    spa::param::ParamType::EnumFormat.as_raw(),
        properties: audio_info.into(),
    };
    let values: Vec<u8> = pipewire::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pipewire::spa::pod::Value::Object(obj),
    )
    .unwrap()
    .0
    .into_inner();

    let mut params = [Pod::from_bytes(&values).unwrap()];

    if let Err(e) = stream.connect(
        Direction::Output,
        None,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
        &mut params,
    ) {
        debug!("vst-out {sink_name}: stream.connect: {e}");
        return;
    }

    main_loop.run();
    debug!("vst-out thread '{sink_name}' ended");
}
