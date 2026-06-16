use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::audio::{AudioGraph, PwThread};
use crate::audio::effects::{EqInstance, NsInstance};
use crate::audio::strip_eq::StripEqInstance;
use crate::profiles::ProfileStore;
use crate::mixer::MixerConfig;
use crate::matrix_config::MatrixConfig;
use crate::soundboard::SoundboardConfig;

pub struct AppState {
    pub graph: Arc<Mutex<AudioGraph>>,
    pub pw: Arc<PwThread>,
    pub profile_store: Arc<Mutex<ProfileStore>>,
    pub eq_instance: Arc<Mutex<Option<EqInstance>>>,
    pub ns_instances: Arc<Mutex<HashMap<String, NsInstance>>>,
    pub mixer_config: Arc<Mutex<MixerConfig>>,
    pub matrix_config: Arc<Mutex<MatrixConfig>>,
    /// pactl module IDs per return channel (null-sink + remap-source).
    pub mixer_module_ids: Arc<Mutex<HashMap<u32, Vec<u32>>>>,
    /// pactl module IDs per input channel (null-sink).
    pub input_module_ids: Arc<Mutex<HashMap<u32, Vec<u32>>>>,
    /// pactl module-loopback IDs per active send (input_id, return_id).
    pub send_module_ids: Arc<Mutex<HashMap<(u32, u32), u32>>>,
    /// pactl module-loopback IDs for source → input channel (mic feed).
    pub input_source_ids: Arc<Mutex<HashMap<u32, u32>>>,
    /// `audibian_master` null-sink module id (created on set_master_sink).
    pub master_null_module: Arc<Mutex<Option<u32>>>,
    /// Loopback module id: audibian_master.monitor → hardware sink.
    pub master_loopback_module: Arc<Mutex<Option<u32>>>,
    /// Runtime-only soloed strip keys (format: "in:<id>" / "ret:<id>").
    /// When non-empty, every other strip is force-muted; cleared on app exit.
    pub solo_set: Arc<Mutex<HashSet<String>>>,
    /// Active per-strip EQ filter-chain processes. Key = strip_key.
    pub strip_eq_instances: Arc<Mutex<HashMap<String, StripEqInstance>>>,
    pub meter_handles: Arc<Mutex<HashMap<String, crate::meter::MeterHandle>>>,
    pub meter_tx: async_channel::Sender<(String, f32)>,
    pub meter_rx: async_channel::Receiver<(String, f32)>,
    /// Soundboard: persisted list of uploaded sounds.
    pub soundboard_config: Arc<Mutex<SoundboardConfig>>,
    /// Currently playing `paplay` children, one per Play click. Reaped on
    /// next Play and on Stop-all. Drop kills survivors at process exit.
    pub soundboard_procs: Arc<Mutex<Vec<std::process::Child>>>,
}
