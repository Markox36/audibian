import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Plus, Sparkles, X, Activity, ArrowRight, ArrowDown } from 'lucide-react'
import { CREAM, FAINT, GREEN, GREEN_DIM, GRID_MAX_HEIGHT, PANEL_BG, RAIL_TEXT, RAIL_WIDTH, STRIP_BG, STRIP_WIDTH, gridTemplate, sendsRowHeight } from './theme'
import { ConfigModal } from './ConfigModal'
import { HeaderRail } from './HeaderRail'
import { InputStrip } from './InputStrip'
import { MasterStrip } from './MasterStrip'
import { MidiStrip } from './MidiStrip'
import { PluginFooter } from './PluginFooter'
import { ReturnStrip } from './ReturnStrip'

const LANE_H = 28

// Bordered block of the flow: caption + a strip grid with the shared rows.
function FlowBlock({ title, caption, template, columns, accent, style, className = '', children }) {
  return (
    <section
      className={`flex flex-col min-h-0 rounded-xl border bg-white/[0.02] ${className}`}
      style={{ borderColor: accent ? GREEN_DIM : 'rgba(255,255,255,0.08)', ...style }}
    >
      <header className="flex items-baseline gap-2 px-3 pt-2 pb-1 shrink-0 select-none">
        <span className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: accent ? GREEN : CREAM }}>{title}</span>
        <span className="text-[8px] uppercase tracking-wider" style={{ color: RAIL_TEXT }}>{caption}</span>
      </header>
      <div
        className="flex-1 min-h-0"
        style={{
          display: 'grid',
          gridTemplateRows: template,
          gridAutoFlow: 'column',
          gridTemplateColumns: columns,
          alignContent: 'start',
          padding: '0.25em 0.75em 0.75em 0.75em',
          rowGap: 4,
          columnGap: 8,
        }}
      >
        {children}
      </div>
    </section>
  )
}

