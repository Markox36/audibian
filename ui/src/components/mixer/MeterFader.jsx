import React, { useRef } from 'react'
import { CREAM, DB_TICKS, GREEN, RAIL_TEXT, RED } from './theme'


function MeterFader({ value, onChange, dbL, dbR }) {
  const FADER_MIN = 0
  const FADER_MAX = 150
  const FADER_UNITY = 100
  const containerRef = useRef(null)

  const pct = Math.min(1, Math.max(0, (value - FADER_MIN) / (FADER_MAX - FADER_MIN)))

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

  return (
    <div
      ref={containerRef}
      onMouseDown={startDrag}
      className="relative h-full w-full select-none cursor-ns-resize bg-black/35 border border-white/[0.04] rounded-sm"
      style={{ minHeight: 0 }}
    >
      {/* Meter area: tracks the cell height. Two thin bars (L/R) side-by-side. */}
      <div className="absolute left-1.5 top-1.5 bottom-3.5 right-5 flex gap-[2px]">
        {/* L bar */}
        <div className="relative flex-1 bg-black/85 border border-white/[0.03] overflow-hidden rounded-[1px]">
          <div
            className="absolute left-0 right-0 bottom-0"
            style={{
              height: `${lPct}%`,
              background: `linear-gradient(to top, ${GREEN} 0%, ${GREEN} 80%, ${RED} 100%)`,
              transition: 'height 60ms linear',
            }}
          />
        </div>
        {/* R bar */}
        <div className="relative flex-1 bg-black/85 border border-white/[0.03] overflow-hidden rounded-[1px]">
          <div
            className="absolute left-0 right-0 bottom-0"
            style={{
              height: `${rPct}%`,
              background: `linear-gradient(to top, ${GREEN} 0%, ${GREEN} 80%, ${RED} 100%)`,
              transition: 'height 60ms linear',
            }}
          />
        </div>
      </div>

      {/* dB tick labels on right edge */}
      <div className="absolute right-1 top-1.5 bottom-3.5 w-3.5 flex flex-col justify-between items-end text-[6.5px] font-mono leading-none pr-0.5" style={{ color: RAIL_TEXT }}>
        {DB_TICKS.map(t => (
          <span key={t} className="tabular-nums">{t}</span>
        ))}
      </div>

      {/* "db" footer */}
      <div className="absolute right-1.5 bottom-0.5 text-[6.5px] font-mono" style={{ color: RAIL_TEXT }}>
        db
      </div>

      {/* Fader handle: small horizontal pill slides over the meter */}
      <div
        className="absolute left-1 right-5 pointer-events-none"
        style={{ bottom: `calc(8px + ${pct} * (100% - 20px))` }}
      >
        <div
          className="h-3 w-full mx-auto"
          style={{
            background: 'linear-gradient(to bottom, #4a4a4a, #2a2a2a)',
            border: '1px solid #121212',
            borderRadius: '2px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          <div className="h-px w-full mt-[5px]" style={{ backgroundColor: CREAM, opacity: 0.7 }} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strip cell shells

export { MeterFader }
