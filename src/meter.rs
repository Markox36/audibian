use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
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

/// One metering update: node key, dB left, dB right.
///
/// The key is an `Arc<str>` and not a `String` on purpose — the RT process
/// callback clones it on every send, and a `String` clone is a heap
/// allocation inside the audio thread. An `Arc` clone is a refcount bump.
pub type MeterSample = (Arc<str>, f32, f32);

/// Level floor. Anything quieter reads as silence.
const DB_FLOOR: f32 = -60.0;

/// Minimum spacing between two sends for the same meter (~25 Hz). A level
/// meter is a visual aid; sending at the PipeWire quantum rate (47-187 Hz
/// depending on buffer size) costs an IPC round trip per frame per strip and
/// buys nothing the eye can resolve. Peaks between sends are held, not lost.
const SEND_INTERVAL: Duration = Duration::from_millis(40);

/// Suppress a send when neither channel moved this much since the last one.
/// A steady tone or silence therefore costs zero events. Error stays bounded
/// by this value because the comparison is against the last *sent* level.
const DEAD_BAND_DB: f32 = 0.5;

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
    tx: async_channel::Sender<MeterSample>,
    key: Arc<str>,
    stop: Arc<AtomicBool>,
    main_loop: MainLoopRc,
    /// Highest RMS seen since the last send, so rate limiting never swallows
    /// a transient — the meter reports the loudest thing in the window.
    hold_l: f32,
    hold_r: f32,
    /// Last values actually sent, for the dead-band comparison.
    last_l: f32,
    last_r: f32,
    last_send: Instant,
}

/// Spawn a native PipeWire capture stream for metering.
/// `target_id` — PipeWire node id to connect to (deterministic; avoids
///               wireplumber falling back to the default capture device when
///               a target name lookup races node creation).
/// `event_key` — key emitted with pw-node-peaks batches
pub fn spawn_meter(
    target_id: u32,
    event_key: Arc<str>,
    tx: async_channel::Sender<MeterSample>,
) -> Option<MeterHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    let thread = std::thread::Builder::new()
        .name(format!("meter-{}", event_key))
        .spawn(move || run_meter(target_id, event_key, tx, stop_clone))
        .ok()?;

    Some(MeterHandle { stop, _thread: thread })
}

