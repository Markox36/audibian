/// Parametric EQ biquad coefficient calculator.
///
/// Uses the Audio EQ Cookbook formulas by Robert Bristow-Johnson.
/// All filters are second-order IIR (biquad) sections.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FilterType {
    LowShelf,
    HighShelf,
    Peak,
    LowPass,
    HighPass,
    Notch,
}

/// Biquad filter coefficients: H(z) = (b0 + b1*z^-1 + b2*z^-2) / (a0 + a1*z^-1 + a2*z^-2)
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a0: f64,
    pub a1: f64,
    pub a2: f64,
}

impl BiquadCoeffs {
    /// Normalised coefficients (divide all by a0)
    pub fn normalised(&self) -> [f64; 5] {
        let a0 = self.a0;
        [
            self.b0 / a0,
            self.b1 / a0,
            self.b2 / a0,
            self.a1 / a0,
            self.a2 / a0,
        ]
    }

    /// Evaluate magnitude response at frequency `f` Hz given sample rate `fs`.
    pub fn magnitude_db(&self, f: f64, fs: f64) -> f64 {
        use std::f64::consts::PI;
        let w = 2.0 * PI * f / fs;
        let [b0, b1, b2, a1, a2] = self.normalised();

        // H(e^jw) numerically
        let num_re = b0 + b1 * w.cos() + b2 * (2.0 * w).cos();
        let num_im = -b1 * w.sin() - b2 * (2.0 * w).sin();
        let den_re = 1.0 + a1 * w.cos() + a2 * (2.0 * w).cos();
        let den_im = -a1 * w.sin() - a2 * (2.0 * w).sin();

        let num_mag2 = num_re * num_re + num_im * num_im;
        let den_mag2 = den_re * den_re + den_im * den_im;

        if den_mag2 < 1e-30 {
            return 0.0;
        }
        10.0 * (num_mag2 / den_mag2).log10()
    }
}

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

/// Serialisable mirror of FilterType (no Copy derive on enums with methods in older Rust).
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum FilterTypeSerial {
    LowShelf,
    HighShelf,
    Peak,
    LowPass,
    HighPass,
    Notch,
}

impl From<FilterTypeSerial> for FilterType {
    fn from(s: FilterTypeSerial) -> Self {
        match s {
            FilterTypeSerial::LowShelf => FilterType::LowShelf,
            FilterTypeSerial::HighShelf => FilterType::HighShelf,
            FilterTypeSerial::Peak => FilterType::Peak,
            FilterTypeSerial::LowPass => FilterType::LowPass,
            FilterTypeSerial::HighPass => FilterType::HighPass,
            FilterTypeSerial::Notch => FilterType::Notch,
        }
    }
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

/// Compute biquad coefficients for a single EQ band.
pub fn compute_coeffs(band: &EqBand, fs: f64) -> BiquadCoeffs {
    use std::f64::consts::PI;

    let f0 = band.frequency.clamp(20.0, fs / 2.0 - 1.0);
    let q = band.q.max(0.1);
    let gain_db = band.gain_db.clamp(-24.0, 24.0);

    let w0 = 2.0 * PI * f0 / fs;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = sin_w0 / (2.0 * q);
    let a = 10f64.powf(gain_db / 40.0); // sqrt of linear gain

    match band.filter_type.into() {
        FilterType::Peak => BiquadCoeffs {
            b0: 1.0 + alpha * a,
            b1: -2.0 * cos_w0,
            b2: 1.0 - alpha * a,
            a0: 1.0 + alpha / a,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha / a,
        },

        FilterType::LowShelf => {
            let sqrt_a = a.sqrt();
            BiquadCoeffs {
                b0: a * ((a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
                b1: 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                b2: a * ((a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
                a0: (a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
                a1: -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                a2: (a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
            }
        }

        FilterType::HighShelf => {
            let sqrt_a = a.sqrt();
            BiquadCoeffs {
                b0: a * ((a + 1.0) + (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha),
                b1: -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                b2: a * ((a + 1.0) + (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha),
                a0: (a + 1.0) - (a - 1.0) * cos_w0 + 2.0 * sqrt_a * alpha,
                a1: 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                a2: (a + 1.0) - (a - 1.0) * cos_w0 - 2.0 * sqrt_a * alpha,
            }
        }

        FilterType::LowPass => BiquadCoeffs {
            b0: (1.0 - cos_w0) / 2.0,
            b1: 1.0 - cos_w0,
            b2: (1.0 - cos_w0) / 2.0,
            a0: 1.0 + alpha,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha,
        },

        FilterType::HighPass => BiquadCoeffs {
            b0: (1.0 + cos_w0) / 2.0,
            b1: -(1.0 + cos_w0),
            b2: (1.0 + cos_w0) / 2.0,
            a0: 1.0 + alpha,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha,
        },

        FilterType::Notch => BiquadCoeffs {
            b0: 1.0,
            b1: -2.0 * cos_w0,
            b2: 1.0,
            a0: 1.0 + alpha,
            a1: -2.0 * cos_w0,
            a2: 1.0 - alpha,
        },
    }
}

/// Compute the composite magnitude response of multiple bands at a given frequency.
pub fn combined_magnitude_db(bands: &[EqBand], f: f64, fs: f64) -> f64 {
    bands
        .iter()
        .filter(|b| b.enabled)
        .map(|b| compute_coeffs(b, fs).magnitude_db(f, fs))
        .sum()
}

/// Default 5-band parametric EQ preset.
pub fn default_bands() -> Vec<EqBand> {
    vec![
        EqBand {
            filter_type: FilterTypeSerial::LowShelf,
            frequency: 80.0,
            gain_db: 0.0,
            q: 0.707,
            enabled: true,
        },
        EqBand {
            filter_type: FilterTypeSerial::Peak,
            frequency: 250.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: true,
        },
        EqBand {
            filter_type: FilterTypeSerial::Peak,
            frequency: 1000.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: true,
        },
        EqBand {
            filter_type: FilterTypeSerial::Peak,
            frequency: 4000.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: true,
        },
        EqBand {
            filter_type: FilterTypeSerial::HighShelf,
            frequency: 12000.0,
            gain_db: 0.0,
            q: 0.707,
            enabled: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_at_flat_gain_is_zero_db() {
        let band = EqBand {
            filter_type: FilterTypeSerial::Peak,
            frequency: 1000.0,
            gain_db: 0.0,
            q: 1.0,
            enabled: true,
        };
        let db = compute_coeffs(&band, 48000.0).magnitude_db(1000.0, 48000.0);
        assert!(db.abs() < 0.01, "Expected ~0 dB, got {db}");
    }

    #[test]
    fn peak_at_center_frequency_matches_gain() {
        let band = EqBand {
            filter_type: FilterTypeSerial::Peak,
            frequency: 1000.0,
            gain_db: 6.0,
            q: 1.0,
            enabled: true,
        };
        let db = compute_coeffs(&band, 48000.0).magnitude_db(1000.0, 48000.0);
        assert!((db - 6.0).abs() < 0.1, "Expected ~6 dB, got {db}");
    }
}
