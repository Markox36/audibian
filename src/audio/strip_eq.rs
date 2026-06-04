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

use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::process::{Child, Command};

use log::{error, info};

use super::eq::EqBand;

pub struct StripEqInstance {
    /// Sink name of the strip this EQ wraps (e.g. "audibian_music").
    pub strip_sink: String,
    /// Virtual source node name exposed by the filter-chain.
    pub eq_source_name: String,
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
        let _ = std::fs::remove_file(&self.config_path);
        info!("Strip EQ for '{}' stopped", self.strip_sink);
    }
}

/// Spawn the filter-chain for `strip_sink` with `bands`.
/// Returns an instance whose Drop tears the EQ down.
pub fn start_strip_eq(strip_sink: &str, bands: &[EqBand], sample_rate: u32) -> Option<StripEqInstance> {
    let eq_source = StripEqInstance::source_name_for(strip_sink);
    let config_path = PathBuf::from(format!("/tmp/audibian-stripeq-{strip_sink}.conf"));

    let config = build_strip_eq_config(strip_sink, &eq_source, bands, sample_rate);

    {
        let mut f = match std::fs::File::create(&config_path) {
            Ok(f) => f,
            Err(e) => { error!("strip-eq write {config_path:?}: {e}"); return None; }
        };
        if let Err(e) = f.write_all(config.as_bytes()) {
            error!("strip-eq write: {e}");
            return None;
        }
    }

    let process = match Command::new("pipewire").arg("-c").arg(&config_path).spawn() {
        Ok(p) => p,
        Err(e) => {
            error!("strip-eq spawn pipewire: {e}");
            let _ = std::fs::remove_file(&config_path);
            return None;
        }
    };

    info!("Strip EQ started for '{strip_sink}' → '{eq_source}'");
    Some(StripEqInstance {
        strip_sink: strip_sink.to_string(),
        eq_source_name: eq_source,
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
    let nodes = build_filter_nodes(bands);
    let links = build_filter_links(bands);
    let monitor = format!("{strip_sink}.monitor");

    format!(
        r#"# Audibian per-strip EQ for {strip_sink}
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
        node.description = "Audibian EQ ({eq_source})"
        media.name       = "Audibian Strip EQ"
        filter.graph = {{
            nodes = [
{nodes}
            ]
            links = [
{links}
            ]
            inputs  = [ "bq_0:In L"  "bq_0:In R" ]
            outputs = [ "bq_last:Out L" "bq_last:Out R" ]
        }}
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

fn build_filter_nodes(bands: &[EqBand]) -> String {
    let mut out = String::new();
    let mut idx = 0usize;
    for band in bands.iter() {
        if !band.enabled { continue; }
        let label = match band.filter_type {
            super::eq::FilterTypeSerial::LowShelf  => "bq_lowshelf",
            super::eq::FilterTypeSerial::HighShelf => "bq_highshelf",
            super::eq::FilterTypeSerial::LowPass   => "bq_lowpass",
            super::eq::FilterTypeSerial::HighPass  => "bq_highpass",
            super::eq::FilterTypeSerial::Notch     => "bq_notch",
            super::eq::FilterTypeSerial::Peak      => "bq_peaking",
        };
        out.push_str(&format!(
            "                {{ type = builtin  label = {label}  name = bq_{idx}\n\
                   control = {{ \"Freq\" = {freq:.1}  \"Q\" = {q:.3}  \"Gain\" = {gain:.2} }} }}\n",
            idx = idx,
            freq = band.frequency,
            q = band.q,
            gain = band.gain_db,
        ));
        idx += 1;
    }
    if idx == 0 {
        out.push_str(
            "                { type = builtin  label = bq_peaking  name = bq_0\n\
                   control = { \"Freq\" = 1000.0  \"Q\" = 1.0  \"Gain\" = 0.0 } }\n"
        );
    }
    out
}

fn build_filter_links(bands: &[EqBand]) -> String {
    let count = bands.iter().filter(|b| b.enabled).count().max(1);
    if count == 1 { return String::new(); }
    let mut out = String::new();
    for i in 0..(count - 1) {
        out.push_str(&format!(
            "                {{ output = \"bq_{i}:Out L\"  input = \"bq_{next}:In L\" }}\n\
             {indent}{{ output = \"bq_{i}:Out R\"  input = \"bq_{next}:In R\" }}\n",
            i = i,
            next = i + 1,
            indent = "                ",
        ));
    }
    out
}
