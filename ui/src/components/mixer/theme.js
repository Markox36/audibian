// Shared tokens and pure helpers for the mixer.
//
// Colours also live in tailwind.config.js as the `mix-*` palette. These
// constants exist for the cases Tailwind cannot express: values interpolated
// into inline styles (meter fills, per-strip accents, canvas strokes).

// Contrast note: the previous values sat between #0a0a0a and 2-6% white
// overlays, so strips, cells and panel background were within a few percent
// luminance of each other and the controls read as one dark mass. Panel and
// strip are now separated by a visible step, and borders sit at an opacity
// that actually draws an edge.
export const CREAM     = '#eceade'
export const GREEN     = '#45d99a'
export const GREEN_DIM = 'rgba(69, 217, 154, 0.35)'
export const RED       = '#ff6b6e'
export const PANEL_BG  = '#101013'
export const STRIP_BG  = 'rgba(255, 255, 255, 0.055)'
export const RAIL_TEXT = 'rgba(255, 255, 255, 0.58)'
export const FAINT     = 'rgba(255, 255, 255, 0.14)'

// Subgrid rows: Input | Sends | Output | Pan | Volume | Meter | Exclude
//
// The meter row is clamped rather than a bare `1fr`. As `1fr` it absorbed
// every spare pixel, so on a maximized window it grew to ~650px of empty
// meter and made the mixer look oversized. Clamped, it still expands on tall
// windows and shrinks on short ones, but only between sane bounds.
export const ROW_HEIGHTS = {
  input:   '30px',
  sends:   '64px',
  output:  '30px',
  pan:     '46px',
  volume:  '26px',
  meter:   'minmax(150px, 1fr)',
  exclude: '40px',
}

// Height of everything except the meter, gaps and padding included. The grid
// container caps itself at ROWS_FIXED + METER_MAX so the meter can take the
// slack on short windows without ballooning on tall ones — as a bare `1fr` it
// grew to ~650px of empty meter on a maximized window.
export const ROWS_FIXED = 236 + 24 + 28
export const METER_MAX = 560
export const GRID_MAX_HEIGHT = `${ROWS_FIXED + METER_MAX}px`

export const GRID_TEMPLATE = [
  ROW_HEIGHTS.input,
  ROW_HEIGHTS.sends,
  ROW_HEIGHTS.output,
  ROW_HEIGHTS.pan,
  ROW_HEIGHTS.volume,
  ROW_HEIGHTS.meter,
  ROW_HEIGHTS.exclude,
].join(' ')

// Strips track the window width but stop at both ends, the way the Discord
// desktop app compacts down to a floor and then refuses to shrink further.
// Below the floor the grid scrolls horizontally instead of crushing the
// controls — 92px is the width at which mute, solo and remove still fit.
export const STRIP_WIDTH = 'clamp(92px, 7.5vw, 132px)'
export const RAIL_WIDTH  = 'clamp(58px, 5vw, 78px)'

export const DB_TICKS = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]

// PipeWire null-sinks report HARDWARE|DECIBEL_VOLUME and apply a cubic
// (not linear) volume law: requesting `pactl set-sink-volume N%` yields a
// real amplitude gain of (N/100)^3, i.e. dB = 60*log10(N/100). Verified
// empirically against a probe null-sink (50% → -18.06dB, 150% → +10.57dB,
// 300% → +28.63dB — all match this formula, not the naive 20*log10(N/100)
// this used to compute). Getting this right matters: it's the only readout
// telling the user how much gain a strip (e.g. a quiet VST instrument on a
// MIDI channel) is actually getting.
export function faderToDb(val) {
  const v = parseFloat(val)
  if (v <= 0) return '-inf'
  if (v === 100) return '0.0'
  const db = 60 * Math.log10(v / 100)
  return db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1)
}

export const DESIGNER_COLORS = [
  '#3ecf8e', '#4169e1', '#b26645', '#7a638a',
  '#8f4b5d', '#a18c47', '#377f8d', '#8e6047',
]

export function autoColor(id) {
  return DESIGNER_COLORS[id % DESIGNER_COLORS.length]
}
