/// PipeWire filter-chain EQ management.
///
/// Creates a virtual sink with a parametric EQ applied by spawning a
/// `pipewire` process with a filter-chain configuration.  The virtual sink
/// is named `audibian-eq-<target_sink>`.
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use log::{error, info, warn};

use super::eq::EqBand;

/// Modules every helper `pipewire -c <conf>` process needs before it can do
/// anything: `protocol-native` to reach the daemon at all, `client-node` +
/// `adapter` because filter-chain and echo-cancel build their streams
/// through the adapter factory. `pipewire -c` replaces the whole config, so
/// omitting them makes the mandatory module fail and the process exit at
/// once — which is exactly what used to happen to every EQ and NS instance.
pub const PW_CLIENT_MODULES: &str = r#"    { name = libpipewire-module-rt
      args = { nice.level = -11 }
      flags = [ ifexists nofail ]
    }
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }"#;

/// Path for a generated helper config. `$XDG_RUNTIME_DIR` is per-user and
/// 0700, so a predictable name there cannot be pre-planted as a symlink by
/// another user the way `/tmp/audibian-eq-<sink>.conf` could.
pub fn runtime_conf_path(file_name: &str) -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.join(file_name)
}

/// Write `config` and start `pipewire -c` on it, returning the child only if
/// it is still alive shortly after. A bad graph (unknown port, dangling node)
/// makes PipeWire exit immediately with the reason on stderr; without this
/// check the caller would report success and the UI would show an effect
/// that never existed.
pub fn write_and_spawn(config_path: &Path, config: &str, what: &str) -> Option<Child> {
    {
        let mut f = match std::fs::File::create(config_path) {
            Ok(f) => f,
            Err(e) => {
                error!("Cannot write {what} config to {config_path:?}: {e}");
                return None;
            }
        };
        if let Err(e) = f.write_all(config.as_bytes()) {
            error!("Cannot write {what} config: {e}");
            return None;
        }
    }

    let mut child = match Command::new("pipewire").arg("-c").arg(config_path).spawn() {
        Ok(p) => p,
        Err(e) => {
            error!("Failed to spawn pipewire for {what}: {e}");
            let _ = std::fs::remove_file(config_path);
            return None;
        }
    };

    // Module loading happens during startup, so a config error shows up
    // within a few hundred milliseconds or not at all.
    std::thread::sleep(std::time::Duration::from_millis(300));
    match child.try_wait() {
        Ok(Some(status)) => {
            error!("pipewire exited immediately for {what} ({status}); config kept at {config_path:?}");
            None
        }
        _ => Some(child),
    }
}

/// Handle to a running filter-chain EQ process.
pub struct EqInstance {
    pub target_sink: String,
    #[allow(dead_code)]
    pub virtual_sink_name: String,
    config_path: PathBuf,
    process: Child,
}

impl EqInstance {
    pub fn virtual_sink_name(target_sink: &str) -> String {
        format!("audibian-eq-{target_sink}")
    }
}

impl Drop for EqInstance {
    fn drop(&mut self) {
        let _ = self.process.kill();
        // `kill` only signals. Without the wait the filter-chain child stays
        // defunct for the rest of the session. SIGKILL, so this returns at once.
        let _ = self.process.wait();
        let _ = std::fs::remove_file(&self.config_path);
        info!(
            "EQ instance for '{}' stopped",
            self.target_sink
        );
    }
}

/// Spawn a filter-chain EQ for `target_sink` with the given bands.
/// Returns an `EqInstance` that must be kept alive for the EQ to stay active.
pub fn start_eq(target_sink: &str, bands: &[EqBand], sample_rate: u32) -> Option<EqInstance> {
    let virtual_name = EqInstance::virtual_sink_name(target_sink);
    let config_path = runtime_conf_path(&format!("audibian-eq-{target_sink}.conf"));
    let config = build_filter_chain_config(target_sink, &virtual_name, bands, sample_rate);
    let process = write_and_spawn(&config_path, &config, "EQ")?;

    info!("EQ started for sink '{target_sink}' → virtual '{virtual_name}'");

    Some(EqInstance {
        target_sink: target_sink.to_string(),
        virtual_sink_name: virtual_name,
        config_path,
        process,
    })
}

