import React from 'react'
import { CREAM, FAINT } from './theme'

function PanKnob({ value, onChange, size = 30 }) {
  const v = Math.max(-1, Math.min(1, value || 0))
  const angle = v * 135
  const half = size / 2
  const radius = half - 3
  const indicatorX = half + Math.sin((angle * Math.PI) / 180) * (radius - 2)
  const indicatorY = half - Math.cos((angle * Math.PI) / 180) * (radius - 2)

  const startDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startVal = v
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      const next = Math.max(-1, Math.min(1, startVal + dy / 80))
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
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onMouseDown={startDrag}
      onDoubleClick={(e) => { e.stopPropagation(); onChange(0) }}
      className="cursor-ns-resize"
    >
      <circle cx={half} cy={half} r={radius} fill="#0d0d0d" stroke={FAINT} strokeWidth="1" />
      <circle cx={half} cy={half} r={radius - 2} fill="#181818" />
      <line
        x1={half} y1={half}
        x2={indicatorX} y2={indicatorY}
        stroke={CREAM}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx={half} cy={half} r="1.5" fill={CREAM} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Meter + Fader (tall, openDAW-style)
// Meter is a solid green bar on the LEFT half of the cell.
// Fader handle is a small horizontal pill that slides vertically.
// dB ticks (0, 6, 12, …, 54) are drawn on the right edge of the meter.

export { PanKnob }
