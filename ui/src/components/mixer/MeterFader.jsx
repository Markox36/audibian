import React, { useEffect, useMemo, useRef } from 'react'
import { CREAM, DB_TICKS, GREEN, RAIL_TEXT, RED } from './theme'
import { subscribeBars } from './meterStore'
import { createRafSend } from './rafSend'

// Volume fader and level meters, side by side.
//
// Layout, left to right: the dB scale, the stereo meter bars, then the fader
// in its own lane. The fader cap used to be a full-width pill floating over
// the meters, which cut the level bars in half at whatever volume was set;
// keeping the lanes parallel means neither obscures the other.
//
//   ┌────┬─────┬──────┐
//   │ 0  │ █ █ │  ▓▓▓ │   dB ticks · meters L/R · fader cap
//   │ 12 │ █ █ │   │  │
//   └────┴─────┴──────┘

const FADER_MIN = 0
// Every strip's backend command (`set_strip_volume`, `midi_channel_set_volume`,
// `set_master_volume`) clamps the fader to [0.0, 4.0] and pushes it straight to
// `pactl set-sink-volume <fader*100>%`. The UI used to cap requests at 150 (only
// +10.6dB of real boost, see theme.js `faderToDb`), silently leaving most of that
// backend range unreachable — the actual blocker for a quiet VST instrument on a
// MIDI channel, whose output level nothing else in the chain compensates for.
// 400 matches the backend ceiling exactly (fader = value/100 = 4.0 at the top).
const FADER_MAX = 400
const FADER_UNITY = 100

// Cap height, and the travel padding that keeps it inside the slot at either end.
const CAP_H = 16
const TRAVEL_PAD = 4

// `nodeName` is the PipeWire sink the bars follow. Levels are NOT props: the
// meter store writes the two bar elements directly, so a level change costs
// two style writes instead of a React render of this strip. See meterStore.js.
// `onChange` updates the on-screen value on every move; `onCommit` is the
// backend write and is coalesced to one per frame (see rafSend.js).
function MeterFader({ value, onChange, onCommit, onDragState, nodeName, label = 'Volume' }) {
  const containerRef = useRef(null)
  const barLRef = useRef(null)
  const barRRef = useRef(null)
  const send = useMemo(createRafSend, [])

  useEffect(
    () => subscribeBars(nodeName, barLRef.current, barRRef.current),
    [nodeName]
  )

  const pct = Math.min(1, Math.max(0, (value - FADER_MIN) / (FADER_MAX - FADER_MIN)))
  const unityPct = (FADER_UNITY - FADER_MIN) / (FADER_MAX - FADER_MIN)

  const apply = (next) => {
    onChange(next)
    send.queue(() => onCommit(next))
  }

  const startDrag = (e) => {
    e.preventDefault()
    const cont = containerRef.current
    if (!cont) return
    const rect = cont.getBoundingClientRect()
    const startY = e.clientY
    const startVal = value
    onDragState?.(true)
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      apply(Math.max(FADER_MIN, Math.min(FADER_MAX, startVal + (dy / rect.height) * FADER_MAX)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      send.flush()
      onDragState?.(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key]
    if (step === undefined && e.key !== 'Home') return
    e.preventDefault()
    if (e.key === 'Home') apply(FADER_UNITY)
    else apply(Math.max(FADER_MIN, Math.min(FADER_MAX, value + step)))
  }

  // The fill is a full-height element scaled from its bottom edge. Animating
  // `transform` stays on the compositor; the previous `height` + height
  // transition forced a layout pass for every bar on every frame.
  const meterFill = (ref) => (
    <div className="relative flex-1 min-w-0 max-w-[13px] rounded-[1px] border border-white/[0.07] bg-black/70 overflow-hidden">
      <div
        ref={ref}
        className="absolute inset-0 origin-bottom will-change-transform"
        style={{
          transform: 'scaleY(0)',
          background: `linear-gradient(to top, ${GREEN} 0%, ${GREEN} 78%, ${RED} 100%)`,
        }}
      />
    </div>
  )

  return (
    <div
      ref={containerRef}
      onMouseDown={startDrag}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={FADER_MIN}
      aria-valuemax={FADER_MAX}
      aria-valuenow={Math.round(value)}
      className="relative flex h-full w-full select-none cursor-ns-resize gap-1 rounded-sm border border-white/[0.09] bg-white/[0.04] px-1 pb-3 pt-1.5"
      style={{ minHeight: 0 }}
    >
      {/* dB scale */}
      <div
        className="flex w-3.5 shrink-0 flex-col justify-between items-start text-[6.5px] font-mono leading-none"
        style={{ color: RAIL_TEXT }}
      >
        {DB_TICKS.map(t => (
          <span key={t} className="tabular-nums">{t}</span>
        ))}
      </div>

      {/* Stereo meters */}
      <div className="flex flex-1 min-w-0 justify-center gap-[3px]">
        {meterFill(barLRef)}
        {meterFill(barRRef)}
      </div>

      {/* Fader lane */}
      <div className="relative w-[21px] shrink-0">
        {/* Routed slot the cap rides in */}
        <div
          className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full"
          style={{
            background: 'linear-gradient(to right, #000 0%, #1c1c1f 50%, #000 100%)',
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.9)',
          }}
        />
        {/* Unity mark */}
        <div
          className="absolute left-0 right-0 h-px"
          style={{ bottom: `calc(${TRAVEL_PAD}px + ${unityPct} * (100% - ${CAP_H + TRAVEL_PAD}px))`, backgroundColor: RAIL_TEXT, opacity: 0.5 }}
        />
        {/* Cap */}
        <div
          className="pointer-events-none absolute left-0 right-0"
          style={{ bottom: `calc(${TRAVEL_PAD}px + ${pct} * (100% - ${CAP_H + TRAVEL_PAD}px))` }}
        >
          <div
            className="relative w-full rounded-[3px]"
            style={{
              height: CAP_H,
              background: 'linear-gradient(to bottom, #6e6e73 0%, #47474c 42%, #2c2c30 44%, #3c3c41 100%)',
              border: '1px solid #101012',
              boxShadow: '0 2px 4px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 0 rgba(0,0,0,0.5)',
            }}
          >
            {/* Grip line across the middle, the way a real cap is moulded */}
            <div
              className="absolute inset-x-[2px] top-1/2 h-px -translate-y-1/2"
              style={{ backgroundColor: CREAM, opacity: 0.85, boxShadow: '0 1px 0 rgba(0,0,0,0.6)' }}
            />
          </div>
        </div>
      </div>

      <div className="absolute bottom-0.5 left-1.5 text-[6.5px] font-mono" style={{ color: RAIL_TEXT }}>
        db
      </div>
    </div>
  )
}

export { MeterFader }