/// Remove helper configs left behind by a previous run (a crash, or a kill
/// that skipped `Drop`). Called once at startup, before any new instance
/// writes its own config.
pub fn cleanup_orphaned_eq_sinks() {
    let dir = runtime_conf_path("");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("audibian-eq-")
            || name.starts_with("audibian-ns-")
            || name.starts_with("audibian-stripeq-"))
            && name.ends_with(".conf")
        {
            let _ = std::fs::remove_file(entry.path());
            warn!("Removed orphaned filter-chain config: {name}");
        }
    }
}

// ---------------------------------------------------------------------------
// Noise Suppression
// ---------------------------------------------------------------------------

/// Handle to a running noise-suppression filter-chain process.
pub struct NsInstance {
    pub source_name: String,
    #[allow(dead_code)]
    pub virtual_source_name: String,
    config_path: PathBuf,
    process: Child,
}

impl NsInstance {
    pub fn virtual_source_name(source_name: &str) -> String {
        format!("audibian-ns-{source_name}")
    }
}

impl Drop for NsInstance {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = std::fs::remove_file(&self.config_path);
        info!("Noise suppression for '{}' stopped", self.source_name);
    }
}

/// Spawn a WebRTC noise suppressor for `source_name` via
/// `libpipewire-module-echo-cancel` with the WebRTC AEC backend.
///
/// Creates a virtual `Audio/Source` named `audibian-ns-{source_name}` that
/// applications can use instead of the real microphone to receive denoised audio.
/// An accompanying reference sink (`audibian-ns-{source_name}-ref`) is also created
/// by the echo-cancel module but can be ignored for pure noise suppression.
pub fn start_noise_suppression(source_name: &str) -> Option<NsInstance> {
    let virtual_name = NsInstance::virtual_source_name(source_name);
    // Sanitise the name for use in a file path
    let safe_name = source_name.replace(['/', ' ', ':'], "_");
    let config_path = runtime_conf_path(&format!("audibian-ns-{safe_name}.conf"));
    let config = build_ns_config(source_name, &virtual_name);
    let process = write_and_spawn(&config_path, &config, "noise suppression")?;
    info!(
        "Noise suppression started for '{}' → virtual '{}'",
        source_name, virtual_name
    );

    Some(NsInstance {
        source_name: source_name.to_string(),
        virtual_source_name: virtual_name,
        config_path,
        process,
    })
}

fn build_ns_config(source_name: &str, virtual_name: &str) -> String {
    let ref_sink_name = format!("{virtual_name}-ref");
    format!(
        r#"# Audibian Noise Suppression (WebRTC) for {source_name}
context.properties = {{
    log.level = 0
}}

context.modules = [
{PW_CLIENT_MODULES}
    {{ name = libpipewire-module-echo-cancel
      args = {{
        library = aec/libspa-aec-webrtc
        aec.args = {{
            webrtc.noise_suppression     = true
            webrtc.gain_control          = false
            webrtc.voice_detection       = false
            webrtc.transient_suppression = true
            webrtc.high_pass_filter      = true
        }}
        capture.props = {{
            node.name   = "{virtual_name}-capture"
            node.target = "{source_name}"
        }}
        source.props = {{
            node.name        = "{virtual_name}"
            node.description = "Audibian NS ({source_name})"
            media.class      = "Audio/Source"
        }}
        sink.props = {{
            node.name        = "{ref_sink_name}"
            node.description = "Audibian NS Ref ({source_name})"
            media.class      = "Audio/Sink"
        }}
        playback.props = {{
            node.name = "{virtual_name}-playback"
        }}
      }}
    }}
]
"#
    )
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

fn build_filter_chain_config(
    target_sink: &str,
    virtual_name: &str,
    bands: &[EqBand],
    sample_rate: u32,
) -> String {
    let graph = super::eq::build_graph_block(bands);

    format!(
        r#"# Audibian EQ filter-chain for {target_sink}
context.properties = {{
    log.level = 0
}}

context.modules = [
{PW_CLIENT_MODULES}
    {{ name = libpipewire-module-filter-chain
      args = {{
        node.description = "Audibian EQ ({virtual_name})"
        media.name       = "Audibian EQ"
{graph}
        capture.props = {{
            node.name      = "{virtual_name}"
            media.class    = "Audio/Sink"
            audio.rate     = {sample_rate}
            audio.channels = 2
            audio.position = [ FL FR ]
        }}
        playback.props = {{
            node.name   = "{virtual_name}-playback"
            audio.rate  = {sample_rate}
            node.target = "{target_sink}"
        }}
      }}
    }}
]
"#
    )
}
