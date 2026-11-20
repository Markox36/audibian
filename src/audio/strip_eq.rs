//! Per-strip parametric EQ via PipeWire module-filter-chain.
//!
//! Each strip's null-sink keeps existing — apps still target it. When EQ is
//! enabled for a strip, a `module-filter-chain` is spawned that:
//!   - taps the strip's monitor as its capture
//!   - runs the configured biquad chain
//!   - exposes a virtual Audio/Source named `<sink>_eq`
//!
//! Downstream loopbacks (input → master, send → return, return → master) are
//! re-targeted to source from `<sink>_eq` instead of `<sink>.monitor`.

use std::path::PathBuf;
use std::process::Child;

use log::info;

use super::effects::{runtime_conf_path, write_and_spawn, PW_CLIENT_MODULES};
use super::eq::EqBand;

pub struct StripEqInstance {
    /// Sink name of the strip this EQ wraps (e.g. "audibian_music").
    pub strip_sink: String,
    config_path: PathBuf,
    process: Child,
}

impl StripEqInstance {
    pub fn source_name_for(strip_sink: &str) -> String {
        format!("{strip_sink}_eq")
    }
}

impl Drop for StripEqInstance {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = std::fs::remove_file(&self.config_path);
        info!("Strip EQ for '{}' stopped", self.strip_sink);
    }
}

/// Spawn the filter-chain for `strip_sink` with `bands`.
/// Returns an instance whose Drop tears the EQ down.
pub fn start_strip_eq(strip_sink: &str, bands: &[EqBand], sample_rate: u32) -> Option<StripEqInstance> {
    let eq_source = StripEqInstance::source_name_for(strip_sink);
    let config_path = runtime_conf_path(&format!("audibian-stripeq-{strip_sink}.conf"));
    let config = build_strip_eq_config(strip_sink, &eq_source, bands, sample_rate);
    let process = write_and_spawn(&config_path, &config, "strip EQ")?;

    info!("Strip EQ started for '{strip_sink}' → '{eq_source}'");
    Some(StripEqInstance {
        strip_sink: strip_sink.to_string(),
        config_path,
        process,
    })
}

fn build_strip_eq_config(
    strip_sink: &str,
    eq_source: &str,
    bands: &[EqBand],
    sample_rate: u32,
) -> String {
    let graph = super::eq::build_graph_block(bands);
    let monitor = format!("{strip_sink}.monitor");

    format!(
        r#"# Audibian per-strip EQ for {strip_sink}
context.properties = {{
    log.level = 0
}}

context.modules = [
{PW_CLIENT_MODULES}
    {{ name = libpipewire-module-filter-chain
      args = {{
        node.description = "Audibian EQ ({eq_source})"
        media.name       = "Audibian Strip EQ"
{graph}
        capture.props = {{
            node.name       = "{eq_source}.capture"
            node.target     = "{monitor}"
            audio.rate      = {sample_rate}
            audio.channels  = 2
            audio.position  = [ FL FR ]
        }}
        playback.props = {{
            node.name       = "{eq_source}"
            media.class     = "Audio/Source"
            audio.rate      = {sample_rate}
            audio.channels  = 2
            audio.position  = [ FL FR ]
        }}
      }}
    }}
]
"#
    )
}

