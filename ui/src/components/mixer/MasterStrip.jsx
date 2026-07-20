import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CREAM, GREEN, GREEN_DIM, RAIL_TEXT, RED, faderToDb } from './theme'
import { MeterFader } from './MeterFader'
import { PanKnob } from './PanKnob'
import { StripFrame } from './StripShell'


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

export { MasterStrip }
