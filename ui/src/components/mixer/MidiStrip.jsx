import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus, X, Sparkles } from 'lucide-react'
import { CREAM, FAINT, GREEN, GREEN_DIM, RAIL_TEXT, RED, autoColor, faderToDb } from './theme'
import { MeterFader } from './MeterFader'
import { subscribeReadout } from './meterStore'
import { PanKnob } from './PanKnob'
import { StripFrame } from './StripShell'


// MIDI/plugin channel strip. Same shape as InputStrip minus the source
// select (has Sends to return channels, same as an input strip) plus a
// clickable plugin badge that opens the shared device footer at the bottom
// of the Mixer — same interaction as clicking a track in Ableton Live's
// Session/Arrangement view to show its device chain below.
const MidiStrip = React.memo(function MidiStrip({
  ch, returnChannels, sends, loaded, selected, onSelect,
  faderVal, setFader,
  onRemove,
  soloActive, onSoloToggle, onError, onFaderDrag,
}) {
  const accent = ch.color || autoColor(ch.id + 90)
  const faderKey = `midi-${ch.id}`
  const [muted, setMuted] = useState(ch.muted)
  useEffect(() => { setMuted(ch.muted) }, [ch.muted])

  // Written directly by the meter store; see meterStore.js.
  const readoutRef = useRef(null)
  useEffect(
    () => subscribeReadout(ch.sink_name, readoutRef.current),
    [ch.sink_name]
  )

  const plugin = ch.plugins?.[0]
  const faderTxt = faderToDb(faderVal)

  return (
    <StripFrame accent={accent} editing={selected} dragClasses="">
      {/* Row 1 — name */}
      {/* Plain container: it holds the name <input>, which cannot live inside
          a <button>. Selecting the channel is the plugin badge below. */}
      <div className="flex items-center gap-1 px-1 h-full w-full bg-white/[0.09] border border-white/[0.11] rounded-sm">
        <input
          defaultValue={ch.name}
          key={ch.name}
          onBlur={e => invoke('midi_channel_rename', { id: ch.id, name: e.target.value }).catch(onError)}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          className="bg-transparent text-[10px] font-semibold text-center flex-1 min-w-0 focus:outline-none focus:bg-white/[0.05] rounded-sm py-0.5 truncate"
          style={{ color: CREAM }}
        />
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

      {/* Row 3 — Plugin badge + load state, click opens the device footer */}
      <button
        onClick={onSelect}
        className="flex items-center justify-between gap-1 h-full w-full px-1 bg-white/[0.05] border border-white/[0.11] rounded-sm transition-colors hover:bg-white/[0.08]"
        title={plugin ? plugin.name : 'Add a plugin'}
      >
        <span className="flex items-center gap-1 min-w-0">
          <Sparkles className="w-3 h-3 shrink-0" style={{ color: plugin ? accent : RAIL_TEXT }} />
          <span
            className="text-[9px] font-semibold truncate"
            style={{ color: plugin ? CREAM : RAIL_TEXT }}
          >
            {plugin ? plugin.name : 'Add Plugin'}
          </span>
        </span>
        <span
          className="text-[8px] font-bold uppercase tracking-wider shrink-0"
          style={{ color: loaded ? GREEN : RAIL_TEXT }}
        >
          {loaded ? '● Live' : plugin ? '○ Idle' : '—'}
        </span>
      </button>

      {/* Row 4 — Pan */}
      <div className="w-full h-full flex items-center justify-center bg-white/[0.05] border border-white/[0.11] rounded-sm py-1">
        <PanKnob
          value={ch.pan ?? 0}
          label={`Pan ${ch.name}`}
          onChange={(p) => invoke('midi_channel_set_pan', { id: ch.id, pan: p }).catch(onError)}
        />
      </div>

      {/* Row 5 — Volume readouts */}
      <div className="grid grid-cols-2 gap-1 w-full h-full">
        <button
          onDoubleClick={() => {
            setFader(faderKey, 100)
            invoke('midi_channel_set_volume', { id: ch.id, volume: 1.0 }).catch(onError)
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
          onCommit={v => invoke('midi_channel_set_volume', { id: ch.id, volume: v / 100 }).catch(onError)}
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
            invoke('midi_channel_set_mute', { id: ch.id, muted: next })
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
