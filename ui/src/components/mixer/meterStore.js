// Level-meter transport: Tauri events → DOM, with React deliberately out of
// the loop.
//
// Why this exists. Meters used to flow through `useState` in Mixer: every
// batch of peaks replaced the `peaks` object, which re-rendered the whole
// mixer and reconciled every strip (~30 nodes each) at display rate, just to
// move two bars. On top of that the bars animated `height`, which forces a
// layout pass per frame per bar. With a handful of strips live that was tens
// of full React renders and hundreds of reflows per second while talking.
//
// Instead: one listener, one rAF loop, direct style writes on elements the
// components hand over via refs. React renders a strip when its *config*
// changes and never for a level change.
//
// Two further properties keep the idle cost at zero:
//   - the backend only sends when a level actually moved (dead-band), so
//     silence produces no events at all;
//   - the rAF loop stops as soon as every meter has converged on its target,
//     so a steady level or silence schedules no frames.

import { listen } from '@tauri-apps/api/event'
import { GREEN, RED } from './theme'

const DB_FLOOR = -60
const DB_RANGE = 60 // DB_FLOOR..0

// Per-frame fraction of the remaining distance covered when falling. Rising
// is instantaneous so transients read at full height (standard meter
// ballistics: fast attack, slow release).
const RELEASE = 0.28

// Below this the bar is treated as settled and the loop may stop.
const EPSILON = 0.002

// The app runs WebKit with compositing disabled (see main.rs), so a transform
// change is a software repaint rather than a GPU layer swap. Two guards keep
// that cost down:
//   - the loop runs at ~30fps, not display rate;
//   - bar heights are quantised, so a level wobbling by less than one step
//     (mic noise on an idle channel) produces no DOM write at all.
const FRAME_MS = 32
const STEPS = 128

const CLIP_DB = -0.5
const IDLE_BG = 'rgba(0,0,0,0.25)'

/** @type {Map<string, {l: number, r: number}>} latest level from the backend */
const targets = new Map()
/** @type {Map<string, {l: number, r: number}>} on-screen level, eased */
const current = new Map()
/** @type {Map<string, Set<{elL: HTMLElement, elR: HTMLElement}>>} */
const barSubs = new Map()
/** @type {Map<string, Set<HTMLElement>>} */
const readoutSubs = new Map()
/** Last value written per element set, to skip no-op DOM writes. */
const lastWritten = new Map()

let rafId = 0
let listening = false
let lastTickAt = 0

function dbToFrac(db) {
  if (!(db > DB_FLOOR)) return 0 // also catches NaN/undefined
  if (db >= 0) return 1
  return (db - DB_FLOOR) / DB_RANGE
}

/** Snap to one of STEPS discrete heights so sub-step jitter writes nothing. */
function quantise(frac) {
  return Math.round(frac * STEPS) / STEPS
}

function ease(cur, target) {
  if (target >= cur) return target // attack: instant
  const next = cur + (target - cur) * RELEASE
  return Math.abs(next - target) < EPSILON ? target : next
}

function ensureListener() {
  if (listening) return
  listening = true
  listen('pw-node-peaks', e => {
    const batch = e.payload
    if (!Array.isArray(batch)) return
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i]
      if (!entry) continue
      // Wire format is a compact tuple: [node_name, db_l, db_r].
      const name = entry[0]
      const l = entry[1]
      const r = entry[2]
      let t = targets.get(name)
      if (t === undefined) {
        t = { l: DB_FLOOR, r: DB_FLOOR }
        targets.set(name, t)
      }
      t.l = l
      t.r = r
    }
    kick()
  })
}

function kick() {
  if (rafId) return
  rafId = requestAnimationFrame(tick)
}

function tick(now) {
  rafId = 0

  // Frame cap. rAF fires at display rate; a level meter does not need it, and
  // under software rendering every extra frame is an extra repaint.
  if (now - lastTickAt < FRAME_MS) {
    kick()
    return
  }
  lastTickAt = now

  let animating = false

  // Only nodes someone is actually displaying cost anything.
  for (const [name, subs] of barSubs) {
    const target = targets.get(name)
    if (target === undefined) continue

    let cur = current.get(name)
    if (cur === undefined) {
      cur = { l: DB_FLOOR, r: DB_FLOOR, ql: -1, qr: -1 }
      current.set(name, cur)
    }

    const nl = ease(cur.l, target.l)
    const nr = ease(cur.r, target.r)
    cur.l = nl
    cur.r = nr
    if (nl !== target.l || nr !== target.r) animating = true

    // Quantised height is what actually reaches the DOM. Unchanged step ⇒ no
    // write ⇒ no repaint, which is what makes an idle-but-noisy input free.
    const ql = quantise(dbToFrac(nl))
    const qr = quantise(dbToFrac(nr))
    if (ql === cur.ql && qr === cur.qr) continue
    const changedL = ql !== cur.ql
    const changedR = qr !== cur.qr
    cur.ql = ql
    cur.qr = qr

    for (const { elL, elR } of subs) {
      if (changedL && elL) elL.style.transform = `scaleY(${ql})`
      if (changedR && elR) elR.style.transform = `scaleY(${qr})`
    }

    const readouts = readoutSubs.get(name)
    if (readouts && readouts.size) {
      const peak = nl > nr ? nl : nr
      const txt = peak <= -59.5 ? '-inf' : peak.toFixed(1)
      const clipping = peak > CLIP_DB
      const prev = lastWritten.get(name)
      if (!prev || prev.txt !== txt || prev.clipping !== clipping) {
        lastWritten.set(name, { txt, clipping })
        for (const el of readouts) {
          el.textContent = txt
          el.style.backgroundColor = clipping ? RED : IDLE_BG
          el.style.color = clipping ? 'white' : GREEN
        }
      }
    }
  }

  if (animating) kick()
}

/**
 * Register the two bar elements for `nodeName`. Returns an unsubscribe.
 * Passing a falsy nodeName is a no-op so strips without a sink still mount.
 */
export function subscribeBars(nodeName, elL, elR) {
  if (!nodeName) return () => {}
  ensureListener()
  let set = barSubs.get(nodeName)
  if (!set) {
    set = new Set()
    barSubs.set(nodeName, set)
  }
  const entry = { elL, elR }
  set.add(entry)
  // Paint the level the meter already has, so a strip that mounts mid-signal
  // does not sit at -inf until the next change clears the dead band.
  const cur = current.get(nodeName) ?? targets.get(nodeName)
  if (cur) {
    if (elL) elL.style.transform = `scaleY(${quantise(dbToFrac(cur.l))})`
    if (elR) elR.style.transform = `scaleY(${quantise(dbToFrac(cur.r))})`
  }
  kick()
  return () => {
    set.delete(entry)
    if (set.size === 0) {
      barSubs.delete(nodeName)
      current.delete(nodeName)
      lastWritten.delete(nodeName)
    }
  }
}

/** Register the peak-readout element for `nodeName`. Returns an unsubscribe. */
export function subscribeReadout(nodeName, el) {
  if (!nodeName || !el) return () => {}
  ensureListener()
  let set = readoutSubs.get(nodeName)
  if (!set) {
    set = new Set()
    readoutSubs.set(nodeName, set)
  }
  set.add(el)
  kick()
  return () => {
    set.delete(el)
    if (set.size === 0) {
      readoutSubs.delete(nodeName)
      lastWritten.delete(nodeName)
    }
  }
}
