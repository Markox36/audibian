import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Settings, Plus, ZoomIn, Sparkles, X, Activity, GripVertical, RotateCcw } from 'lucide-react'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Premium track-color palette — desaturated, console-grade
const DESIGNER_COLORS = [
  '#4169e1', // Royal Blue (app accent)
  '#b26645', // Muted Terracotta
  '#4f7c5e', // Forest Sage
  '#7a638a', // Heather Amethyst
  '#8f4b5d', // Cabernet Rose
  '#a18c47', // Olive Gold
  '#377f8d', // Ocean Teal
  '#8e6047', // Clay Walnut
]

function autoColor(id) {
  return DESIGNER_COLORS[id % DESIGNER_COLORS.length]
}

// ---------------------------------------------------------------------------
// Send Button — square, Ableton-style
// ---------------------------------------------------------------------------

function SquareSend({ active, label, onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 flex flex-col items-center justify-center font-sans transition-colors border select-none rounded-sm ${
        active
          ? 'bg-[#4169e1]/15 border-[#4169e1] text-[#4169e1] font-bold'
          : 'bg-black/40 border-white/[0.06] text-neutral-500 hover:text-neutral-200 hover:border-white/20'
      }`}
    >
      <span className="text-[10px] uppercase leading-none tracking-wide">{label}</span>
      <span className="text-[6px] uppercase tracking-tighter mt-0.5 leading-none opacity-60">Send</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Vertical Fader + VU meter
// ---------------------------------------------------------------------------

function FaderAndMeter({ value, onChange, db, stereo = false }) {
  const faderHeight = 120
  const handleHeight = 8
  const pct = Math.min(1, Math.max(0, value / 150))
  const topPos = (1 - pct) * (faderHeight - handleHeight)

  // Throttled dB readout (every 500ms / ~2 Hz) so the numeric label updates
  // at a steady, readable rate. Keeps the bar smooth but the text cheap.
  const [dbDisplay, setDbDisplay] = React.useState(db)
  const dbRef = React.useRef(db)
  React.useEffect(() => { dbRef.current = db }, [db])
  React.useEffect(() => {
    const id = setInterval(() => setDbDisplay(dbRef.current), 500)
    return () => clearInterval(id)
  }, [])
  const dbText = dbDisplay <= -59.5 ? '-inf' : `${dbDisplay.toFixed(1)}`

  const handleMouseDown = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startVal = value

    const handleMouseMove = (moveEvent) => {
      const deltaY = startY - moveEvent.clientY
      const deltaVal = (deltaY / faderHeight) * 150
      const newVal = Math.min(150, Math.max(0, startVal + deltaVal))
      onChange(newVal)
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  const dbMin = -60
  const dbMax = 6
  const dbPct = Math.max(0, Math.min(100, ((db - dbMin) / (dbMax - dbMin)) * 100))

  return (
    <div className="flex flex-col items-stretch gap-0.5 select-none">
    <div className="flex items-stretch justify-between gap-1.5 py-1 h-[126px] px-1 bg-black/30 border border-white/[0.06] rounded-sm">
      {/* Fader Track & Thumb */}
      <div
        className="relative w-5 cursor-ns-resize"
        style={{ height: `${faderHeight}px` }}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-[4px] bg-black border border-white/[0.06] rounded-sm" />
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-0 w-[2px] bg-[#4169e1] rounded-sm pointer-events-none"
          style={{ height: `${pct * 100}%` }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[22px] h-[8px] bg-[#3a3a3a] border border-black rounded-sm shadow-md pointer-events-none flex items-center justify-center"
          style={{ top: `${topPos}px` }}
        >
          <div className="w-full h-[1.5px] bg-[#e5e5e5]" />
        </div>
      </div>

      {/* VU Meter */}
      <div className={`flex ${stereo ? 'gap-[1.5px]' : ''} items-end`} style={{ height: `${faderHeight}px` }}>
        <div
          className={`relative ${stereo ? 'w-1.5' : 'w-2.5'} bg-black border border-white/[0.06] rounded-sm overflow-hidden flex flex-col justify-end h-full`}
        >
          <div
            style={{ height: `${dbPct}%` }}
            className="w-full bg-gradient-to-t from-[#38b868] via-[#f5b94a] to-[#df4c55] transition-all duration-75 ease-out"
          />
          {/* Tick lines */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none opacity-20">
            <div className="border-b border-white w-full h-px" />
            <div className="border-b border-white w-full h-px" />
            <div className="border-b border-white w-full h-px" />
            <div className="border-b border-white w-full h-px" />
            <div className="border-b border-white w-full h-px" />
          </div>
        </div>
        {stereo && (
          <div className="relative w-1.5 bg-black border border-white/[0.06] rounded-sm overflow-hidden flex flex-col justify-end h-full">
            <div
              style={{ height: `${dbPct}%` }}
              className="w-full bg-gradient-to-t from-[#38b868] via-[#f5b94a] to-[#df4c55] transition-all duration-75 ease-out"
            />
          </div>
        )}
      </div>

      {/* dB Tick Labels */}
      <div className="flex flex-col justify-between text-[6.5px] font-mono text-neutral-500 select-none leading-none h-[120px] py-[2px] shrink-0 font-bold">
        <span>+6</span>
        <span>0</span>
        <span>-6</span>
        <span>-18</span>
        <span>-36</span>
        <span>-inf</span>
      </div>
    </div>
    <div className="text-[8px] font-mono font-bold text-neutral-300 text-center bg-black/40 border border-white/[0.06] rounded-sm py-[1px] leading-none">
      {dbText}<span className="text-neutral-500 ml-0.5">dB</span>
    </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strip container shell — shared structure between Input / Return / Master
// ---------------------------------------------------------------------------

const STRIP_BG       = 'bg-[#1f1f1f]'
const STRIP_BORDER   = 'border-r border-white/[0.06]'
const HEADER_BG      = 'bg-white/[0.05]'
const SECTION_BG     = 'bg-black/20'
const SECTION_ALT_BG = 'bg-white/[0.02]'
const SECTION_BORDER = 'border-b border-white/[0.06]'

// ---------------------------------------------------------------------------
// Input strip
// ---------------------------------------------------------------------------

const InputStrip = React.memo(function InputStrip({
  ch, returnChannels, sends, captureNodes, scale,
  faderVal, setFader,
  onRemoveInput, onOpenModal,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  armed, onArmToggle,
  db
}) {
  const width = Math.round(110 * scale)
  const headerColor = ch.color || autoColor(ch.id)
  const faderKey = `in-${ch.id}`

  const [muted, setMuted] = useState(ch.muted)

  useEffect(() => {
    setMuted(ch.muted)
  }, [ch.muted])

  const handleMute = () => {
    const next = !muted
    setMuted(next)
    invoke('set_strip_mute', { id: ch.id, isInput: true, muted: next }).catch(console.error)
  }

  const dragClasses = isDragging
    ? 'opacity-20 border-dashed scale-95 z-0'
    : isDragOverTarget
    ? 'border-[#4169e1] ring-2 ring-[#4169e1] scale-[1.02] shadow-[0_0_15px_rgba(65,105,225,0.4)] z-10'
    : ''

  return (
    <div
      style={{ width }}
      onDragOver={e => onDragOver(e, ch.id, true)}
      onDragLeave={e => onDragLeave(e, ch.id)}
      onDrop={e => onDrop(e, ch.id, true)}
      className={`${STRIP_BG} ${STRIP_BORDER} flex flex-col justify-start h-[456px] relative select-none transition-all duration-200 ease-out shrink-0 rounded-sm overflow-hidden ${dragClasses}`}
    >
      {/* 1. Track Name Header */}
      <div
        style={{ borderTop: `3px solid ${headerColor}` }}
        className={`h-8 px-1.5 flex items-center justify-between gap-1 shrink-0 ${HEADER_BG} ${SECTION_BORDER}`}
      >
        {/* Drag Handle */}
        <div
          draggable
          onDragStart={e => onDragStart(e, ch.id, true)}
          onDragEnd={onDragEnd}
          className="cursor-grab text-neutral-500 hover:text-neutral-300 p-0.5 rounded transition-colors shrink-0"
          title="Drag to reorder"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>

        {/* Name Input */}
        <input
          defaultValue={ch.name}
          key={ch.name}
          onBlur={e => invoke('update_input_channel_name', { id: ch.id, name: e.target.value }).catch(console.error)}
          onMouseDown={e => e.stopPropagation()}
          className="bg-transparent hover:bg-white/[0.06] border-none font-bold text-[10px] tracking-wide py-0.5 px-1 rounded-sm focus:bg-white/[0.08] text-neutral-100 focus:outline-none text-center flex-1 min-w-0 font-sans truncate"
        />

        {/* Configuration Gear */}
        <button
          onClick={() => onOpenModal({ id: ch.id, isInput: true, name: ch.name, color: ch.color || headerColor })}
          className="text-neutral-500 hover:text-neutral-200 p-0.5 rounded transition-colors shrink-0"
          title="Configure Channel"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 3. Routing (Increased height slightly to absorb the removed fake drag handle height) */}
      <div className={`${SECTION_BG} p-1.5 flex flex-col justify-between h-[111px] ${SECTION_BORDER} text-[8px] font-sans text-neutral-400 shrink-0`}>
        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Select Input Device</div>
          <select
            value={ch.source_name || ''}
            onChange={e => invoke('set_input_source', { id: ch.id, sourceName: e.target.value || null }).catch(console.error)}
            className="w-full bg-white/[0.05] border border-white/[0.08] text-[9px] text-neutral-200 font-medium py-0.5 px-1 rounded-sm focus:outline-none focus:border-[#4169e1]/60 truncate font-sans"
            title="Hardware Input Source"
          >
            <option value="">— No Source —</option>
            {captureNodes.map(n => (
              <option key={n.id} value={n.name}>{n.nick || n.description || n.app_name || n.name}</option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Audio To</div>
          <div className="w-full bg-black/40 border border-white/[0.06] text-[8px] text-neutral-400 font-mono py-0.5 px-1 rounded-sm truncate leading-tight text-center">
            {ch.sink_name}
          </div>
        </div>

        <div className="flex items-center gap-1 justify-between shrink-0">
          <button
            onClick={() => invoke('set_input_mono', { id: ch.id, mono: !ch.mono }).catch(console.error)}
            className={`flex-1 py-0.5 text-[8px] font-bold border rounded-sm uppercase transition-colors ${
              ch.mono
                ? 'bg-[#a18c47]/25 text-[#d4be75] border-[#a18c47]/60'
                : 'bg-white/[0.04] text-neutral-400 border-white/[0.06] hover:bg-white/[0.08]'
            }`}
          >
            Mono
          </button>

          <button
            onClick={() => invoke('set_input_send_to_master', { id: ch.id, sendToMaster: !ch.send_to_master }).catch(console.error)}
            className={`flex-1 py-0.5 text-[8px] font-bold border rounded-sm uppercase transition-colors ${
              !ch.send_to_master
                ? 'bg-[#df4c55]/25 text-[#f59e9b] border-[#df4c55]/60 shadow-[0_1px_3px_rgba(223,76,85,0.15)]'
                : 'bg-white/[0.04] text-neutral-400 border-white/[0.06] hover:bg-white/[0.08]'
            }`}
            title={ch.send_to_master ? 'Mute to Master' : 'Unmute to Master'}
          >
            Mute M.
          </button>
        </div>
      </div>

      {/* 4. Sends */}
      <div className={`${SECTION_ALT_BG} p-1.5 ${SECTION_BORDER} h-[56px] shrink-0 flex flex-col justify-between`}>
        <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none text-center">Sends</div>
        {returnChannels.length > 0 ? (
          <div className="flex flex-wrap gap-1 justify-center items-center h-[34px] overflow-y-auto">
            {returnChannels
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((ret, idx) => {
                const letter = String.fromCharCode(65 + idx)
                const active = sends.some(
                  s => s.input_channel_id === ch.id && s.return_channel_id === ret.id
                )
                return (
                  <SquareSend
                    key={ret.id}
                    active={active}
                    label={letter}
                    onClick={() => invoke('toggle_send', { inputId: ch.id, returnId: ret.id, active: !active }).catch(console.error)}
                  />
                )
              })}
          </div>
        ) : (
          <div className="text-[7px] text-neutral-600 font-mono text-center py-2 italic select-none">No returns</div>
        )}
      </div>

      {/* 5. dB readout + Fader */}
      <div className={`${SECTION_BG} p-1.5 ${SECTION_BORDER} flex flex-col gap-1.5 h-[164px] shrink-0 justify-between`}>
        <div className="flex gap-1 items-center shrink-0">
          <div
            onDoubleClick={() => {
              setFader(faderKey, 100)
              invoke('set_strip_volume', { id: ch.id, isInput: true, volume: 1.0 }).catch(console.error)
            }}
            className="flex-1 bg-black border border-white/[0.06] rounded-sm text-center text-[9px] font-bold font-mono text-neutral-300 py-0.5 leading-tight cursor-pointer hover:border-[#4169e1]/40 hover:text-white transition-colors select-none"
            title="Double-click to reset to 0 dB"
          >
            {faderToDb(faderVal)}
          </div>
          <button
            onClick={() => {
              setFader(faderKey, 100)
              invoke('set_strip_volume', { id: ch.id, isInput: true, volume: 1.0 }).catch(console.error)
            }}
            className="bg-black hover:bg-white/[0.06] border border-white/[0.06] hover:border-[#4169e1]/40 rounded-sm text-center py-0.5 px-1.5 text-neutral-400 hover:text-white transition-colors shrink-0 flex items-center justify-center"
            title="Reset to 0.0 dB"
          >
            <RotateCcw className="w-2.5 h-2.5" />
          </button>
        </div>

        <FaderAndMeter
          value={faderVal}
          onChange={v => {
            setFader(faderKey, v)
            invoke('set_strip_volume', { id: ch.id, isInput: true, volume: v / 100 }).catch(console.error)
          }}
          db={db}
        />
      </div>

      {/* 6. Mute / Solo + Setup */}
      <div className="p-1.5 flex flex-col justify-between bg-white/[0.03] h-[88px] shrink-0">
        <div className="flex items-center gap-1 justify-center w-full">
          <button
            onClick={handleMute}
            className={`flex-1 h-[28px] rounded-sm text-[10px] font-black flex items-center justify-center transition-colors border ${
              !muted
                ? 'bg-[#4169e1] text-white border-[#5f80e8] shadow-[0_1px_3px_rgba(65,105,225,0.3)]'
                : 'bg-black/40 text-neutral-600 border-white/[0.06]'
            }`}
            title={muted ? 'Activate Track' : 'Mute Track'}
          >
            {ch.order + 1}
          </button>

          <button
            onClick={() => onSoloToggle(ch.id, true)}
            className={`w-[36px] h-[28px] rounded-sm text-[10px] font-black flex items-center justify-center transition-colors border ${
              soloActive
                ? 'bg-[#f5b94a] text-black border-[#d99e2c]'
                : 'bg-black/40 text-neutral-600 border-white/[0.06] hover:text-neutral-300'
            }`}
            title="Solo Track"
          >
            S
          </button>
        </div>

        <div className="flex items-center w-full shrink-0">
          <button
            onClick={() => onRemoveInput(ch.id)}
            className="w-full h-[25px] bg-white/[0.04] border border-white/[0.06] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-500 rounded-sm flex items-center justify-center transition-colors text-[8.5px] font-bold uppercase tracking-wider"
            title="Remove Channel"
          >
            Remove Channel
          </button>
        </div>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Return strip
// ---------------------------------------------------------------------------

const ReturnStrip = React.memo(function ReturnStrip({
  ret, scale,
  faderVal, setFader,
  onRemoveReturn, onOpenModal, onReload,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  db,
  letter
}) {
  const width = Math.round(110 * scale)
  const headerColor = ret.color || autoColor(ret.id + 180)
  const faderKey = `ret-${ret.id}`

  const [muted, setMuted] = useState(ret.muted)

  useEffect(() => {
    setMuted(ret.muted)
  }, [ret.muted])

  const handleMute = () => {
    const next = !muted
    setMuted(next)
    invoke('set_strip_mute', { id: ret.id, isInput: false, muted: next }).catch(console.error)
  }

  const dragClasses = isDragging
    ? 'opacity-20 border-dashed scale-95 z-0'
    : isDragOverTarget
    ? 'border-[#4169e1] ring-2 ring-[#4169e1] scale-[1.02] shadow-[0_0_15px_rgba(65,105,225,0.4)] z-10'
    : ''

  return (
    <div
      style={{ width }}
      onDragOver={e => onDragOver(e, ret.id, false)}
      onDragLeave={e => onDragLeave(e, ret.id)}
      onDrop={e => onDrop(e, ret.id, false)}
      className={`${STRIP_BG} ${STRIP_BORDER} flex flex-col justify-start h-[456px] relative select-none transition-all duration-200 ease-out shrink-0 rounded-sm overflow-hidden ${dragClasses}`}
    >
      {/* 1. Track Name Header */}
      <div
        style={{ borderTop: `3px solid ${headerColor}` }}
        className={`h-8 px-1.5 flex items-center justify-between gap-1 shrink-0 ${HEADER_BG} ${SECTION_BORDER}`}
      >
        {/* Drag Handle */}
        <div
          draggable
          onDragStart={e => onDragStart(e, ret.id, false)}
          onDragEnd={onDragEnd}
          className="cursor-grab text-neutral-500 hover:text-neutral-300 p-0.5 rounded transition-colors shrink-0"
          title="Drag to reorder"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </div>

        {/* Name Input */}
        <input
          defaultValue={ret.name}
          key={ret.name}
          onBlur={e => invoke('update_return_channel_name', { id: ret.id, name: e.target.value }).catch(console.error)}
          onMouseDown={e => e.stopPropagation()}
          className="bg-transparent hover:bg-white/[0.06] border-none font-bold text-[10px] tracking-wide py-0.5 px-1 rounded-sm focus:bg-white/[0.08] text-neutral-100 focus:outline-none text-center flex-1 min-w-0 font-sans truncate"
        />

        {/* Configuration Gear */}
        <button
          onClick={() => onOpenModal({ id: ret.id, isInput: false, name: ret.name, color: ret.color || headerColor })}
          className="text-neutral-500 hover:text-neutral-200 p-0.5 rounded transition-colors shrink-0"
          title="Configure Channel"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 3. Routing (Increased height slightly to absorb the removed fake drag handle height) */}
      <div className={`${SECTION_BG} p-1.5 flex flex-col justify-between h-[111px] ${SECTION_BORDER} text-[8px] font-sans text-neutral-400 shrink-0`}>
        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Return Bus</div>
          <div className="w-full bg-black/40 border border-white/[0.06] text-[8px] text-neutral-400 font-mono py-0.5 px-1 rounded-sm truncate leading-tight text-center">
            {ret.sink_name}
          </div>
        </div>

        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Audio To</div>
          <div className="w-full bg-white/[0.05] border border-white/[0.06] text-[8px] text-neutral-300 font-mono py-0.5 px-1 rounded-sm truncate text-center">
            Matrix Only
          </div>
        </div>
      </div>

      {/* 4. Sends Spacer */}
      <div className={`${SECTION_ALT_BG} p-1.5 ${SECTION_BORDER} h-[56px] shrink-0 flex flex-col justify-center items-center`}>
        <span className="text-[7.5px] font-mono text-neutral-500 tracking-wider uppercase text-center select-none opacity-60">
          Return Bus
        </span>
      </div>

      {/* 5. Fader */}
      <div className={`${SECTION_BG} p-1.5 ${SECTION_BORDER} flex flex-col gap-1.5 h-[164px] shrink-0 justify-between`}>
        <div className="flex gap-1 items-center shrink-0">
          <div
            onDoubleClick={() => {
              setFader(faderKey, 100)
              invoke('set_strip_volume', { id: ret.id, isInput: false, volume: 1.0 }).catch(console.error)
            }}
            className="flex-1 bg-black border border-white/[0.06] rounded-sm text-center text-[9px] font-bold font-mono text-neutral-300 py-0.5 leading-tight cursor-pointer hover:border-[#4169e1]/40 hover:text-white transition-colors select-none"
            title="Double-click to reset to 0 dB"
          >
            {faderToDb(faderVal)}
          </div>
          <button
            onClick={() => {
              setFader(faderKey, 100)
              invoke('set_strip_volume', { id: ret.id, isInput: false, volume: 1.0 }).catch(console.error)
            }}
            className="bg-black hover:bg-white/[0.06] border border-white/[0.06] hover:border-[#4169e1]/40 rounded-sm text-center py-0.5 px-1.5 text-neutral-400 hover:text-white transition-colors shrink-0 flex items-center justify-center"
            title="Reset to 0.0 dB"
          >
            <RotateCcw className="w-2.5 h-2.5" />
          </button>
        </div>

        <FaderAndMeter
          value={faderVal}
          onChange={v => {
            setFader(faderKey, v)
            invoke('set_strip_volume', { id: ret.id, isInput: false, volume: v / 100 }).catch(console.error)
          }}
          db={db}
        />
      </div>

      {/* 6. Mute/Solo + Setup */}
      <div className="p-1.5 flex flex-col justify-between bg-white/[0.03] h-[88px] shrink-0">
        <div className="flex items-center gap-1 justify-center w-full">
          <button
            onClick={handleMute}
            className={`flex-1 h-[28px] rounded-sm text-[10px] font-black flex items-center justify-center transition-colors border ${
              !muted
                ? 'bg-[#4169e1] text-white border-[#5f80e8] shadow-[0_1px_3px_rgba(65,105,225,0.3)]'
                : 'bg-black/40 text-neutral-600 border-white/[0.06]'
            }`}
            title={muted ? 'Activate Return' : 'Mute Return'}
          >
            {letter}
          </button>

          <button
            onClick={() => onSoloToggle(ret.id, false)}
            className={`w-[36px] h-[28px] rounded-sm text-[10px] font-black flex items-center justify-center transition-colors border ${
              soloActive
                ? 'bg-[#f5b94a] text-black border-[#d99e2c]'
                : 'bg-black/40 text-neutral-600 border-white/[0.06] hover:text-neutral-300'
            }`}
            title="Solo Return"
          >
            S
          </button>
        </div>

        <div className="flex items-center w-full shrink-0">
          <button
            onClick={() => onRemoveReturn(ret.id)}
            className="w-full h-[25px] bg-white/[0.04] border border-white/[0.06] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-500 rounded-sm flex items-center justify-center transition-colors text-[8.5px] font-bold uppercase tracking-wider"
            title="Remove Return"
          >
            Remove Return
          </button>
        </div>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Master strip
// ---------------------------------------------------------------------------

const MasterStrip = React.memo(function MasterStrip({
  masterSink, masterMuted, sinkNodes, scale, faderVal, setFader, db
}) {
  const displayName = n => n.nick || n.description || n.app_name || n.name
  const width = Math.round(115 * scale)

  const [muted, setMuted] = useState(masterMuted)

  useEffect(() => {
    setMuted(masterMuted)
  }, [masterMuted])

  const handleMute = () => {
    const next = !muted
    setMuted(next)
    invoke('set_master_mute', { muted: next }).catch(console.error)
  }

  return (
    <div
      style={{ width }}
      className={`${STRIP_BG} ${STRIP_BORDER} flex flex-col justify-start h-[456px] relative select-none transition-all shrink-0 rounded-sm overflow-hidden`}
    >
      {/* 1. Header */}
      <div
        style={{ borderTop: '3px solid #4169e1' }}
        className={`h-8 px-1 flex items-center justify-center shrink-0 ${HEADER_BG} ${SECTION_BORDER}`}
      >
        <span className="font-bold text-[#4169e1] text-[10px] tracking-[0.15em] uppercase">Master</span>
      </div>

      {/* 3. Routing (Increased height slightly to absorb the removed fake drag handle height) */}
      <div className={`${SECTION_BG} p-1.5 flex flex-col justify-between h-[111px] ${SECTION_BORDER} text-[8px] font-sans text-neutral-400 shrink-0`}>
        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Output To</div>
          <select
            value={masterSink || ''}
            onChange={e => invoke('set_master_sink', { sinkName: e.target.value || null }).catch(console.error)}
            className="w-full bg-white/[0.05] border border-white/[0.08] text-[9px] text-neutral-200 font-medium py-0.5 px-1 rounded-sm focus:outline-none focus:border-[#4169e1]/60 truncate font-sans"
            title="Final Hardware Output"
          >
            <option value="">— No Output —</option>
            {sinkNodes.map(n => (
              <option key={n.id} value={n.name}>{displayName(n)}</option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-[7px] font-bold text-neutral-500 uppercase tracking-wider mb-0.5 leading-none">Status</div>
          <div className={`w-full border rounded-sm text-[8px] font-mono py-0.5 px-1 truncate leading-tight text-center ${
            masterSink
              ? 'bg-[#38b868]/10 border-[#38b868]/40 text-[#38b868]'
              : 'bg-black/40 border-white/[0.06] text-neutral-500'
          }`}>
            {masterSink ? 'LIVE MIX' : 'OFFLINE'}
          </div>
        </div>

        <div className="h-[17px] flex items-center justify-center bg-white/[0.04] border border-white/[0.06] rounded-sm select-none">
          <span className="text-[6.5px] font-mono text-neutral-400 uppercase tracking-wider font-bold">STEREO OUT</span>
        </div>
      </div>

      {/* 4. Sends Spacer */}
      <div className={`${SECTION_ALT_BG} p-1.5 ${SECTION_BORDER} h-[56px] shrink-0 flex flex-col justify-center items-center`}>
        <span className="text-[7.5px] font-mono text-neutral-500 tracking-wider uppercase text-center select-none opacity-60">
          Stereo Bus
        </span>
      </div>

      {/* 5. Fader */}
      <div className={`${SECTION_BG} p-1.5 ${SECTION_BORDER} flex flex-col gap-1.5 h-[164px] shrink-0 justify-between`}>
        <div className="flex gap-1 items-center shrink-0">
          <div
            onDoubleClick={() => {
              setFader('master', 100)
              invoke('set_master_volume', { volume: 1.0 }).catch(console.error)
            }}
            className="flex-1 bg-black border border-white/[0.06] rounded-sm text-center text-[9px] font-bold font-mono text-neutral-300 py-0.5 leading-tight cursor-pointer hover:border-[#4169e1]/40 hover:text-white transition-colors select-none"
            title="Double-click to reset to 0 dB"
          >
            {faderToDb(faderVal)}
          </div>
          <button
            onClick={() => {
              setFader('master', 100)
              invoke('set_master_volume', { volume: 1.0 }).catch(console.error)
            }}
            className="bg-black hover:bg-white/[0.06] border border-white/[0.06] hover:border-[#4169e1]/40 rounded-sm text-center py-0.5 px-1.5 text-neutral-400 hover:text-white transition-colors shrink-0 flex items-center justify-center"
            title="Reset to 0.0 dB"
          >
            <RotateCcw className="w-2.5 h-2.5" />
          </button>
        </div>

        <FaderAndMeter
          value={faderVal}
          onChange={v => {
            setFader('master', v)
            invoke('set_master_volume', { volume: v / 100 }).catch(console.error)
          }}
          db={db}
          stereo
        />
      </div>

      {/* 6. Master mute + signal indicator */}
      <div className="p-1.5 flex flex-col justify-between bg-white/[0.03] h-[88px] shrink-0">
        <div className="flex items-center justify-center h-[28px] w-full">
          <button
            onClick={handleMute}
            className={`w-full h-[28px] rounded-sm text-[10px] font-black tracking-widest uppercase flex items-center justify-center transition-colors border ${
              !muted
                ? 'bg-[#4169e1] text-white border-[#5f80e8] shadow-[0_1px_3px_rgba(65,105,225,0.3)]'
                : 'bg-black/40 text-neutral-600 border-white/[0.06]'
            }`}
            title={muted ? 'Activate Master' : 'Mute Master'}
          >
            Master
          </button>
        </div>

        <div className="flex items-center gap-1 w-full shrink-0">
          <div className={`w-full h-[25px] rounded-sm border flex items-center justify-center gap-1.5 text-[7px] uppercase tracking-widest font-bold select-none ${
            db > 0
              ? 'bg-[#df4c55]/15 border-[#df4c55]/50 text-[#df4c55]'
              : 'bg-white/[0.03] border-white/[0.06] text-neutral-500'
          }`}>
            {db > 0 ? (
              <>
                <span className="h-1 w-1 rounded-full bg-[#df4c55] animate-pulse" />
                Clip
              </>
            ) : (
              <>Headroom {Math.max(-60, Math.round(-db))} dB</>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Config modal
// ---------------------------------------------------------------------------

function ConfigModal({ modal, onSave, onCancel }) {
  const [localModal, setLocalModal] = useState(modal)

  useEffect(() => { setLocalModal(modal) }, [modal])

  if (!localModal) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-[#1f1f1f] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4 animate-in fade-in duration-100" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#4169e1]" />
            <span className="text-[11px] font-extrabold uppercase tracking-widest text-neutral-100">Configure Strip</span>
          </div>
          <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-200 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">Channel Title</label>
            <input
              type="text"
              value={localModal.name}
              onChange={e => setLocalModal({ ...localModal, name: e.target.value })}
              className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1] w-full"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">Strip Highlight Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={localModal.color || '#4169e1'}
                onChange={e => setLocalModal({ ...localModal, color: e.target.value })}
                className="h-8 w-12 bg-transparent border border-white/[0.08] rounded-md cursor-pointer p-0.5"
              />
              <span className="text-xs font-mono text-neutral-400 uppercase">{localModal.color || '#4169e1'}</span>
              <div className="flex gap-1.5 ml-auto">
                {DESIGNER_COLORS.slice(0, 8).map(c => {
                  const isActive = (localModal.color || '#4169e1').toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      onClick={() => setLocalModal({ ...localModal, color: c })}
                      style={{ backgroundColor: c }}
                      className={`w-6 h-6 rounded-full border transition-all ${
                        isActive
                          ? 'border-white scale-110 ring-2 ring-[#4169e1] ring-offset-2 ring-offset-neutral-900 shadow-md'
                          : 'border-white/10 hover:border-white/30 hover:scale-105'
                      }`}
                      title={c}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3 mt-1">
          <button
            onClick={onCancel}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(localModal)}
            className="bg-[#4169e1] hover:bg-[#5478e8] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors shadow-[0_1px_3px_rgba(65,105,225,0.35)]"
          >
            Save Strip
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
    global_scale: 1.0,
  })
  const [loading, setLoading] = useState(true)
  const [peaks, setPeaks] = useState({})
  const [faderValues, setFaderValues] = useState({})
  const [modal, setModal] = useState(null)
  const [scale, setScale] = useState(1.0)
  const [newInputDialog, setNewInputDialog] = useState(null)
  const [newReturnDialog, setNewReturnDialog] = useState(null)

  const [soloSet, setSoloSet] = useState(new Set())
  const [armedChannels, setArmedChannels] = useState(new Set())
  const [cpuLoad, setCpuLoad] = useState(8)

  const [draggedInfo, setDraggedInfo] = useState(null) // { id, isInput }
  const [dragOverId, setDragOverId] = useState(null)

  const loadConfig = () => {
    invoke('get_mixer_config').then(cfg => {
      setConfig(cfg)
      setScale(cfg.global_scale ?? 1.0)
      // Seed fader UI values from persisted config (fader is stored as
      // 0..4 in toml; UI works in 0..150 where 100 = unity). Only fill
      // keys that don't already have a value so an in-flight drag isn't
      // snapped back when get_mixer_config returns.
      setFaderValues(prev => {
        const next = { ...prev }
        for (const c of cfg.input_channels || []) {
          const k = `in-${c.id}`
          if (next[k] === undefined && typeof c.fader === 'number') {
            next[k] = c.fader * 100
          }
        }
        for (const r of cfg.return_channels || []) {
          const k = `ret-${r.id}`
          if (next[k] === undefined && typeof r.fader === 'number') {
            next[k] = r.fader * 100
          }
        }
        if (next.master === undefined && typeof cfg.master_fader === 'number') {
          next.master = cfg.master_fader * 100
        }
        return next
      })
      setLoading(false)
    }).catch(console.error)

    invoke('get_solo_set').then(keys => {
      setSoloSet(new Set(keys))
    }).catch(console.error)
  }

  const peakBufferRef = useRef({})
  const peakDirtyRef = useRef(false)
  const peakRafRef = useRef(0)

  useEffect(() => {
    loadConfig()

    const unsubs = []

    // Buffer peak events in a ref; flush to React state at most once per
    // animation frame. Backend emits ~47 events/sec PER meter; with 6
    // strips that's ~300 setStates/sec — pegs WebKit at 80%+ CPU and
    // starves PipeWire's RT thread, causing the very xruns we're trying
    // to fix. rAF caps Mixer re-renders at 60 fps regardless of meter rate.
    listen('pw-node-peak', e => {
      peakBufferRef.current[e.payload.node_name] = e.payload.db
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

  useEffect(() => {
    const timer = setInterval(() => {
      setCpuLoad(prev => {
        const delta = (Math.random() - 0.5) * 2
        return Math.max(6, Math.min(13, Math.round(prev + delta)))
      })
    }, 1500)
    return () => clearInterval(timer)
  }, [])

  const sinkNodes = useMemo(
    () => graph.nodes.filter(n => n.media_class === 'Audio/Sink'),
    [graph.nodes]
  )
  const captureNodes = useMemo(
    () => graph.nodes.filter(n =>
      n.media_class === 'Audio/Source' || n.media_class?.startsWith('Audio/Source/')
    ),
    [graph.nodes]
  )

  const getFader = (key, def = 100) => faderValues[key] ?? def
  const setFader = useCallback((key, val) => {
    setFaderValues(p => ({ ...p, [key]: val }))
  }, [])

  const openNewInputDialog = () => {
    setNewInputDialog(`Canal ${config.input_channels.length + 1}`)
  }

  const confirmAddInput = async () => {
    const name = newInputDialog.trim() || 'Canal'
    setNewInputDialog(null)
    await invoke('add_input_channel', { name }).catch(console.error)
    loadConfig()
  }

  const openNewReturnDialog = () => {
    const letter = String.fromCharCode(65 + config.return_channels.length % 26)
    setNewReturnDialog(`Return ${letter}`)
  }

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

  const handleScaleChange = async (val) => {
    const s = parseFloat(val)
    setScale(s)
    await invoke('set_global_scale', { scale: s }).catch(console.error)
  }

  const handleDragStart = useCallback((e, id, isInput) => {
    e.dataTransfer.setData('channelId', id)
    e.dataTransfer.setData('isInput', isInput ? '1' : '0')
    setDraggedInfo({ id, isInput })
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedInfo(null)
    setDragOverId(null)
  }, [])

  const handleDragOver = useCallback((e, id, isInput) => {
    e.preventDefault()
    setDraggedInfo(currDragged => {
      if (currDragged && currDragged.isInput === isInput && currDragged.id !== id) {
        setDragOverId(id)
      }
      return currDragged
    })
  }, [])

  const handleDragLeave = useCallback((e, id) => {
    setDragOverId(currOver => (currOver === id ? null : currOver))
  }, [])

  const handleDrop = useCallback(async (e, targetId, targetIsInput) => {
    const draggedId = parseInt(e.dataTransfer.getData('channelId'))
    const draggedIsInput = e.dataTransfer.getData('isInput') === '1'
    setDraggedInfo(null)
    setDragOverId(null)
    if (draggedId === targetId) return
    if (draggedIsInput !== targetIsInput) return

    let inputOrder = config.input_channels
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(c => c.id)
    let returnOrder = config.return_channels
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(r => r.id)

    const swap = (arr, idA, idB) => {
      const ia = arr.indexOf(idA)
      const ib = arr.indexOf(idB)
      if (ia === -1 || ib === -1) return arr
      const next = [...arr]
      next[ia] = idB
      next[ib] = idA
      return next
    }

    if (targetIsInput) {
      inputOrder = swap(inputOrder, draggedId, targetId)
    } else {
      returnOrder = swap(returnOrder, draggedId, targetId)
    }

    await invoke('reorder_channels', { inputOrder, returnOrder }).catch(console.error)
    loadConfig()
  }, [config.input_channels, config.return_channels, loadConfig])

  const saveModal = async (updated) => {
    if (updated.isInput) {
      await invoke('update_input_channel_name', { id: updated.id, name: updated.name }).catch(console.error)
    } else {
      await invoke('update_return_channel_name', { id: updated.id, name: updated.name }).catch(console.error)
    }
    await invoke('set_channel_color', { id: updated.id, isInput: updated.isInput, color: updated.color }).catch(console.error)
    setModal(null)
    loadConfig()
  }

  const handleSoloToggle = useCallback((id, isInput) => {
    const key = `${isInput ? 'in' : 'ret'}-${id}`
    setSoloSet(prev => {
      const next = new Set(prev)
      const willActivate = !next.has(key)
      if (willActivate) next.add(key)
      else next.delete(key)
      invoke('set_strip_solo', { id, isInput, solo: willActivate })
        .then(() => loadConfig())
        .catch(console.error)
      return next
    })
  }, [])

  const handleArmToggle = useCallback((id) => {
    setArmedChannels(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const sortedInputs = useMemo(
    () => config.input_channels.slice().sort((a, b) => a.order - b.order),
    [config.input_channels]
  )
  const sortedReturns = useMemo(
    () => config.return_channels.slice().sort((a, b) => a.order - b.order),
    [config.return_channels]
  )

  const stableHandleDragStart = handleDragStart
  const stableHandleDragOver  = handleDragOver
  const stableHandleDragLeave = handleDragLeave
  const stableHandleDragEnd   = handleDragEnd
  const stableHandleDrop      = handleDrop
  const stableSetModal        = useCallback(setModal, [])
  const stableLoadConfig      = useCallback(loadConfig, [])

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#171717] text-neutral-400">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#4169e1] animate-spin" />
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-300 font-mono">Initializing Mixing Engine…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#171717] text-neutral-300 font-sans overflow-hidden">

      {/* ─── Control Bar ─── */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/[0.04] border-b border-white/[0.08] gap-3 h-[42px] shrink-0 text-xs text-neutral-300 select-none">

        <div className="flex items-center gap-3">
          <Activity className="w-3.5 h-3.5 text-[#4169e1]" />
          <span className="text-[10px] font-black tracking-[0.22em] text-neutral-100 uppercase">
            Mixer Console
          </span>
          <span className="text-[9px] font-mono text-neutral-500">
            {sortedInputs.length} in · {sortedReturns.length} ret
          </span>
        </div>

        <div className="flex items-center gap-3">

          <div className="flex items-center gap-1">
            <button
              onClick={openNewInputDialog}
              className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#4169e1]/15 hover:border-[#4169e1]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3 h-3 text-[#4169e1]" />
              Input
            </button>
            <button
              onClick={openNewReturnDialog}
              className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#4169e1]/15 hover:border-[#4169e1]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3 h-3 text-[#4169e1]" />
              Return
            </button>
          </div>

          <span className="h-4 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-2 text-neutral-400">
            <ZoomIn className="w-3.5 h-3.5 text-neutral-500" />
            <input
              type="range"
              min={0.6}
              max={1.8}
              step={0.05}
              value={scale}
              onChange={e => handleScaleChange(e.target.value)}
              className="accent-[#4169e1] h-1 w-20 bg-white/[0.08] rounded-md appearance-none cursor-pointer"
            />
            <span className="text-[9px] text-neutral-400 font-mono font-bold w-7 tabular-nums">{scale.toFixed(2)}×</span>
          </div>

          <span className="h-4 w-px bg-white/[0.08]" />

          <div className="flex items-center gap-1.5 font-mono text-[9px] text-neutral-300 font-bold bg-white/[0.05] border border-white/[0.08] rounded-md px-2.5 h-6 select-none shrink-0">
            <span className={`h-1.5 w-1.5 rounded-full ${cpuLoad > 10 ? 'bg-[#f5b94a]' : 'bg-[#38b868]'} animate-pulse`} />
            <span className="text-neutral-400">CPU</span>
            <span className="text-white tabular-nums">{cpuLoad}%</span>
          </div>
        </div>
      </div>

      {/* ─── Mixer Strips ─── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-3 bg-[#171717] scrollbar-thin scrollbar-thumb-white/10">
        <div className="flex h-full items-start pb-1 w-full justify-between gap-6 min-w-max">

          {/* Inputs Section */}
          {sortedInputs.length > 0 ? (
            <div className="flex flex-col h-full shrink-0">
              <div className="text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500 mb-2 px-1 select-none border-b border-white/[0.04] pb-1 shrink-0">
                Inputs / Entradas
              </div>
              <div className="flex items-start flex-1 bg-black/20 rounded-md border border-white/[0.04] p-1">
                {sortedInputs.map(ch => (
                  <InputStrip
                    key={ch.id}
                    ch={ch}
                    returnChannels={sortedReturns}
                    sends={config.sends}
                    captureNodes={captureNodes}
                    scale={scale}
                    faderVal={getFader(`in-${ch.id}`)}
                    setFader={setFader}
                    onRemoveInput={removeInput}
                    onOpenModal={stableSetModal}
                    onDragStart={stableHandleDragStart}
                    onDragOver={stableHandleDragOver}
                    onDragLeave={stableHandleDragLeave}
                    onDragEnd={stableHandleDragEnd}
                    onDrop={stableHandleDrop}
                    isDragging={draggedInfo && draggedInfo.id === ch.id && draggedInfo.isInput === true}
                    isDragOverTarget={dragOverId === ch.id}
                    soloActive={soloSet.has(`in-${ch.id}`)}
                    onSoloToggle={handleSoloToggle}
                    armed={armedChannels.has(ch.id)}
                    onArmToggle={handleArmToggle}
                    db={peaks[ch.sink_name] ?? -60}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="shrink-0" />
          )}

          {/* Returns & Master Section (Pinned to the right) */}
          {(sortedReturns.length > 0 || config.master_sink !== null || true) && (
            <div className="flex items-start gap-4 h-full ml-auto shrink-0">
              
              {/* Returns */}
              {sortedReturns.length > 0 && (
                <div className="flex flex-col h-full shrink-0">
                  <div className="text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500 mb-2 px-1 select-none border-b border-white/[0.04] pb-1 shrink-0">
                    Returns / Retornos
                  </div>
                  <div className="flex items-start flex-1 bg-black/20 rounded-md border border-white/[0.04] p-1">
                    {sortedReturns.map((ret, idx) => {
                      const letter = String.fromCharCode(65 + idx)
                      return (
                        <ReturnStrip
                          key={ret.id}
                          ret={ret}
                          scale={scale}
                          faderVal={getFader(`ret-${ret.id}`)}
                          setFader={setFader}
                          onRemoveReturn={removeReturn}
                          onOpenModal={stableSetModal}
                          onReload={stableLoadConfig}
                          onDragStart={stableHandleDragStart}
                          onDragOver={stableHandleDragOver}
                          onDragLeave={stableHandleDragLeave}
                          onDragEnd={stableHandleDragEnd}
                          onDrop={stableHandleDrop}
                          isDragging={draggedInfo && draggedInfo.id === ret.id && draggedInfo.isInput === false}
                          isDragOverTarget={dragOverId === ret.id}
                          soloActive={soloSet.has(`ret-${ret.id}`)}
                          onSoloToggle={handleSoloToggle}
                          letter={letter}
                          db={peaks[ret.sink_name] ?? -60}
                        />
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Master */}
              <div className="flex flex-col h-full shrink-0">
                <div className="text-[9px] font-black uppercase tracking-[0.2em] text-[#4169e1] mb-2 px-1 select-none border-b border-[#4169e1]/10 pb-1 shrink-0">
                  Master / Maestro
                </div>
                <div className="flex-1 shrink-0 bg-[#4169e1]/[0.04] rounded-md border border-[#4169e1]/20 p-1">
                  <MasterStrip
                    masterSink={config.master_sink}
                    masterMuted={config.master_muted}
                    sinkNodes={sinkNodes}
                    scale={scale}
                    faderVal={getFader('master')}
                    setFader={setFader}
                    db={peaks['audibian_master'] ?? -60}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {sortedInputs.length === 0 && sortedReturns.length === 0 && (
            <div className="flex-1 flex items-center justify-center h-full pl-6">
              <div className="text-center text-neutral-500">
                <div className="text-[10px] uppercase tracking-widest font-bold mb-2">No channels yet</div>
                <div className="text-[9px] font-mono opacity-60">Add an Input or Return from the toolbar</div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Modals */}
      {modal && (
        <ConfigModal
          modal={modal}
          onSave={saveModal}
          onCancel={() => setModal(null)}
        />
      )}

      {newInputDialog !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setNewInputDialog(null)}>
          <div className="bg-[#1f1f1f] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4 animate-in fade-in duration-100" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#4169e1]" />
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-neutral-100">New Virtual Channel</span>
              </div>
              <button onClick={() => setNewInputDialog(null)} className="text-neutral-500 hover:text-neutral-200 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">Channel Name</label>
              <input
                type="text"
                value={newInputDialog}
                onChange={e => setNewInputDialog(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmAddInput(); if (e.key === 'Escape') setNewInputDialog(null) }}
                autoFocus
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1] w-full font-sans"
              />
              <div className="text-[8px] text-neutral-500 font-mono">
                sink: audibian_{newInputDialog.trim().toLowerCase().replace(/[^a-z0-9]/g, '_') || '…'}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3">
              <button
                onClick={() => setNewInputDialog(null)}
                className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAddInput}
                className="bg-[#4169e1] hover:bg-[#5478e8] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors shadow-[0_1px_3px_rgba(65,105,225,0.35)]"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {newReturnDialog !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setNewReturnDialog(null)}>
          <div className="bg-[#1f1f1f] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4 animate-in fade-in duration-100" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#4169e1]" />
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-neutral-100">New Return Channel</span>
              </div>
              <button onClick={() => setNewReturnDialog(null)} className="text-neutral-500 hover:text-neutral-200 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">Channel Name</label>
              <input
                type="text"
                value={newReturnDialog}
                onChange={e => setNewReturnDialog(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmAddReturn(); if (e.key === 'Escape') setNewReturnDialog(null) }}
                autoFocus
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1] w-full font-sans"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3">
              <button
                onClick={() => setNewReturnDialog(null)}
                className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAddReturn}
                className="bg-[#4169e1] hover:bg-[#5478e8] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors shadow-[0_1px_3px_rgba(65,105,225,0.35)]"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
