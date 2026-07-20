import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Settings, Plus, ZoomIn, Sparkles, X, Activity, GripVertical, RotateCcw } from 'lucide-react'

// ---------------------------------------------------------------------------
// Palette (openDAW-inspired)
// ---------------------------------------------------------------------------

const CREAM       = '#e8e6dd'
const GREEN       = '#3ecf8e'
const GREEN_DIM   = 'rgba(62, 207, 142, 0.35)'
const RED         = '#ff5e62'
const PANEL_BG    = '#0a0a0a'
const STRIP_BG    = 'rgba(255, 255, 255, 0.02)'
const RAIL_TEXT   = 'rgba(255, 255, 255, 0.4)'
const FAINT       = 'rgba(255, 255, 255, 0.06)'

// Subgrid template: Input | Sends | Output | Pan | Volume | Meter (1fr) | Exclude
const GRID_TEMPLATE = '32px 76px 32px 52px 30px minmax(220px, 1fr) 48px'

const DB_TICKS = [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]

function faderToDb(val) {
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

function autoColor(id) {
  return DESIGNER_COLORS[id % DESIGNER_COLORS.length]
}

// ---------------------------------------------------------------------------
// Pan knob
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

function StripFrame({ accent, children, dragClasses, style, onDragOver, onDragLeave, onDrop, editing }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`grid h-full transition-all duration-200 ${dragClasses}`}
      style={{
        gridRow: 'span 7',
        gridTemplateRows: 'subgrid',
        gridTemplateColumns: '1fr',
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
        padding: '4px 4px 6px 4px',
        backgroundColor: STRIP_BG,
        borderRadius: 4,
        border: '1px solid rgba(255, 255, 255, 0.03)',
        borderTop: `2px solid ${editing ? accent : 'transparent'}`,
        color: CREAM,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function CellLabel({ children, color = CREAM, ...rest }) {
  return (
    <div
      className="text-[9px] font-bold tracking-wider uppercase text-center truncate px-1 leading-none flex items-center justify-center w-full h-full bg-black/25 border border-white/[0.04] rounded-sm"
      style={{ color }}
      {...rest}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Input strip
// ---------------------------------------------------------------------------

const InputStrip = React.memo(function InputStrip({
  ch, returnChannels, sends, captureNodes,
  faderVal, setFader,
  onRemoveInput, onOpenModal,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  dbL, dbR,
}) {
  const accent = ch.color || autoColor(ch.id)
  const faderKey = `in-${ch.id}`
  const [muted, setMuted] = useState(ch.muted)
  useEffect(() => { setMuted(ch.muted) }, [ch.muted])

  const dragClasses = isDragging
    ? 'opacity-30'
    : isDragOverTarget
    ? 'ring-1 ring-white/40'
    : ''

  const peakDbDisplay = Math.max(dbL ?? -60, dbR ?? -60)
  const peakTxt = peakDbDisplay <= -59.5 ? '-inf' : peakDbDisplay.toFixed(1)
  const faderTxt = faderToDb(faderVal)
  const clipping = peakDbDisplay > -0.5
  const sourceLabel = (() => {
    if (!ch.source_name) return '—'
    const n = captureNodes.find(n => n.name === ch.source_name)
    return (n?.nick || n?.description || n?.app_name || ch.source_name).slice(0, 10)
  })()

  return (
    <StripFrame
      accent={accent}
      dragClasses={dragClasses}
      editing={isDragOverTarget}
      onDragOver={e => onDragOver(e, ch.id, true)}
      onDragLeave={e => onDragLeave(e, ch.id)}
      onDrop={e => onDrop(e, ch.id, true)}
    >
      {/* Row 1 — Input Header */}
      <div className="flex items-center gap-1 px-1 h-full w-full bg-black/40 border border-white/[0.04] rounded-sm">
        <div
          draggable
          onDragStart={e => onDragStart(e, ch.id, true)}
          onDragEnd={onDragEnd}
          className="cursor-grab shrink-0 hover:text-white transition-colors"
          style={{ color: RAIL_TEXT }}
          title="Drag"
        >
          <GripVertical className="w-3 h-3" />
        </div>
        <input
          defaultValue={ch.name}
          key={ch.name}
          onBlur={e => invoke('update_input_channel_name', { id: ch.id, name: e.target.value }).catch(console.error)}
          onMouseDown={e => e.stopPropagation()}
          className="bg-transparent text-[10px] font-semibold text-center flex-1 min-w-0 focus:outline-none focus:bg-white/[0.05] rounded-sm py-0.5 truncate"
          style={{ color: CREAM }}
        />
        <button
          onClick={() => onOpenModal({ id: ch.id, isInput: true, name: ch.name, color: accent })}
          className="shrink-0 hover:text-white transition-colors"
          style={{ color: RAIL_TEXT }}
          title="Config"
        >
          <Settings className="w-3 h-3" />
        </button>
      </div>

      {/* Row 2 — Sends */}
      <div
        className="flex flex-col items-center justify-center gap-1 px-1 py-1 h-full w-full bg-black/25 border border-white/[0.04] rounded-sm"
      >
        {returnChannels.length === 0 ? (
          <button
            className="w-6 h-6 rounded-sm flex items-center justify-center"
            style={{ color: RAIL_TEXT, border: `1px dashed ${FAINT}` }}
            title="No returns"
            disabled
          >
            <Plus className="w-3 h-3" />
          </button>
        ) : (
          returnChannels.slice().sort((a, b) => a.order - b.order).map((ret, idx) => {
            const letter = String.fromCharCode(65 + idx)
            const active = sends.some(s => s.input_channel_id === ch.id && s.return_channel_id === ret.id)
            return (
              <button
                key={ret.id}
                onClick={() => invoke('toggle_send', { inputId: ch.id, returnId: ret.id, active: !active }).catch(console.error)}
                title={`Send to ${ret.name}`}
                className="w-full text-[8px] font-bold tracking-wider uppercase py-0.5 rounded-sm transition-all"
                style={{
                  backgroundColor: active ? `${GREEN}22` : 'transparent',
                  color: active ? GREEN : RAIL_TEXT,
                  border: `1px solid ${active ? GREEN_DIM : FAINT}`,
                }}
              >
                {letter}
              </button>
            )
          })
        )}
      </div>

      {/* Row 3 — Output/Source Select */}
      <div className="h-full w-full bg-black/25 border border-white/[0.04] rounded-sm overflow-hidden flex items-center">
        <select
          value={ch.source_name || ''}
          onChange={e => invoke('set_input_source', { id: ch.id, sourceName: e.target.value || null }).catch(console.error)}
          className="w-full h-full text-[9px] font-medium text-center focus:outline-none cursor-pointer bg-transparent border-none appearance-none px-1"
          style={{
            color: CREAM,
            textAlignLast: 'center',
          }}
          title={sourceLabel}
        >
          <option value="" className="bg-[#121212]">—</option>
          {captureNodes.map(n => (
            <option key={n.id} value={n.name} className="bg-[#121212]">{n.nick || n.description || n.app_name || n.name}</option>
          ))}
        </select>
      </div>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-black/25 border border-white/[0.04] rounded-sm py-1">
        <PanKnob
          value={ch.pan ?? 0}
          onChange={(p) => invoke('set_strip_pan', { id: ch.id, isInput: true, pan: p }).catch(console.error)}
        />
      </div>

      {/* Row 5 — Volume readouts */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <div
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('set_strip_volume', { id: ch.id, isInput: true, volume: 1.0 }).catch(console.error)
          }}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm cursor-pointer tabular-nums bg-black/25 border border-white/[0.04] hover:bg-white/[0.03] transition-colors"
          style={{ color: CREAM }}
          title="Volume — double-click to reset"
        >
          {faderTxt}
        </div>
        <div
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm tabular-nums border border-white/[0.04]"
          style={{
            backgroundColor: clipping ? RED : 'rgba(0,0,0,0.25)',
            color: clipping ? 'white' : GREEN,
          }}
          title="Peak (L+R max)"
        >
          {peakTxt}
        </div>
      </div>

      {/* Row 6 — Meter */}
      <div className="h-full w-full min-h-0 relative">
        <MeterFader
          value={faderVal}
          onChange={v => {
            setFader(faderKey, v)
            invoke('set_strip_volume', { id: ch.id, isInput: true, volume: v / 100 }).catch(console.error)
          }}
          dbL={dbL}
          dbR={dbR}
        />
      </div>

      {/* Row 7 — Exclude */}
      <div className="flex items-center justify-center gap-1 w-full h-full">
        <button
          onClick={() => {
            const next = !muted
            setMuted(next)
            invoke('set_strip_mute', { id: ch.id, isInput: true, muted: next }).catch(console.error)
          }}
          className="w-6 h-6 rounded-sm text-[10px] font-bold transition-all flex items-center justify-center"
          style={{
            backgroundColor: muted ? RED : 'transparent',
            color: muted ? 'white' : CREAM,
            border: `1px solid ${muted ? RED : FAINT}`,
          }}
          title={muted ? 'Unmute' : 'Mute'}
        >
          M
        </button>
        <button
          onClick={() => onSoloToggle(ch.id, true)}
          className="w-6 h-6 rounded-sm text-[10px] font-bold transition-all flex items-center justify-center"
          style={{
            backgroundColor: soloActive ? '#f5b94a' : 'transparent',
            color: soloActive ? 'black' : CREAM,
            border: `1px solid ${soloActive ? '#f5b94a' : FAINT}`,
          }}
          title="Solo"
        >
          S
        </button>
        <button
          onClick={() => onRemoveInput(ch.id)}
          className="w-5 h-6 rounded-sm hover:text-rose-400 flex items-center justify-center transition-colors"
          style={{ color: RAIL_TEXT, border: `1px solid ${FAINT}` }}
          title="Remove channel"
        >
          <X className="w-3 h-3 mx-auto" />
        </button>
      </div>
    </StripFrame>
  )
})

// ---------------------------------------------------------------------------
// Return strip (no source select, no send buttons)
// ---------------------------------------------------------------------------

const ReturnStrip = React.memo(function ReturnStrip({
  ret,
  faderVal, setFader,
  onRemoveReturn, onOpenModal,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  dbL, dbR,
  letter,
}) {
  const accent = ret.color || autoColor(ret.id + 180)
  const faderKey = `ret-${ret.id}`
  const [muted, setMuted] = useState(ret.muted)
  useEffect(() => { setMuted(ret.muted) }, [ret.muted])

  const dragClasses = isDragging ? 'opacity-30' : isDragOverTarget ? 'ring-1 ring-white/40' : ''
  const peakDbDisplay = Math.max(dbL ?? -60, dbR ?? -60)
  const peakTxt = peakDbDisplay <= -59.5 ? '-inf' : peakDbDisplay.toFixed(1)
  const faderTxt = faderToDb(faderVal)
  const clipping = peakDbDisplay > -0.5

  return (
    <StripFrame
      accent={accent}
      dragClasses={dragClasses}
      editing={isDragOverTarget}
      onDragOver={e => onDragOver(e, ret.id, false)}
      onDragLeave={e => onDragLeave(e, ret.id)}
      onDrop={e => onDrop(e, ret.id, false)}
    >
      {/* Row 1 — name */}
      <div className="flex items-center gap-1 px-1 h-full w-full bg-black/40 border border-white/[0.04] rounded-sm">
        <div
          draggable
          onDragStart={e => onDragStart(e, ret.id, false)}
          onDragEnd={onDragEnd}
          className="cursor-grab shrink-0 hover:text-white transition-colors"
          style={{ color: RAIL_TEXT }}
        >
          <GripVertical className="w-3 h-3" />
        </div>
        <input
          defaultValue={ret.name}
          key={ret.name}
          onBlur={e => invoke('update_return_channel_name', { id: ret.id, name: e.target.value }).catch(console.error)}
          onMouseDown={e => e.stopPropagation()}
          className="bg-transparent text-[10px] font-semibold text-center flex-1 min-w-0 focus:outline-none focus:bg-white/[0.05] rounded-sm py-0.5 truncate"
          style={{ color: CREAM }}
        />
        <button
          onClick={() => onOpenModal({ id: ret.id, isInput: false, name: ret.name, color: accent })}
          className="shrink-0 hover:text-white transition-colors"
          style={{ color: RAIL_TEXT }}
        >
          <Settings className="w-3 h-3" />
        </button>
      </div>

      {/* Row 2 — Sends placeholder (letter) */}
      <div
        className="flex items-center justify-center h-full w-full text-[10px] font-black tracking-widest bg-black/25 border border-white/[0.04] rounded-sm"
        style={{ color: accent }}
      >
        {letter}
      </div>

      {/* Row 3 — Output (BUS label) */}
      <div className="h-full w-full">
        <CellLabel>BUS</CellLabel>
      </div>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-black/25 border border-white/[0.04] rounded-sm py-1">
        <PanKnob
          value={ret.pan ?? 0}
          onChange={(p) => invoke('set_strip_pan', { id: ret.id, isInput: false, pan: p }).catch(console.error)}
        />
      </div>

      {/* Row 5 — Volume */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <div
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('set_strip_volume', { id: ret.id, isInput: false, volume: 1.0 }).catch(console.error)
          }}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm cursor-pointer tabular-nums bg-black/25 border border-white/[0.04] hover:bg-white/[0.03] transition-colors"
          style={{ color: CREAM }}
        >
          {faderTxt}
        </div>
        <div
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm tabular-nums border border-white/[0.04]"
          style={{
            backgroundColor: clipping ? RED : 'rgba(0,0,0,0.25)',
            color: clipping ? 'white' : GREEN,
          }}
        >
          {peakTxt}
        </div>
      </div>

      {/* Row 6 — Meter */}
      <div className="h-full w-full min-h-0 relative">
        <MeterFader
          value={faderVal}
          onChange={v => {
            setFader(faderKey, v)
            invoke('set_strip_volume', { id: ret.id, isInput: false, volume: v / 100 }).catch(console.error)
          }}
          dbL={dbL}
          dbR={dbR}
        />
      </div>

      {/* Row 7 — Exclude */}
      <div className="flex items-center justify-center gap-1 w-full h-full">
        <button
          onClick={() => {
            const next = !muted
            setMuted(next)
            invoke('set_strip_mute', { id: ret.id, isInput: false, muted: next }).catch(console.error)
          }}
          className="w-6 h-6 rounded-sm text-[10px] font-bold transition-all flex items-center justify-center"
          style={{
            backgroundColor: muted ? RED : 'transparent',
            color: muted ? 'white' : CREAM,
            border: `1px solid ${muted ? RED : FAINT}`,
          }}
        >
          M
        </button>
        <button
          onClick={() => onSoloToggle(ret.id, false)}
          className="w-6 h-6 rounded-sm text-[10px] font-bold transition-all flex items-center justify-center"
          style={{
            backgroundColor: soloActive ? '#f5b94a' : 'transparent',
            color: soloActive ? 'black' : CREAM,
            border: `1px solid ${soloActive ? '#f5b94a' : FAINT}`,
          }}
        >
          S
        </button>
        <button
          onClick={() => onRemoveReturn(ret.id)}
          className="w-5 h-6 rounded-sm hover:text-rose-400 flex items-center justify-center transition-colors"
          style={{ color: RAIL_TEXT, border: `1px solid ${FAINT}` }}
        >
          <X className="w-3 h-3 mx-auto" />
        </button>
      </div>
    </StripFrame>
  )
})

// ---------------------------------------------------------------------------
// Master strip
// ---------------------------------------------------------------------------

const MasterStrip = React.memo(function MasterStrip({
  masterSink, masterMuted, masterPan, sinkNodes,
  faderVal, setFader, dbL, dbR,
}) {
  const accent = GREEN
  const [muted, setMuted] = useState(masterMuted)
  useEffect(() => { setMuted(masterMuted) }, [masterMuted])

  const peakDbDisplay = Math.max(dbL ?? -60, dbR ?? -60)
  const peakTxt = peakDbDisplay <= -59.5 ? '-inf' : peakDbDisplay.toFixed(1)
  const faderTxt = faderToDb(faderVal)
  const clipping = peakDbDisplay > -0.5

  return (
    <StripFrame accent={accent} editing dragClasses="">
      {/* Row 1 — Title */}
      <div className="flex items-center justify-center h-full w-full bg-black/40 border border-white/[0.04] rounded-sm">
        <span className="text-[10px] font-black tracking-[0.15em] uppercase" style={{ color: accent }}>
          Master
        </span>
      </div>

      {/* Row 2 — Stereo Label */}
      <div className="flex items-center justify-center h-full w-full bg-black/25 border border-white/[0.04] rounded-sm" style={{ color: RAIL_TEXT }}>
        <span className="text-[8px] uppercase tracking-wider font-semibold">stereo</span>
      </div>

      {/* Row 3 — HW Sink Select */}
      <div className="h-full w-full bg-black/25 border border-white/[0.04] rounded-sm overflow-hidden flex items-center">
        <select
          value={masterSink || ''}
          onChange={e => invoke('set_master_sink', { sinkName: e.target.value || null }).catch(console.error)}
          className="w-full h-full text-[9px] font-medium text-center focus:outline-none cursor-pointer bg-transparent border-none appearance-none px-1"
          style={{
            color: CREAM,
            textAlignLast: 'center',
          }}
        >
          <option value="" className="bg-[#121212]">—</option>
          {sinkNodes.map(n => (
            <option key={n.id} value={n.name} className="bg-[#121212]">{n.nick || n.description || n.app_name || n.name}</option>
          ))}
        </select>
      </div>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-black/25 border border-white/[0.04] rounded-sm py-1">
        <PanKnob
          value={masterPan ?? 0}
          onChange={(p) => invoke('set_master_pan', { pan: p }).catch(console.error)}
        />
      </div>

      {/* Row 5 — Volume */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <div
          onDoubleClick={() => {
            setFader('master', 100)
            invoke('set_master_volume', { volume: 1.0 }).catch(console.error)
          }}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm cursor-pointer tabular-nums bg-black/25 border border-white/[0.04] hover:bg-white/[0.03] transition-colors"
          style={{ color: CREAM }}
        >
          {faderTxt}
        </div>
        <div
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm tabular-nums border border-white/[0.04]"
          style={{
            backgroundColor: clipping ? RED : 'rgba(0,0,0,0.25)',
            color: clipping ? 'white' : GREEN,
          }}
        >
          {peakTxt}
        </div>
      </div>

      {/* Row 6 — Meter */}
      <div className="h-full w-full min-h-0 relative">
        <MeterFader
          value={faderVal}
          onChange={v => {
            setFader('master', v)
            invoke('set_master_volume', { volume: v / 100 }).catch(console.error)
          }}
          dbL={dbL}
          dbR={dbR}
        />
      </div>

      {/* Row 7 — Exclude */}
      <div className="flex items-center justify-center gap-1 w-full h-full">
        <button
          onClick={() => {
            const next = !muted
            setMuted(next)
            invoke('set_master_mute', { muted: next }).catch(console.error)
          }}
          className="w-full h-6 rounded-sm text-[10px] font-bold flex items-center justify-center transition-colors"
          style={{
            backgroundColor: muted ? RED : `${GREEN}22`,
            color: muted ? 'white' : GREEN,
            border: `1px solid ${muted ? RED : GREEN_DIM}`,
          }}
        >
          {muted ? 'MUTED' : 'LIVE'}
        </button>
      </div>
    </StripFrame>
  )
})

// ---------------------------------------------------------------------------
// Header rail (label column)
// ---------------------------------------------------------------------------

function HeaderRail() {
  const cells = ['Input', 'Sends', 'Output', 'Pan', 'Volume', 'Fader', 'Exclude']
  return (
    <div
      className="grid h-full select-none"
      style={{
        gridRow: 'span 7',
        gridTemplateRows: 'subgrid',
        padding: '4px 6px 6px 6px',
        borderTop: '2px solid transparent',
        minWidth: 64,
      }}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          className="flex items-center justify-end text-[9px] font-bold tracking-wider uppercase pr-2"
          style={{ color: RAIL_TEXT, pointerEvents: 'none', height: '100%' }}
        >
          {c}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Config modal
// ---------------------------------------------------------------------------

function ConfigModal({ modal, onSave, onCancel }) {
  const [localModal, setLocalModal] = useState(modal)
  useEffect(() => { setLocalModal(modal) }, [modal])
  if (!localModal) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4" style={{ color: GREEN }} />
            <span className="text-[11px] font-extrabold uppercase tracking-widest" style={{ color: CREAM }}>Configure Strip</span>
          </div>
          <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-wider" style={{ color: RAIL_TEXT }}>Title</label>
            <input
              type="text"
              value={localModal.name}
              onChange={e => setLocalModal({ ...localModal, name: e.target.value })}
              className="bg-black/40 border border-white/[0.08] text-xs rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#3ecf8e] w-full"
              style={{ color: CREAM }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-wider" style={{ color: RAIL_TEXT }}>Color</label>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="color"
                value={localModal.color || GREEN}
                onChange={e => setLocalModal({ ...localModal, color: e.target.value })}
                className="h-8 w-12 bg-transparent border border-white/[0.08] rounded-md cursor-pointer p-0.5"
              />
              <div className="flex gap-1.5 ml-auto">
                {DESIGNER_COLORS.map(c => {
                  const isActive = (localModal.color || '').toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      onClick={() => setLocalModal({ ...localModal, color: c })}
                      style={{ backgroundColor: c }}
                      className={`w-6 h-6 rounded-full border ${isActive ? 'border-white scale-110' : 'border-white/10'}`}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3 mt-1">
          <button onClick={onCancel} className="bg-white/[0.05] border border-white/[0.08] text-xs font-semibold py-1.5 px-4 rounded-md" style={{ color: CREAM }}>
            Cancel
          </button>
          <button
            onClick={() => onSave(localModal)}
            className="text-xs font-bold py-1.5 px-4 rounded-md"
            style={{ backgroundColor: GREEN, color: 'black' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Mixer component
// ---------------------------------------------------------------------------

export default function Mixer({ graph }) {
  const [config, setConfig] = useState({
    input_channels: [],
    return_channels: [],
    sends: [],
    master_sink: null,
    master_pan: 0,
    global_scale: 1.0,
  })
  const [loading, setLoading] = useState(true)
  const [peaks, setPeaks] = useState({})
  const [faderValues, setFaderValues] = useState({})
  const [modal, setModal] = useState(null)
  const [newInputDialog, setNewInputDialog] = useState(null)
  const [newReturnDialog, setNewReturnDialog] = useState(null)
  const [soloSet, setSoloSet] = useState(new Set())
  const [draggedInfo, setDraggedInfo] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)

  const loadConfig = () => {
    invoke('get_mixer_config').then(cfg => {
      setConfig(cfg)
      setFaderValues(prev => {
        const next = { ...prev }
        for (const c of cfg.input_channels || []) {
          const k = `in-${c.id}`
          if (next[k] === undefined && typeof c.fader === 'number') next[k] = c.fader * 100
        }
        for (const r of cfg.return_channels || []) {
          const k = `ret-${r.id}`
          if (next[k] === undefined && typeof r.fader === 'number') next[k] = r.fader * 100
        }
        if (next.master === undefined && typeof cfg.master_fader === 'number') next.master = cfg.master_fader * 100
        return next
      })
      setLoading(false)
    }).catch(console.error)
    invoke('get_solo_set').then(keys => setSoloSet(new Set(keys))).catch(console.error)
  }

  const peakBufferRef = useRef({})
  const peakDirtyRef = useRef(false)
  const peakRafRef = useRef(0)

  useEffect(() => {
    loadConfig()
    const unsubs = []
    listen('pw-node-peak', e => {
      const { node_name, db, db_l, db_r } = e.payload
      peakBufferRef.current[node_name] = {
        db,
        l: typeof db_l === 'number' ? db_l : db,
        r: typeof db_r === 'number' ? db_r : db,
      }
      peakDirtyRef.current = true
      if (!peakRafRef.current) {
        peakRafRef.current = requestAnimationFrame(() => {
          peakRafRef.current = 0
          if (!peakDirtyRef.current) return
          peakDirtyRef.current = false
          setPeaks(prev => ({ ...prev, ...peakBufferRef.current }))
          peakBufferRef.current = {}
        })
      }
    }).then(u => unsubs.push(u))
    listen('pw-node-added', () => loadConfig()).then(u => unsubs.push(u))
    listen('pw-node-removed', () => loadConfig()).then(u => unsubs.push(u))
    return () => {
      unsubs.forEach(u => u())
      if (peakRafRef.current) cancelAnimationFrame(peakRafRef.current)
    }
  }, [])

  const sinkNodes = useMemo(() => graph.nodes.filter(n => n.media_class === 'Audio/Sink'), [graph.nodes])
  const captureNodes = useMemo(
    () => graph.nodes.filter(n => n.media_class === 'Audio/Source' || n.media_class?.startsWith('Audio/Source/')),
    [graph.nodes]
  )

  const getFader = (key, def = 100) => faderValues[key] ?? def
  const setFader = useCallback((key, val) => {
    setFaderValues(p => ({ ...p, [key]: val }))
  }, [])

  const openNewInputDialog = () => setNewInputDialog(`Canal ${config.input_channels.length + 1}`)
  const confirmAddInput = async () => {
    const name = newInputDialog.trim() || 'Canal'
    setNewInputDialog(null)
    await invoke('add_input_channel', { name }).catch(console.error)
    loadConfig()
  }
  const openNewReturnDialog = () => setNewReturnDialog(`Return ${String.fromCharCode(65 + config.return_channels.length % 26)}`)
  const confirmAddReturn = async () => {
    const name = newReturnDialog.trim() || 'Return'
    setNewReturnDialog(null)
    await invoke('add_return_channel', { name }).catch(console.error)
    loadConfig()
  }
  const removeInput = useCallback(async (id) => {
    await invoke('remove_input_channel', { id }).catch(console.error)
    loadConfig()
  }, [])
  const removeReturn = useCallback(async (id) => {
    await invoke('remove_return_channel', { id }).catch(console.error)
    loadConfig()
  }, [])

  const handleDragStart = useCallback((e, id, isInput) => {
    e.dataTransfer.setData('channelId', id)
    e.dataTransfer.setData('isInput', isInput ? '1' : '0')
    setDraggedInfo({ id, isInput })
  }, [])
  const handleDragEnd = useCallback(() => { setDraggedInfo(null); setDragOverId(null) }, [])
  const handleDragOver = useCallback((e, id, isInput) => {
    e.preventDefault()
    setDraggedInfo(curr => {
      if (curr && curr.isInput === isInput && curr.id !== id) setDragOverId(id)
      return curr
    })
  }, [])
  const handleDragLeave = useCallback((e, id) => {
    setDragOverId(curr => (curr === id ? null : curr))
  }, [])
  const handleDrop = useCallback(async (e, targetId, targetIsInput) => {
    const draggedId = parseInt(e.dataTransfer.getData('channelId'))
    const draggedIsInput = e.dataTransfer.getData('isInput') === '1'
    setDraggedInfo(null); setDragOverId(null)
    if (draggedId === targetId || draggedIsInput !== targetIsInput) return
    let inputOrder = config.input_channels.slice().sort((a, b) => a.order - b.order).map(c => c.id)
    let returnOrder = config.return_channels.slice().sort((a, b) => a.order - b.order).map(r => r.id)
    const swap = (arr, idA, idB) => {
      const ia = arr.indexOf(idA), ib = arr.indexOf(idB)
      if (ia === -1 || ib === -1) return arr
      const next = [...arr]; next[ia] = idB; next[ib] = idA; return next
    }
    if (targetIsInput) inputOrder = swap(inputOrder, draggedId, targetId)
    else returnOrder = swap(returnOrder, draggedId, targetId)
    await invoke('reorder_channels', { inputOrder, returnOrder }).catch(console.error)
    loadConfig()
  }, [config.input_channels, config.return_channels])

  const saveModal = async (updated) => {
    if (updated.isInput) await invoke('update_input_channel_name', { id: updated.id, name: updated.name }).catch(console.error)
    else await invoke('update_return_channel_name', { id: updated.id, name: updated.name }).catch(console.error)
    await invoke('set_channel_color', { id: updated.id, isInput: updated.isInput, color: updated.color }).catch(console.error)
    setModal(null); loadConfig()
  }

  const handleSoloToggle = useCallback((id, isInput) => {
    const key = `${isInput ? 'in' : 'ret'}-${id}`
    setSoloSet(prev => {
      const next = new Set(prev)
      const willActivate = !next.has(key)
      if (willActivate) next.add(key); else next.delete(key)
      invoke('set_strip_solo', { id, isInput, solo: willActivate }).then(() => loadConfig()).catch(console.error)
      return next
    })
  }, [])

  const sortedInputs = useMemo(() => config.input_channels.slice().sort((a, b) => a.order - b.order), [config.input_channels])
  const sortedReturns = useMemo(() => config.return_channels.slice().sort((a, b) => a.order - b.order), [config.return_channels])

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8" style={{ backgroundColor: PANEL_BG }}>
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 animate-spin" style={{ color: GREEN }} />
          <span className="text-xs font-semibold uppercase tracking-wider font-mono" style={{ color: CREAM }}>Initializing Mixer…</span>
        </div>
      </div>
    )
  }

  const masterPeak = peaks['audibian_master']
  const mDb = typeof masterPeak === 'number' ? masterPeak : masterPeak?.db ?? -60

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ backgroundColor: PANEL_BG, color: CREAM }}>

      {/* ─── Control Bar ─── */}
      <div className="flex flex-wrap items-center justify-between px-3 sm:px-4 py-1.5 gap-2 sm:gap-3 min-h-[42px] shrink-0 text-xs select-none border-b border-white/[0.05]">
        <div className="flex items-center gap-3 shrink-0">
          <Activity className="w-3.5 h-3.5" style={{ color: GREEN }} />
          <span className="text-[10px] font-black tracking-[0.22em] uppercase" style={{ color: CREAM }}>Mixer</span>
          <span className="text-[9px] font-mono" style={{ color: RAIL_TEXT }}>
            {sortedInputs.length} in · {sortedReturns.length} ret
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <button
            onClick={openNewInputDialog}
            className="text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md flex items-center gap-1.5"
            style={{ backgroundColor: STRIP_BG, color: CREAM, border: `1px solid ${FAINT}` }}
          >
            <Plus className="w-3 h-3" style={{ color: GREEN }} />
            Input
          </button>
          <button
            onClick={openNewReturnDialog}
            className="text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md flex items-center gap-1.5"
            style={{ backgroundColor: STRIP_BG, color: CREAM, border: `1px solid ${FAINT}` }}
          >
            <Plus className="w-3 h-3" style={{ color: GREEN }} />
            Return
          </button>
        </div>
      </div>

      {/* ─── Mixer Grid (header rail + strips, subgrid rows) ─── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden" style={{ backgroundColor: PANEL_BG }}>
        <div
          className="h-full"
          style={{
            display: 'grid',
            gridTemplateRows: GRID_TEMPLATE,
            gridAutoFlow: 'column dense',
            gridAutoColumns: '86px',
            gridTemplateColumns: '64px',
            justifyContent: 'start',
            padding: '0.75em 1em 1em 1em',
            rowGap: 4,
            columnGap: 8,
            width: 'max-content',
            minWidth: '100%',
          }}
        >
          <HeaderRail />

          {sortedInputs.map(ch => {
            const peak = peaks[ch.sink_name]
            const peakDb = typeof peak === 'number' ? peak : peak?.db ?? -60
            return (
              <InputStrip
                key={ch.id}
                ch={ch}
                returnChannels={sortedReturns}
                sends={config.sends}
                captureNodes={captureNodes}
                faderVal={getFader(`in-${ch.id}`)}
                setFader={setFader}
                onRemoveInput={removeInput}
                onOpenModal={setModal}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                isDragging={draggedInfo && draggedInfo.id === ch.id && draggedInfo.isInput === true}
                isDragOverTarget={dragOverId === ch.id}
                soloActive={soloSet.has(`in-${ch.id}`)}
                onSoloToggle={handleSoloToggle}
                dbL={peak?.l ?? peakDb}
                dbR={peak?.r ?? peakDb}
              />
            )
          })}

          {sortedReturns.map((ret, idx) => {
            const peak = peaks[ret.sink_name]
            const peakDb = typeof peak === 'number' ? peak : peak?.db ?? -60
            return (
              <ReturnStrip
                key={ret.id}
                ret={ret}
                faderVal={getFader(`ret-${ret.id}`)}
                setFader={setFader}
                onRemoveReturn={removeReturn}
                onOpenModal={setModal}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                isDragging={draggedInfo && draggedInfo.id === ret.id && draggedInfo.isInput === false}
                isDragOverTarget={dragOverId === ret.id}
                soloActive={soloSet.has(`ret-${ret.id}`)}
                onSoloToggle={handleSoloToggle}
                letter={String.fromCharCode(65 + idx)}
                dbL={peak?.l ?? peakDb}
                dbR={peak?.r ?? peakDb}
              />
            )
          })}

          <MasterStrip
            masterSink={config.master_sink}
            masterMuted={config.master_muted}
            masterPan={config.master_pan}
            sinkNodes={sinkNodes}
            faderVal={getFader('master')}
            setFader={setFader}
            dbL={masterPeak?.l ?? mDb}
            dbR={masterPeak?.r ?? mDb}
          />
        </div>
      </div>

      {/* Modals */}
      {modal && <ConfigModal modal={modal} onSave={saveModal} onCancel={() => setModal(null)} />}

      {newInputDialog !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setNewInputDialog(null)}>
          <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4" style={{ color: GREEN }} />
                <span className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: CREAM }}>New Input</span>
              </div>
              <button onClick={() => setNewInputDialog(null)} className="text-neutral-500 hover:text-neutral-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={newInputDialog}
              onChange={e => setNewInputDialog(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmAddInput(); if (e.key === 'Escape') setNewInputDialog(null) }}
              autoFocus
              className="bg-black/40 border border-white/[0.08] text-xs rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#3ecf8e] w-full"
              style={{ color: CREAM }}
            />
            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3">
              <button onClick={() => setNewInputDialog(null)} className="bg-white/[0.05] border border-white/[0.08] text-xs font-semibold py-1.5 px-4 rounded-md" style={{ color: CREAM }}>Cancel</button>
              <button onClick={confirmAddInput} className="text-xs font-bold py-1.5 px-4 rounded-md" style={{ backgroundColor: GREEN, color: 'black' }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {newReturnDialog !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setNewReturnDialog(null)}>
          <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4" style={{ color: GREEN }} />
                <span className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: CREAM }}>New Return</span>
              </div>
              <button onClick={() => setNewReturnDialog(null)} className="text-neutral-500 hover:text-neutral-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={newReturnDialog}
              onChange={e => setNewReturnDialog(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmAddReturn(); if (e.key === 'Escape') setNewReturnDialog(null) }}
              autoFocus
              className="bg-black/40 border border-white/[0.08] text-xs rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#3ecf8e] w-full"
              style={{ color: CREAM }}
            />
            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3">
              <button onClick={() => setNewReturnDialog(null)} className="bg-white/[0.05] border border-white/[0.08] text-xs font-semibold py-1.5 px-4 rounded-md" style={{ color: CREAM }}>Cancel</button>
              <button onClick={confirmAddReturn} className="text-xs font-bold py-1.5 px-4 rounded-md" style={{ backgroundColor: GREEN, color: 'black' }}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
