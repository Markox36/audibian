use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use log::debug;
use pipewire::{
    context::Context,
    main_loop::MainLoop,
    properties::properties,
    spa,
    stream::{Stream, StreamFlags},
};
use spa::{
    param::audio::{AudioFormat, AudioInfoRaw},
    param::format::{MediaSubtype, MediaType},
    param::format_utils,
    pod::Pod,
    utils::Direction,
};

pub struct MeterHandle {
    stop: Arc<AtomicBool>,
    _thread: std::thread::JoinHandle<()>,
}

impl Drop for MeterHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Thread's process callback sees the flag and calls main_loop.quit()
    }
}

struct UserData {
    format: AudioInfoRaw,
    tx: async_channel::Sender<(String, f32)>,
    event_key: String,
    stop: Arc<AtomicBool>,
    main_loop: MainLoop,
}

/// Spawn a native PipeWire capture stream for metering.
/// `target`    — PipeWire node name to connect to (e.g. "foo.monitor")
/// `event_key` — key emitted with pw-node-peak events
pub fn spawn_meter(
    target: String,
    event_key: String,
    tx: async_channel::Sender<(String, f32)>,
) -> Option<MeterHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    let thread = std::thread::Builder::new()
        .name(format!("meter-{}", event_key))
        .spawn(move || run_meter(target, event_key, tx, stop_clone))
        .ok()?;

    Some(MeterHandle { stop, _thread: thread })
}

fn run_meter(
    target: String,
    event_key: String,
    tx: async_channel::Sender<(String, f32)>,
    stop: Arc<AtomicBool>,
) {
    let main_loop = match MainLoop::new(None) {
        Ok(ml) => ml,
        Err(e) => { debug!("meter {}: MainLoop: {e}", event_key); return; }
    };
    let context = match Context::new(&main_loop) {
        Ok(c) => c,
        Err(e) => { debug!("meter {}: Context: {e}", event_key); return; }
    };
    let core = match context.connect(None) {
        Ok(c) => c,
        Err(e) => { debug!("meter {}: connect: {e}", event_key); return; }
    };

    let props = properties! {
        *pipewire::keys::MEDIA_TYPE      => "Audio",
        *pipewire::keys::MEDIA_CATEGORY  => "Capture",
        *pipewire::keys::MEDIA_ROLE      => "Music",
        *pipewire::keys::TARGET_OBJECT   => target.as_str(),
    };

    let stream = match Stream::new(&core, &format!("audibian-meter-{}", event_key), props) {
        Ok(s) => s,
        Err(e) => { debug!("meter {}: Stream: {e}", event_key); return; }
    };

    let user_data = UserData {
        format: Default::default(),
        tx,
        event_key: event_key.clone(),
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

            let d = &mut datas[0];
            let chunk_size  = d.chunk().size()   as usize;
            let chunk_offset = d.chunk().offset() as usize;
            if chunk_size == 0 { return; }

            let n_samples = chunk_size / 4; // f32 = 4 bytes
            if n_samples == 0 { return; }

            let rms = if let Some(bytes) = d.data() {
                let audio = &bytes[chunk_offset..chunk_offset + chunk_size];
                let sum_sq: f32 = audio.chunks_exact(4)
                    .map(|b| {
                        let v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                        if v.is_finite() { v * v } else { 0.0 }
                    })
                    .sum();
                (sum_sq / n_samples as f32).sqrt()
            } else {
                return;
            };

            let db = if rms > 1e-9 {
                (20.0_f32 * rms.log10()).clamp(-60.0, 0.0)
            } else {
                -60.0
            };

            if ud.tx.send_blocking((ud.event_key.clone(), db)).is_err() {
                ud.main_loop.quit();
            }
        })
        .register();

    let _listener = match _listener {
        Ok(l) => l,
        Err(e) => { debug!("meter {}: register listener: {e}", event_key); return; }
    };

    // Build format parameters: accept F32LE at any rate/channel count
    let mut audio_info = AudioInfoRaw::new();
    audio_info.set_format(AudioFormat::F32LE);

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
        Direction::Input,
        None,
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
        &mut params,
    ) {
        debug!("meter {}: stream.connect: {e}", event_key);
        return;
    }

    main_loop.run();
    debug!("meter thread '{}' ended", event_key);
}