fn run_meter(
    target_id: u32,
    event_key: Arc<str>,
    tx: async_channel::Sender<MeterSample>,
    stop: Arc<AtomicBool>,
) {
    let main_loop = match MainLoopRc::new(None) {
        Ok(ml) => ml,
        Err(e) => { debug!("meter {}: MainLoop: {e}", event_key); return; }
    };
    let context = match ContextRc::new(&main_loop, None) {
        Ok(c) => c,
        Err(e) => { debug!("meter {}: Context: {e}", event_key); return; }
    };
    let core = match context.connect_rc(None) {
        Ok(c) => c,
        Err(e) => { debug!("meter {}: connect: {e}", event_key); return; }
    };

    let node_name = format!("audibian-meter-{}", event_key);
    let props = properties! {
        *pipewire::keys::MEDIA_TYPE      => "Audio",
        *pipewire::keys::MEDIA_CATEGORY  => "Capture",
        *pipewire::keys::MEDIA_ROLE      => "Music",
        // Set node + app name explicitly. Otherwise PipeWire defaults
        // node.name to the binary name ("audibian"), which produces one
        // anonymous "audibian" entry per strip in the Matrix view.
        *pipewire::keys::NODE_NAME       => node_name.as_str(),
        *pipewire::keys::APP_NAME        => "audibian-meter",
        // Crucially: NOT passive — a passive stream lets PipeWire suspend
        // its target node when nothing else holds it active. Null-sinks
        // with only matrix port-links go SUSPENDED → no buffers reach the
        // meter → dB sticks at -inf. Active capture keeps the sink running.
        "node.dont-reconnect" => "true",
    };

    let stream = match StreamBox::new(&core, &format!("audibian-meter-{}", event_key), props) {
        Ok(s) => s,
        Err(e) => { debug!("meter {}: Stream: {e}", event_key); return; }
    };

    let user_data = UserData {
        format: Default::default(),
        tx,
        key: event_key.clone(),
        stop: stop.clone(),
        main_loop: main_loop.clone(),
        hold_l: 0.0,
        hold_r: 0.0,
        // Seeded below the floor so the very first computed level always
        // clears the dead band and the bar leaves -inf immediately.
        last_l: f32::NEG_INFINITY,
        last_r: f32::NEG_INFINITY,
        last_send: Instant::now(),
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

            let channels = ud.format.channels().max(1) as usize;

            let (rms_l, rms_r) = if let Some(bytes) = d.data() {
                // Offset and size come straight from the PipeWire chunk. A
                // panic here would unwind out of an RT callback invoked from
                // C and abort the process, so bound-check instead of indexing.
                let Some(audio) = bytes.get(chunk_offset..chunk_offset + chunk_size) else { return };
                let frames = n_samples / channels;
                if frames == 0 { return; }

                // No per-sample `is_finite` branch: a NaN or Inf in the stream
                // poisons the accumulator, which is caught once after the loop.
                // That keeps the inner loop branch-free so it stays vectorisable.
                let mut sum_sq_l = 0.0_f32;
                let mut sum_sq_r = 0.0_f32;
                if channels >= 2 {
                    for frame in audio.chunks_exact(4 * channels) {
                        let v_l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                        let v_r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
                        sum_sq_l += v_l * v_l;
                        sum_sq_r += v_r * v_r;
                    }
                } else {
                    for frame in audio.chunks_exact(4) {
                        let v = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                        sum_sq_l += v * v;
                    }
                    sum_sq_r = sum_sq_l;
                }
                if !sum_sq_l.is_finite() || !sum_sq_r.is_finite() { return; }

                let f = frames as f32;
                ((sum_sq_l / f).sqrt(), (sum_sq_r / f).sqrt())
            } else {
                return;
            };

            // Hold the loudest level seen since the last send so rate limiting
            // reports peaks rather than whatever happened to land on the tick.
            ud.hold_l = ud.hold_l.max(rms_l);
            ud.hold_r = ud.hold_r.max(rms_r);

            let now = Instant::now();
            if now.duration_since(ud.last_send) < SEND_INTERVAL {
                return;
            }
            ud.last_send = now;

            let to_db = |rms: f32| if rms > 1e-9 {
                (20.0_f32 * rms.log10()).clamp(DB_FLOOR, 0.0)
            } else {
                DB_FLOOR
            };
            let db_l = to_db(ud.hold_l);
            let db_r = to_db(ud.hold_r);
            ud.hold_l = 0.0;
            ud.hold_r = 0.0;

            // Silence and steady levels cost nothing past this point.
            if (db_l - ud.last_l).abs() < DEAD_BAND_DB
                && (db_r - ud.last_r).abs() < DEAD_BAND_DB
            {
                return;
            }
            ud.last_l = db_l;
            ud.last_r = db_r;

            // NEVER block here: this runs on the PipeWire RT thread (the stream
            // is connected with RT_PROCESS). `send_blocking` on a full queue
            // would stall the audio graph and produce xruns; the previous
            // unbounded queue instead grew without limit when the UI stalled.
            // Dropping a meter frame under backpressure is invisible.
            if let Err(async_channel::TrySendError::Closed(_)) =
                ud.tx.try_send((ud.key.clone(), db_l, db_r))
            {
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
        Some(target_id),
        StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
        &mut params,
    ) {
        debug!("meter {}: stream.connect: {e}", event_key);
        return;
    }

    // The process callback only runs while buffers arrive, so a meter whose
    // sink goes suspended would never see the stop flag: its thread, stream
    // and node would leak until the app exits, and node churn recreates
    // handles constantly. A slow timer polls the flag instead.
    let timer_loop = main_loop.clone();
    let timer = main_loop.loop_().add_timer(move |_| {
        if stop.load(Ordering::Relaxed) {
            timer_loop.quit();
        }
    });
    let tick = Duration::from_millis(500);
    let _ = timer.update_timer(Some(tick), Some(tick)).into_result();

    main_loop.run();
    debug!("meter thread '{}' ended", event_key);
}
