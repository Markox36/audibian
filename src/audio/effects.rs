/// PipeWire filter-chain EQ management.
///
/// Creates a virtual sink with a parametric EQ applied by spawning a
/// `pipewire` process with a filter-chain configuration.  The virtual sink
/// is named `audibian-eq-<target_sink>`.
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::process::{Child, Command};

use log::{error, info, warn};

use super::eq::EqBand;

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
    let config_path = PathBuf::from(format!("/tmp/audibian-eq-{target_sink}.conf"));

    let config = build_filter_chain_config(target_sink, &virtual_name, bands, sample_rate);

    {
        let mut f = match std::fs::File::create(&config_path) {
            Ok(f) => f,
            Err(e) => {
                error!("Cannot write EQ config to {config_path:?}: {e}");
                return None;
            }
        };
        if let Err(e) = f.write_all(config.as_bytes()) {
            error!("Cannot write EQ config: {e}");
            return None;
        }
    }

    let process = match Command::new("pipewire")
        .arg("-c")
        .arg(&config_path)
        .spawn()
    {
        Ok(p) => p,
        Err(e) => {
            error!("Failed to spawn pipewire filter-chain: {e}");
            let _ = std::fs::remove_file(&config_path);
            return None;
        }
    };

    info!("EQ started for sink '{target_sink}' → virtual '{virtual_name}'");

    Some(EqInstance {
        target_sink: target_sink.to_string(),
        virtual_sink_name: virtual_name,
        config_path,
        process,
    })
}

/// Kill any orphaned audibian filter-chain configs on startup.
pub fn cleanup_orphaned_eq_sinks() {
    let dir = match std::fs::read_dir("/tmp") {
        Ok(d) => d,
        Err(_) => return,
    };

    for entry in dir.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("audibian-eq-") || name.starts_with("audibian-ns-"))
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
    let config_path = PathBuf::from(format!("/tmp/audibian-ns-{safe_name}.conf"));

    let config = build_ns_config(source_name, &virtual_name);

    {
        let mut f = match std::fs::File::create(&config_path) {
            Ok(f) => f,
            Err(e) => {
                error!("Cannot write NS config to {config_path:?}: {e}");
                return None;
            }
        };
        if let Err(e) = f.write_all(config.as_bytes()) {
            error!("Cannot write NS config: {e}");
            return None;
        }
    }

    let process = match Command::new("pipewire")
        .arg("-c")
        .arg(&config_path)
        .spawn()
    {
        Ok(p) => p,
        Err(e) => {
            error!("Failed to spawn pipewire filter-chain for NS: {e}");
            let _ = std::fs::remove_file(&config_path);
            return None;
        }
    };

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
    {{ name = libpipewire-module-rt
      args = {{ nice.level = -11 }}
      flags = [ ifexists nofail ]
    }}
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
    let filter_nodes = build_filter_nodes(bands, sample_rate);
    let filter_links = build_filter_links(bands);

    format!(
        r#"# Audibian EQ filter-chain for {target_sink}
context.properties = {{
    log.level = 0
}}

context.modules = [
    {{ name = libpipewire-module-rt
      args = {{ nice.level = -11 }}
      flags = [ ifexists nofail ]
    }}
    {{ name = libpipewire-module-filter-chain
      args = {{
        node.description = "Audibian EQ ({virtual_name})"
        media.name       = "Audibian EQ"
        filter.graph = {{
            nodes = [
{filter_nodes}
            ]
            links = [
{filter_links}
            ]
            inputs  = [ "bq_0:In L" "bq_0:In R" ]
            outputs = [ "bq_last:Out L" "bq_last:Out R" ]
        }}
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

fn build_filter_nodes(bands: &[EqBand], _sample_rate: u32) -> String {
    #[allow(unused_imports)]
    use super::eq::compute_coeffs;

    let mut out = String::new();
    let mut idx = 0usize;

    for (_i, band) in bands.iter().enumerate() {
        if !band.enabled {
            continue;
        }
        let _coeffs = compute_coeffs(band, 48000.0); // kept for future native filter config

        out.push_str(&format!(
            r#"                {{ type = builtin  label = bq_peaking  name = bq_{idx}
                  control = {{ "Freq" = {freq:.1}  "Q" = {q:.3}  "Gain" = {gain:.2} }} }}
"#,
            idx = idx,
            freq = band.frequency,
            q = band.q,
            gain = band.gain_db,
        ));
        idx += 1;
    }

    // If no bands enabled, insert a passthrough (gain = 0 dB peak)
    if idx == 0 {
        out.push_str(
            r#"                { type = builtin  label = bq_peaking  name = bq_0
                  control = { "Freq" = 1000.0  "Q" = 1.0  "Gain" = 0.0 } }
"#,
        );
    }

    out
}

fn build_filter_links(bands: &[EqBand]) -> String {
    let count = bands.iter().filter(|b| b.enabled).count().max(1);
    if count == 1 {
        return String::new(); // single node, no links needed
    }

    let mut out = String::new();
    for i in 0..(count - 1) {
        out.push_str(&format!(
            r#"                {{ output = "bq_{i}:Out L"  input = "bq_{next}:In L" }}
                {{ output = "bq_{i}:Out R"  input = "bq_{next}:In R" }}
"#,
            i = i,
            next = i + 1,
        ));
    }
    out
}
