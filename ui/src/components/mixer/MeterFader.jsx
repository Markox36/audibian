import React, { useRef } from 'react'
import { CREAM, DB_TICKS, GREEN, RAIL_TEXT, RED } from './theme'

// Volume fader and level meters, side by side.
//
// Layout, left to right: the fader runs in its own lane, then the stereo
// meter bars, then the dB scale. The fader cap used to be a full-width pill
// floating over the meters, which cut the level bars in half at whatever
// volume was set; keeping the lanes parallel means neither obscures the other.
//
//   ┌──────┬─────┬────┐
//   │ ▓▓▓  │ █ █ │ 0  │   fader cap · meters L/R · dB ticks
//   │  │   │ █ █ │ 12 │
//   └──────┴─────┴────┘

const FADER_MIN = 0
const FADER_MAX = 150
const FADER_UNITY = 100

// Cap height, and the travel padding that keeps it inside the slot at either end.
const CAP_H = 16
const TRAVEL_PAD = 4

function MeterFader({ value, onChange, dbL, dbR }) {
  const containerRef = useRef(null)

  const pct = Math.min(1, Math.max(0, (value - FADER_MIN) / (FADER_MAX - FADER_MIN)))
  const unityPct = (FADER_UNITY - FADER_MIN) / (FADER_MAX - FADER_MIN)

  const dbMin = -60
  const dbMax = 0
  const lPct = Math.max(0, Math.min(100, ((dbL - dbMin) / (dbMax - dbMin)) * 100))
  const rPct = Math.max(0, Math.min(100, ((dbR - dbMin) / (dbMax - dbMin)) * 100))

  const startDrag = (e) => {
    e.preventDefault()
    const cont = containerRef.current
    if (!cont) return
    const rect = cont.getBoundingClientRect()
    const startY = e.clientY
    const startVal = value
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      const next = Math.max(FADER_MIN, Math.min(FADER_MAX, startVal + (dy / rect.height) * FADER_MAX))
      onChange(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const meterFill = (fillPct) => (
    <div className="relative flex-1 min-w-0 rounded-[1px] border border-white/[0.07] bg-black/70 overflow-hidden">
      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          height: `${fillPct}%`,
          background: `linear-gradient(to top, ${GREEN} 0%, ${GREEN} 78%, ${RED} 100%)`,
          transition: 'height 60ms linear',
        }}
      />
    </div>
  )

  return (
    <div
      ref={containerRef}
      onMouseDown={startDrag}
      className="relative flex h-full w-full select-none cursor-ns-resize gap-1 rounded-sm border border-white/[0.09] bg-white/[0.04] px-1 pb-3 pt-1.5"
      style={{ minHeight: 0 }}
    >
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

      {/* Stereo meters */}
      <div className="flex flex-1 min-w-0 gap-[2px]">
        {meterFill(lPct)}
        {meterFill(rPct)}
      </div>

      {/* dB scale */}
      <div
        className="flex w-3.5 shrink-0 flex-col justify-between items-end text-[6.5px] font-mono leading-none"
        style={{ color: RAIL_TEXT }}
      >
        {DB_TICKS.map(t => (
          <span key={t} className="tabular-nums">{t}</span>
        ))}
      </div>

      <div className="absolute bottom-0.5 right-1.5 text-[6.5px] font-mono" style={{ color: RAIL_TEXT }}>
        db
      </div>
    </div>
  )
}

export { MeterFader }
