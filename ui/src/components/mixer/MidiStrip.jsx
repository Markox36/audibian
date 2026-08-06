import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { X, Sparkles } from 'lucide-react'
import { CREAM, FAINT, GREEN, RAIL_TEXT, RED, autoColor, faderToDb } from './theme'
import { MeterFader } from './MeterFader'
import { PanKnob } from './PanKnob'
import { StripFrame } from './StripShell'


// MIDI/plugin channel strip. Same shape as ReturnStrip (no sends, no
// source select) plus a clickable plugin badge that opens the shared
// device footer at the bottom of the Mixer — same interaction as clicking
// a track in Ableton Live's Session/Arrangement view to show its device
// chain below.
const MidiStrip = React.memo(function MidiStrip({
  ch, loaded, selected, onSelect,
  faderVal, setFader,
  onRemove,
  soloActive, onSoloToggle,
  dbL, dbR,
}) {
  const accent = ch.color || autoColor(ch.id + 90)
  const faderKey = `midi-${ch.id}`
  const [muted, setMuted] = useState(ch.muted)
  useEffect(() => { setMuted(ch.muted) }, [ch.muted])

  const plugin = ch.plugins?.[0]
  const peakDbDisplay = Math.max(dbL ?? -60, dbR ?? -60)
  const peakTxt = peakDbDisplay <= -59.5 ? '-inf' : peakDbDisplay.toFixed(1)
  const faderTxt = faderToDb(faderVal)
  const clipping = peakDbDisplay > -0.5

  return (
    <StripFrame accent={accent} editing={selected} dragClasses="">
      {/* Row 1 — name */}
      <div
        onClick={onSelect}
        className="flex items-center gap-1 px-1 h-full w-full bg-white/[0.09] border border-white/[0.11] rounded-sm cursor-pointer"
      >
        <input
          defaultValue={ch.name}
          key={ch.name}
          onBlur={e => invoke('midi_channel_rename', { id: ch.id, name: e.target.value }).catch(console.error)}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          className="bg-transparent text-[10px] font-semibold text-center flex-1 min-w-0 focus:outline-none focus:bg-white/[0.05] rounded-sm py-0.5 truncate"
          style={{ color: CREAM }}
        />
      </div>

      {/* Row 2 — Plugin badge, click opens the device footer */}
      <button
        onClick={onSelect}
        className="flex items-center justify-center gap-1 h-full w-full px-1 bg-white/[0.05] border border-white/[0.11] rounded-sm transition-colors hover:bg-white/[0.08]"
        title={plugin ? plugin.name : 'Add a plugin'}
      >
        <Sparkles className="w-3 h-3 shrink-0" style={{ color: plugin ? accent : RAIL_TEXT }} />
        <span
          className="text-[9px] font-semibold truncate"
          style={{ color: plugin ? CREAM : RAIL_TEXT }}
        >
          {plugin ? plugin.name : 'Add Plugin'}
        </span>
      </button>

      {/* Row 3 — Load state */}
      <div
        className="flex items-center justify-center h-full w-full text-[8px] font-bold uppercase tracking-wider bg-white/[0.05] border border-white/[0.11] rounded-sm"
        style={{ color: loaded ? GREEN : RAIL_TEXT }}
      >
        {loaded ? '● Live' : plugin ? '○ Idle' : '—'}
      </div>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-white/[0.05] border border-white/[0.11] rounded-sm py-1">
        <PanKnob
          value={ch.pan ?? 0}
          onChange={(p) => invoke('midi_channel_set_pan', { id: ch.id, pan: p }).catch(console.error)}
        />
      </div>

      {/* Row 5 — Volume readouts */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <div
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('midi_channel_set_volume', { id: ch.id, volume: 1.0 }).catch(console.error)
          }}
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm cursor-pointer tabular-nums bg-white/[0.05] border border-white/[0.11] hover:bg-white/[0.10] transition-colors"
          style={{ color: CREAM }}
        >
          {faderTxt}
        </div>
        <div
          className="text-[8.5px] font-mono text-center flex items-center justify-center rounded-sm tabular-nums border border-white/[0.11]"
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
            invoke('midi_channel_set_volume', { id: ch.id, volume: v / 100 }).catch(console.error)
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
            invoke('midi_channel_set_mute', { id: ch.id, muted: next }).catch(console.error)
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
          onClick={() => onSoloToggle(ch.id)}
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
          onClick={() => onRemove(ch.id)}
          className="w-5 h-6 rounded-sm hover:text-rose-400 flex items-center justify-center transition-colors"
          style={{ color: RAIL_TEXT, border: `1px solid ${FAINT}` }}
        >
          <X className="w-3 h-3 mx-auto" />
        </button>
      </div>
    </StripFrame>
  )
})

export { MidiStrip }
