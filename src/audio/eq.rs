//! Parametric EQ bands and the PipeWire `filter.graph` they compile to.
//!
//! Audibian does not filter audio itself: the bands are handed to PipeWire's
//! `module-filter-chain`, which runs the builtin biquads, and the frontend
//! draws the response curve. The biquad math that used to live here had no
//! remaining caller and was deleted.

/// One parametric EQ band.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct EqBand {
    pub filter_type: FilterTypeSerial,
    /// Center/corner frequency in Hz
    pub frequency: f64,
    /// Gain in dB (only used for Peak/Shelf types)
    pub gain_db: f64,
    /// Q factor (bandwidth)
    pub q: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum FilterTypeSerial {
    LowShelf,
    HighShelf,
    Peak,
    LowPass,
    HighPass,
    Notch,
}

impl Default for EqBand {
    fn default() -> Self {
        Self {
            filter_type: FilterTypeSerial::Peak,
            frequency: 1000.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: true,
        }
    }
}

/// Builtin `module-filter-chain` label for a band type.
fn builtin_label(t: FilterTypeSerial) -> &'static str {
    match t {
        FilterTypeSerial::LowShelf => "bq_lowshelf",
        FilterTypeSerial::HighShelf => "bq_highshelf",
        FilterTypeSerial::LowPass => "bq_lowpass",
        FilterTypeSerial::HighPass => "bq_highpass",
        FilterTypeSerial::Notch => "bq_notch",
        FilterTypeSerial::Peak => "bq_peaking",
    }
}

/// Render the `filter.graph` block of a PipeWire `module-filter-chain`.
///
/// The builtin `bq_*` filters are **mono**: their ports are `In` and `Out`,
/// not `In L`/`In R`. A stereo chain therefore needs two nodes per band
/// (`bq_<i>L` / `bq_<i>R`) wired in series per channel, with the graph's
/// inputs on the first pair and its outputs on the last one. Disabled bands
/// are skipped; with none left a flat peaking filter keeps the chain valid.
pub fn build_graph_block(bands: &[EqBand]) -> String {
    let flat = EqBand::default();
    let chain: Vec<&EqBand> = match bands.iter().filter(|b| b.enabled).collect::<Vec<_>>() {
        v if v.is_empty() => vec![&flat],
        v => v,
    };

    let mut nodes = String::new();
    for (i, band) in chain.iter().enumerate() {
        let label = builtin_label(band.filter_type);
        for side in ['L', 'R'] {
            nodes.push_str(&format!(
                "                {{ type = builtin  label = {label}  name = bq_{i}{side}\n\
                 \x20                 control = {{ \"Freq\" = {freq:.1}  \"Q\" = {q:.3}  \"Gain\" = {gain:.2} }} }}\n",
                freq = band.frequency,
                q = band.q,
                gain = band.gain_db,
            ));
        }
    }

    let mut links = String::new();
    for i in 0..chain.len().saturating_sub(1) {
        let next = i + 1;
        for side in ['L', 'R'] {
            links.push_str(&format!(
                "                {{ output = \"bq_{i}{side}:Out\"  input = \"bq_{next}{side}:In\" }}\n"
            ));
        }
    }

    let last = chain.len() - 1;
    format!(
        "        filter.graph = {{\n\
         \x20           nodes = [\n{nodes}            ]\n\
         \x20           links = [\n{links}            ]\n\
         \x20           inputs  = [ \"bq_0L:In\" \"bq_0R:In\" ]\n\
         \x20           outputs = [ \"bq_{last}L:Out\" \"bq_{last}R:Out\" ]\n\
         \x20       }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The builtin biquads are mono: a stereo chain must address `bq_<i>L:In`
    /// / `:Out`, never `In L`. A wrong port name makes PipeWire refuse the
    /// whole graph, which silently disabled the EQ for every strip.
    #[test]
    fn graph_block_chains_mono_biquads_per_channel() {
        let bands = vec![
            EqBand { filter_type: FilterTypeSerial::LowShelf, ..EqBand::default() },
            EqBand { filter_type: FilterTypeSerial::Notch, ..EqBand::default() },
            EqBand { enabled: false, ..EqBand::default() },
        ];
        let block = build_graph_block(&bands);

        assert!(block.contains("label = bq_lowshelf  name = bq_0L"), "{block}");
        assert!(block.contains("label = bq_notch  name = bq_1R"), "{block}");
        assert!(!block.contains("bq_2"), "disabled band must be skipped: {block}");
        assert!(block.contains(r#"{ output = "bq_0L:Out"  input = "bq_1L:In" }"#), "{block}");
        assert!(block.contains(r#"inputs  = [ "bq_0L:In" "bq_0R:In" ]"#), "{block}");
        assert!(block.contains(r#"outputs = [ "bq_1L:Out" "bq_1R:Out" ]"#), "{block}");
        assert!(!block.contains("In L"), "mono ports only: {block}");
    }

    /// With every band off the chain still needs one node, or the filter-chain
    /// module fails to load and the strip loses audio entirely.
    #[test]
    fn graph_block_falls_back_to_one_flat_band() {
        let block = build_graph_block(&[EqBand { enabled: false, ..EqBand::default() }]);
        assert!(block.contains("name = bq_0L"), "{block}");
        assert!(block.contains(r#"outputs = [ "bq_0L:Out" "bq_0R:Out" ]"#), "{block}");
    }
}
