import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CREAM, FAINT } from './theme'
import { createRafSend } from './rafSend'

// `value` is the backend's pan; the knob keeps its own copy so dragging moves
// it immediately instead of waiting for a config reload. The backend write is
// coalesced to one per frame (see rafSend.js).
function PanKnob({ value, onChange, size = 30, label = 'Pan' }) {
  const [local, setLocal] = useState(value || 0)
  const dragging = useRef(false)
  const send = useMemo(createRafSend, [])
  useEffect(() => { if (!dragging.current) setLocal(value || 0) }, [value])

  const v = Math.max(-1, Math.min(1, local))
  const angle = v * 135
  const half = size / 2
  const radius = half - 3
  const indicatorX = half + Math.sin((angle * Math.PI) / 180) * (radius - 2)
  const indicatorY = half - Math.cos((angle * Math.PI) / 180) * (radius - 2)

  const apply = (next) => {
    setLocal(next)
    send.queue(() => onChange(next))
  }

  const startDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startVal = v
    dragging.current = true
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      apply(Math.max(-1, Math.min(1, startVal + dy / 80)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragging.current = false
      send.flush()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onKeyDown = (e) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key]
    if (step === undefined && e.key !== 'Home') return
    e.preventDefault()
    if (e.key === 'Home') apply(0)
    else apply(Math.max(-1, Math.min(1, v + step)))
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onMouseDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => { e.stopPropagation(); apply(0) }}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Math.round(v * 100) / 100}
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
