// Shared tokens and pure helpers for the mixer.
//
// Colours also live in tailwind.config.js as the `mix-*` palette. These
// constants exist for the cases Tailwind cannot express: values interpolated
// into inline styles (meter fills, per-strip accents, canvas strokes).

export const CREAM     = '#e8e6dd'
export const GREEN     = '#3ecf8e'
export const GREEN_DIM = 'rgba(62, 207, 142, 0.35)'
export const RED       = '#ff5e62'
export const PANEL_BG  = '#0a0a0a'
export const STRIP_BG  = 'rgba(255, 255, 255, 0.02)'
export const RAIL_TEXT = 'rgba(255, 255, 255, 0.4)'
export const FAINT     = 'rgba(255, 255, 255, 0.06)'

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
  meter:   'clamp(150px, 42vh, 560px)',
  exclude: '40px',
}

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

export function faderToDb(val) {
  const v = parseFloat(val)
  if (v === 0) return '-inf'
  if (v === 100) return '0.0'
  if (v > 100) {
    const db = ((v - 100) / 50) * 6
    return `+${db.toFixed(1)}`
  }
  const db = 20 * Math.log10(v / 100)
  return `${db.toFixed(1)}`
}

const DESIGNER_COLORS = [
  '#3ecf8e', '#4169e1', '#b26645', '#7a638a',
  '#8f4b5d', '#a18c47', '#377f8d', '#8e6047',
]

export function autoColor(id) {
  return DESIGNER_COLORS[id % DESIGNER_COLORS.length]
}
