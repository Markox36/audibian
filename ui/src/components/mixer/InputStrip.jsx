import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Settings, Plus, X, GripVertical } from 'lucide-react'
import { CREAM, FAINT, GREEN, GREEN_DIM, RAIL_TEXT, RED, autoColor, faderToDb } from './theme'
import { MeterFader } from './MeterFader'
import { subscribeReadout } from './meterStore'
import { PanKnob } from './PanKnob'
import { StripFrame } from './StripShell'


const InputStrip = React.memo(function InputStrip({
  ch, returnChannels, sends, captureNodes,
  faderVal, setFader,
  onRemoveInput, onOpenModal,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  onMonoToggle, onError, onFaderDrag,
}) {
  const accent = ch.color || autoColor(ch.id)
  const faderKey = `in-${ch.id}`
  const [muted, setMuted] = useState(ch.muted)
  useEffect(() => { setMuted(ch.muted) }, [ch.muted])

  // Peak text and clip colour are written straight to this node by the meter
  // store — keeping them out of props is what stops a level change from
  // re-rendering the strip. See meterStore.js.
  const readoutRef = useRef(null)
  useEffect(
    () => subscribeReadout(ch.sink_name, readoutRef.current),
    [ch.sink_name]
  )

  const dragClasses = isDragging
    ? 'opacity-30'
    : isDragOverTarget
    ? 'ring-1 ring-white/40'
    : ''

  const faderTxt = faderToDb(faderVal)
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
      <div className="flex items-center gap-1 px-1 h-full w-full bg-white/[0.09] border border-white/[0.11] rounded-sm">
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
          onBlur={e => invoke('update_input_channel_name', { id: ch.id, name: e.target.value }).catch(onError)}
          onMouseDown={e => e.stopPropagation()}
          className="bg-transparent text-[10px] font-semibold text-center flex-1 min-w-0 focus:outline-none focus:bg-white/[0.05] rounded-sm py-0.5 truncate"
          style={{ color: CREAM }}
        />
        <button
          onClick={() => onMonoToggle(ch.id, !ch.mono)}
          aria-label="Mono input"
          aria-pressed={!!ch.mono}
          className="shrink-0 text-[7px] font-bold leading-none tracking-tight px-1 py-1 rounded-sm transition-colors"
          style={{
            backgroundColor: ch.mono ? `${GREEN}22` : 'transparent',
            color: ch.mono ? GREEN : RAIL_TEXT,
            border: `1px solid ${ch.mono ? GREEN_DIM : FAINT}`,
          }}
          title={ch.mono ? 'Disable mono input' : 'Enable mono input'}
        >
          MONO
        </button>
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
        className="flex flex-col items-center justify-center gap-1 px-1 py-1 h-full w-full bg-white/[0.05] border border-white/[0.11] rounded-sm"
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
                onClick={() => invoke('toggle_send', { inputId: ch.id, returnId: ret.id, active: !active }).catch(onError)}
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
      <div className="h-full w-full bg-white/[0.05] border border-white/[0.11] rounded-sm overflow-hidden flex items-center">
        <select
          value={ch.source_name || ''}
          onChange={e => invoke('set_input_source', { id: ch.id, sourceName: e.target.value || null }).catch(onError)}
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
      <div className="w-full h-full flex items-center justify-center bg-white/[0.05] border border-white/[0.11] rounded-sm py-1">
        <PanKnob
          value={ch.pan ?? 0}
          label={`Pan ${ch.name}`}
          onChange={(p) => invoke('set_strip_pan', { id: ch.id, isInput: true, pan: p }).catch(onError)}
        />
      </div>

      {/* Row 5 — Volume readouts */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <button
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('set_strip_volume', { id: ch.id, isInput: true, volume: 1.0 }).catch(onError)
          }}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm cursor-pointer tabular-nums bg-white/[0.05] border border-white/[0.11] hover:bg-white/[0.10] transition-colors"
          style={{ color: CREAM }}
          title="Volume — double-click to reset"
        >
          {faderTxt}
        </button>
        <div
          ref={readoutRef}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm tabular-nums border border-white/[0.11]"
          style={{ backgroundColor: 'rgba(0,0,0,0.25)', color: GREEN }}
          title="Peak (L+R max)"
        >
          -inf
        </div>
      </div>

      {/* Row 6 — Meter */}
      <div className="h-full w-full min-h-0 relative">
        <MeterFader
          value={faderVal}
          label={`Volume ${ch.name}`}
          onChange={v => setFader(faderKey, v)}
          onCommit={v => invoke('set_strip_volume', { id: ch.id, isInput: true, volume: v / 100 }).catch(onError)}
          onDragState={active => onFaderDrag(faderKey, active)}
          nodeName={ch.sink_name}
        />
      </div>

      {/* Row 7 — Exclude */}
      <div className="flex items-center justify-center gap-1 w-full h-full">
        <button
          onClick={() => {
            const next = !muted
            setMuted(next)
            invoke('set_strip_mute', { id: ch.id, isInput: true, muted: next })
              .catch(e => { setMuted(!next); onError(e) })
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

export { InputStrip }
