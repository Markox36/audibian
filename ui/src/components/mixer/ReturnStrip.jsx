import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Settings, X, GripVertical } from 'lucide-react'
import { CREAM, FAINT, GREEN, RAIL_TEXT, RED, autoColor, faderToDb } from './theme'
import { MeterFader } from './MeterFader'
import { subscribeReadout } from './meterStore'
import { PanKnob } from './PanKnob'
import { CellLabel, StripFrame } from './StripShell'


const ReturnStrip = React.memo(function ReturnStrip({
  ret,
  faderVal, setFader,
  onRemoveReturn, onOpenModal,
  onDragStart, onDragOver, onDragLeave, onDragEnd, onDrop,
  isDragging, isDragOverTarget,
  soloActive, onSoloToggle,
  letter, onError, onFaderDrag,
}) {
  const accent = ret.color || autoColor(ret.id + 180)
  const faderKey = `ret-${ret.id}`
  const [muted, setMuted] = useState(ret.muted)
  useEffect(() => { setMuted(ret.muted) }, [ret.muted])

  // Written directly by the meter store; see meterStore.js.
  const readoutRef = useRef(null)
  useEffect(
    () => subscribeReadout(ret.sink_name, readoutRef.current),
    [ret.sink_name]
  )

  const dragClasses = isDragging ? 'opacity-30' : isDragOverTarget ? 'ring-1 ring-white/40' : ''
  const faderTxt = faderToDb(faderVal)

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
      <div className="flex items-center gap-1 px-1 h-full w-full bg-white/[0.09] border border-white/[0.11] rounded-sm">
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
          onBlur={e => invoke('update_return_channel_name', { id: ret.id, name: e.target.value }).catch(onError)}
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
        className="flex items-center justify-center h-full w-full text-[10px] font-black tracking-widest bg-white/[0.05] border border-white/[0.11] rounded-sm"
        style={{ color: accent }}
      >
        {letter}
      </div>

      {/* Row 3 — Output (BUS label) */}
      <div className="h-full w-full">
        <CellLabel>BUS</CellLabel>
      </div>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-white/[0.05] border border-white/[0.11] rounded-sm py-1">
        <PanKnob
          value={ret.pan ?? 0}
          label={`Pan ${ret.name}`}
          onChange={(p) => invoke('set_strip_pan', { id: ret.id, isInput: false, pan: p }).catch(onError)}
        />
      </div>

      {/* Row 5 — Volume */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <button
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('set_strip_volume', { id: ret.id, isInput: false, volume: 1.0 }).catch(onError)
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
          label={`Volume ${ret.name}`}
          onChange={v => setFader(faderKey, v)}
          onCommit={v => invoke('set_strip_volume', { id: ret.id, isInput: false, volume: v / 100 }).catch(onError)}
          onDragState={active => onFaderDrag(faderKey, active)}
          nodeName={ret.sink_name}
        />
      </div>

      {/* Row 7 — Exclude */}
      <div className="flex items-center justify-center gap-1 w-full h-full">
        <button
          onClick={() => {
            const next = !muted
            setMuted(next)
            invoke('set_strip_mute', { id: ret.id, isInput: false, muted: next })
              .catch(e => { setMuted(!next); onError(e) })
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

export { ReturnStrip }
