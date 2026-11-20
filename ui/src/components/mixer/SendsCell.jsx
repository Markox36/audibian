import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus } from 'lucide-react'
import { FAINT, GREEN, GREEN_DIM, RAIL_TEXT } from './theme'
import { createRafSend } from './rafSend'

// One send: toggle chip + level slider (set_send_level), shared by input and
// MIDI strips.
function SendRow({ chId, ret, letter, active, level, onError }) {
  const [lvl, setLvl] = useState(level)
  useEffect(() => { setLvl(level) }, [level])
  const sender = useRef(null)
  if (!sender.current) sender.current = createRafSend()
  const pct = Number.isFinite(lvl) ? Math.round(lvl * 100) : 100

  return (
    <div className="flex items-center gap-1 w-full h-[18px]">
      <button
        onClick={() => invoke('toggle_send', { inputId: chId, returnId: ret.id, active: !active }).catch(onError)}
        title={`Send a ${ret.name}`}
        aria-pressed={active}
        className="w-[18px] h-full shrink-0 text-[8px] font-bold uppercase rounded-sm transition-all"
        style={{
          backgroundColor: active ? `${GREEN}22` : 'transparent',
          color: active ? GREEN : RAIL_TEXT,
          border: `1px solid ${active ? GREEN_DIM : FAINT}`,
        }}
      >
        {letter}
      </button>
      <input
        type="range" min={0} max={1} step={0.01}
        value={Number.isFinite(lvl) ? Math.min(lvl, 1) : 1}
        disabled={!active}
        aria-label={`Nivel del send a ${ret.name}`}
        aria-valuetext={`${pct}%`}
        title={active ? `Nivel del send: ${pct}%` : 'Activa el send para ajustar su nivel'}
        onChange={e => {
          const v = parseFloat(e.target.value)
          if (!Number.isFinite(v)) return
          setLvl(v)
          sender.current.queue(() =>
            invoke('set_send_level', { inputId: chId, returnId: ret.id, level: v }).catch(onError))
        }}
        onPointerUp={() => sender.current.flush()}
        onBlur={() => sender.current.flush()}
        className="flex-1 min-w-0 h-full cursor-pointer disabled:opacity-25 disabled:cursor-default"
        style={{ accentColor: GREEN }}
      />
    </div>
  )
}

// Row 2 of an input/MIDI strip. `toMaster` null = backend offers no toggle.
function SendsCell({ chId, returnChannels, sends, toMaster, onToggleMaster, onError }) {
  const sorted = returnChannels.slice().sort((a, b) => a.order - b.order)
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-1 py-1 h-full w-full bg-white/[0.05] border border-white/[0.11] rounded-sm">
      <button
        onClick={onToggleMaster}
        disabled={!onToggleMaster}
        aria-pressed={!!toMaster}
        title={onToggleMaster
          ? (toMaster ? 'Va directo al master: clic para excluirla' : 'Excluida del master: clic para enviarla')
          : (toMaster ? 'Va directo al master' : 'Excluida del master')}
        className="w-full h-[18px] shrink-0 text-[8px] font-bold tracking-wider uppercase rounded-sm transition-all"
        style={{
          backgroundColor: toMaster ? `${GREEN}22` : 'transparent',
          color: toMaster ? GREEN : '#ff9b9d',
          border: `1px solid ${toMaster ? GREEN_DIM : 'rgba(255,107,110,0.45)'}`,
        }}
      >
        {toMaster ? '→ master' : 'sin master'}
      </button>
      {sorted.length === 0 ? (
        <div
          className="w-full h-[18px] rounded-sm flex items-center justify-center"
          style={{ color: RAIL_TEXT, border: `1px dashed ${FAINT}` }}
          title="No hay returns"
        >
          <Plus className="w-3 h-3" />
        </div>
      ) : sorted.map((ret, idx) => {
        const s = sends.find(s => s.input_channel_id === chId && s.return_channel_id === ret.id)
        return (
          <SendRow
            key={ret.id} chId={chId} ret={ret} letter={String.fromCharCode(65 + idx)}
            active={!!s} level={typeof s?.level === 'number' ? s.level : 1} onError={onError}
          />
        )
      })}
    </div>
  )
}

export { SendsCell }