export default function Mixer({ graph }) {
  const [config, setConfig] = useState({
    input_channels: [],
    return_channels: [],
    midi_channels: [],
    sends: [],
    master_sink: null,
    master_pan: 0,
    global_scale: 1.0,
  })
  const [loading, setLoading] = useState(true)
  // No peak state here on purpose: meter levels bypass React entirely and are
  // written to the DOM by meterStore.js. Putting them in state re-rendered the
  // whole mixer at display rate. See meterStore.js.
  const [faderValues, setFaderValues] = useState({})
  const [error, setError] = useState('')
  // Key of the fader being dragged right now: its value must not be
  // overwritten by a config reload mid-gesture.
  const draggingKeyRef = useRef(null)
  const [modal, setModal] = useState(null)
  const [newInputDialog, setNewInputDialog] = useState(null)
  const [newReturnDialog, setNewReturnDialog] = useState(null)
  const [soloSet, setSoloSet] = useState(new Set())
  const [draggedInfo, setDraggedInfo] = useState(null)
  const [dragOverId, setDragOverId] = useState(null)
  const [selectedMidiId, setSelectedMidiId] = useState(null)
  const [loadedMidiIds, setLoadedMidiIds] = useState(new Set())

  const refreshLoadedMidi = () => {
    invoke('midi_loaded_channel_ids').then(ids => setLoadedMidiIds(new Set(ids))).catch(console.error)
  }

  const loadConfig = () => {
    invoke('get_mixer_config').then(cfg => {
      setConfig(cfg)
      setFaderValues(prev => {
        // Always take the backend's value, so external changes (pavucontrol,
        // an applied profile) land in the UI. The dragged fader is the one
        // exception: the pointer owns it until the drag ends.
        const next = { ...prev }
        const put = (k, fader) => {
          if (k !== draggingKeyRef.current && typeof fader === 'number') next[k] = fader * 100
        }
        for (const c of cfg.input_channels || []) put(`in-${c.id}`, c.fader)
        for (const r of cfg.return_channels || []) put(`ret-${r.id}`, r.fader)
        for (const m of cfg.midi_channels || []) put(`midi-${m.id}`, m.fader)
        put('master', cfg.master_fader)
        return next
      })
      setLoading(false)
    }).catch(console.error)
    invoke('get_solo_set').then(keys => setSoloSet(new Set(keys))).catch(console.error)
    refreshLoadedMidi()
  }

  // A strip rejected by the backend leaves the UI showing a value that never
  // took: show it and resync from the backend.
  const handleError = useCallback((e) => {
    setError(String(e))
    loadConfig()
  }, [])

  const onFaderDrag = useCallback((key, active) => {
    draggingKeyRef.current = active ? key : null
  }, [])

  useEffect(() => {
    loadConfig()
    // Launching an app floods these events; one reload per burst is enough.
    let timer = 0
    const reload = () => {
      clearTimeout(timer)
      timer = setTimeout(loadConfig, 150)
    }
    const subs = Promise.all([
      listen('pw-node-added', reload),
      listen('pw-node-removed', reload),
    ])
    return () => {
      clearTimeout(timer)
      subs.then(us => us.forEach(u => u()))
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
  const handleMonoToggle = useCallback(async (id, mono) => {
    await invoke('set_input_mono', { id, mono }).catch(console.error)
    loadConfig()
  }, [])

  // Mirrors `draggedInfo` so the dragover handler can read it without a state
  // updater (React may run those twice).
  const draggedInfoRef = useRef(null)
  const handleDragStart = useCallback((e, id, isInput) => {
    e.dataTransfer.setData('channelId', id)
    e.dataTransfer.setData('isInput', isInput ? '1' : '0')
    draggedInfoRef.current = { id, isInput }
    setDraggedInfo({ id, isInput })
  }, [])
  const handleDragEnd = useCallback(() => { draggedInfoRef.current = null; setDraggedInfo(null); setDragOverId(null) }, [])
  const handleDragOver = useCallback((e, id, isInput) => {
    e.preventDefault()
    const curr = draggedInfoRef.current
    if (curr && curr.isInput === isInput && curr.id !== id) setDragOverId(id)
  }, [])
  const handleDragLeave = useCallback((e, id) => {
    setDragOverId(curr => (curr === id ? null : curr))
  }, [])
  const handleDrop = useCallback(async (e, targetId, targetIsInput) => {
    const draggedId = parseInt(e.dataTransfer.getData('channelId'))
    const draggedIsInput = e.dataTransfer.getData('isInput') === '1'
    draggedInfoRef.current = null
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
    const willActivate = !soloSet.has(key)
    const next = new Set(soloSet)
    if (willActivate) next.add(key); else next.delete(key)
    setSoloSet(next)
    invoke('set_strip_solo', { id, isInput, solo: willActivate })
      .then(() => loadConfig())
      .catch(e => { setSoloSet(soloSet); handleError(e) })
  }, [soloSet, handleError])

  const handleMidiSoloToggle = useCallback((id) => {
    const key = `midi-${id}`
    const willActivate = !soloSet.has(key)
    const next = new Set(soloSet)
    if (willActivate) next.add(key); else next.delete(key)
    setSoloSet(next)
    invoke('midi_channel_set_solo', { id, solo: willActivate })
      .then(() => loadConfig())
      .catch(e => { setSoloSet(soloSet); handleError(e) })
  }, [soloSet, handleError])

  const handleMidiRemove = useCallback((id) => {
    invoke('midi_channel_remove', { id }).then(() => {
      setSelectedMidiId(sel => sel === id ? null : sel)
      loadConfig()
    }).catch(console.error)
  }, [])

  const sortedInputs = useMemo(() => config.input_channels.slice().sort((a, b) => a.order - b.order), [config.input_channels])
  const sortedReturns = useMemo(() => config.return_channels.slice().sort((a, b) => a.order - b.order), [config.return_channels])
  const sortedMidi = useMemo(() => (config.midi_channels || []).slice().sort((a, b) => a.order - b.order), [config.midi_channels])
  // The sends row grows with the number of returns; keep the flow height cap in step.
  const template = useMemo(() => gridTemplate(sortedReturns.length), [sortedReturns.length])
  const flowMaxHeight = `calc(${GRID_MAX_HEIGHT} + ${LANE_H + 40 + sendsRowHeight(sortedReturns.length) - 64}px)`
  const excludedCount = sortedInputs.filter(c => c.send_to_master === false).length + sortedMidi.filter(c => c.send_to_master === false).length
  const selectedMidiChannel = sortedMidi.find(c => c.id === selectedMidiId) || null

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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ backgroundColor: PANEL_BG, color: CREAM }}>

      {/* ─── Control Bar ─── */}
      <div className="flex flex-wrap items-center justify-between px-3 sm:px-4 py-1.5 gap-2 sm:gap-3 min-h-[42px] shrink-0 text-xs select-none border-b border-white/[0.05]">
        <div className="flex items-center gap-3 shrink-0">
          <Activity className="w-3.5 h-3.5" style={{ color: GREEN }} />
          <span className="text-[10px] font-black tracking-[0.22em] uppercase" style={{ color: CREAM }}>Mixer</span>
          <span className="text-[9px] font-mono" style={{ color: RAIL_TEXT }}>
            {sortedInputs.length} in · {sortedMidi.length} midi · {sortedReturns.length} ret
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
            onClick={() => invoke('midi_channel_add', { name: `MIDI ${sortedMidi.length + 1}` }).then(loadConfig).catch(console.error)}
            className="text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md flex items-center gap-1.5"
            style={{ backgroundColor: STRIP_BG, color: CREAM, border: `1px solid ${FAINT}` }}
          >
            <Plus className="w-3 h-3" style={{ color: GREEN }} />
            MIDI
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

      {error && (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-sm border border-[#ff6b6e]/40 bg-[#ff6b6e]/10 px-3 py-2 text-[10px] text-[#ff9b9d]"
        >
          {error}
        </div>
      )}

      {/* ─── Flujo: ENTRADAS → RETURNS (sends) · ENTRADAS → MASTER (directo) ───
          Un solo scroll horizontal; el bloque MASTER es sticky a la derecha.
          Los returns NO se enrutan al master (son fuente virtual para apps). */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden" style={{ backgroundColor: PANEL_BG }}>
        <div
          className="h-full"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 72px auto minmax(40px, 1fr) auto',
            gridTemplateRows: `${LANE_H}px minmax(0, 1fr)`,
            alignContent: 'start',
            maxHeight: flowMaxHeight,
            padding: '0.5em 1em 1em 1em',
            minWidth: 'max-content',
          }}
        >
          {/* Carril master: camino directo entradas → master por encima de los returns. */}
          <div style={{ gridColumn: '1 / 5', gridRow: 1, display: 'grid', gridTemplateColumns: 'subgrid' }} aria-hidden="true">
            <div className="relative">
              <div className="absolute right-6 bottom-0 w-px" style={{ top: LANE_H / 2, backgroundColor: GREEN_DIM }} />
              <div className="absolute right-0" style={{ width: 24, top: LANE_H / 2, height: 1, backgroundColor: GREEN_DIM }} />
            </div>
            <div className="relative"><div className="absolute inset-x-0" style={{ top: LANE_H / 2, height: 1, backgroundColor: GREEN_DIM }} /></div>
            <div className="relative">
              <div className="absolute inset-x-0" style={{ top: LANE_H / 2, height: 1, backgroundColor: GREEN_DIM }} />
              <span
                className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap px-2 text-[8px] font-bold uppercase tracking-[0.2em]"
                style={{ top: LANE_H / 2 - 6, color: GREEN, backgroundColor: PANEL_BG }}
              >
                master · directo, sin pasar por returns
              </span>
            </div>
            <div className="relative"><div className="absolute inset-x-0" style={{ top: LANE_H / 2, height: 1, backgroundColor: GREEN_DIM }} /></div>
          </div>

          {/* ENTRADAS */}
          <FlowBlock
            style={{ gridColumn: 1, gridRow: 2 }}
            title="Entradas"
            caption={`fuentes y MIDI${excludedCount ? ` · ${excludedCount} fuera de master` : ''}`}
            template={template}
            columns={[RAIL_WIDTH, `repeat(${sortedInputs.length + sortedMidi.length}, ${STRIP_WIDTH})`].join(' ')}
          >
            <HeaderRail />

            {sortedInputs.map(ch => {
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
                  onMonoToggle={handleMonoToggle}
                  onError={handleError}
                  onFaderDrag={onFaderDrag}
                />
              )
            })}

            {sortedMidi.map(ch => {
              return (
                <MidiStrip
                  key={ch.id}
                  ch={ch}
                  returnChannels={sortedReturns}
                  sends={config.sends}
                  loaded={loadedMidiIds.has(ch.id)}
                  selected={selectedMidiId === ch.id}
                  onSelect={() => setSelectedMidiId(sel => sel === ch.id ? null : ch.id)}
                  faderVal={getFader(`midi-${ch.id}`)}
                  setFader={setFader}
                  onRemove={handleMidiRemove}
                  soloActive={soloSet.has(`midi-${ch.id}`)}
                  onSoloToggle={handleMidiSoloToggle}
                  onError={handleError}
                  onFaderDrag={onFaderDrag}
                />
              )
            })}
          </FlowBlock>

          {/* Conector ENTRADAS → RETURNS */}
          <div className="flex flex-col items-center justify-center gap-1 select-none" style={{ gridColumn: 2, gridRow: 2 }} aria-hidden="true">
            <span className="text-[8px] font-bold uppercase tracking-[0.2em]" style={{ color: RAIL_TEXT }}>sends</span>
            <ArrowRight className="w-5 h-5" style={{ color: RAIL_TEXT }} />
          </div>

          {/* RETURNS */}
          <FlowBlock
            style={{ gridColumn: 3, gridRow: 2 }}
            title="Returns"
            caption="fuente virtual para apps"
            template={template}
            columns={`repeat(${Math.max(sortedReturns.length, 1)}, ${STRIP_WIDTH})`}
          >
            {sortedReturns.map((ret, idx) => {
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
                  onError={handleError}
                  onFaderDrag={onFaderDrag}
                />
              )
            })}
            {sortedReturns.length === 0 && (
              <div className="row-span-7 flex items-center justify-center text-[9px] text-center px-2" style={{ gridRow: '1 / -1', color: RAIL_TEXT }}>
                Sin returns. Añade uno con «+ Return».
              </div>
            )}
          </FlowBlock>

          {/* MASTER: sticky; el camino directo baja hasta él. */}
          <div className="flex flex-col sticky right-0 pl-2" style={{ gridColumn: 5, gridRow: '1 / 3', backgroundColor: PANEL_BG, zIndex: 5 }}>
            <div className="relative shrink-0" style={{ height: LANE_H }} aria-hidden="true">
              <div className="absolute left-0" style={{ width: '50%', top: LANE_H / 2, height: 1, backgroundColor: GREEN_DIM }} />
              <div className="absolute w-px" style={{ left: '50%', top: LANE_H / 2, bottom: 0, backgroundColor: GREEN_DIM }} />
              <ArrowDown className="absolute w-3 h-3" style={{ left: '50%', bottom: -2, transform: 'translateX(-50%)', color: GREEN }} />
            </div>
            <FlowBlock
              className="flex-1 min-h-0"
              title="Master"
              caption="salida final"
              template={template}
              columns={STRIP_WIDTH}
              accent
            >
            <MasterStrip
              masterSink={config.master_sink}
              masterMuted={config.master_muted}
              masterPan={config.master_pan}
              sinkNodes={sinkNodes}
              faderVal={getFader('master')}
              setFader={setFader}
              onError={handleError}
              onFaderDrag={onFaderDrag}
            />
            </FlowBlock>
          </div>
        </div>
      </div>

      <PluginFooter
        channel={selectedMidiChannel}
        loaded={selectedMidiChannel ? loadedMidiIds.has(selectedMidiChannel.id) : false}
        onClose={() => setSelectedMidiId(null)}
        onRefresh={() => { loadConfig() }}
      />

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
