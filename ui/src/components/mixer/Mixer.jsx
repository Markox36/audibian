import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Plus, Sparkles, X, Activity } from 'lucide-react'
import { CREAM, FAINT, GREEN, GRID_MAX_HEIGHT, GRID_TEMPLATE, PANEL_BG, RAIL_TEXT, RAIL_WIDTH, STRIP_BG, STRIP_WIDTH } from './theme'
import { ConfigModal } from './ConfigModal'
import { HeaderRail } from './HeaderRail'
import { InputStrip } from './InputStrip'
import { MasterStrip } from './MasterStrip'
import { MidiStrip } from './MidiStrip'
import { PluginFooter } from './PluginFooter'
import { ReturnStrip } from './ReturnStrip'


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
  const [peaks, setPeaks] = useState({})
  const [faderValues, setFaderValues] = useState({})
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
        const next = { ...prev }
        for (const c of cfg.input_channels || []) {
          const k = `in-${c.id}`
          if (next[k] === undefined && typeof c.fader === 'number') next[k] = c.fader * 100
        }
        for (const r of cfg.return_channels || []) {
          const k = `ret-${r.id}`
          if (next[k] === undefined && typeof r.fader === 'number') next[k] = r.fader * 100
        }
        for (const m of cfg.midi_channels || []) {
          const k = `midi-${m.id}`
          if (next[k] === undefined && typeof m.fader === 'number') next[k] = m.fader * 100
        }
        if (next.master === undefined && typeof cfg.master_fader === 'number') next.master = cfg.master_fader * 100
        return next
      })
      setLoading(false)
    }).catch(console.error)
    invoke('get_solo_set').then(keys => setSoloSet(new Set(keys))).catch(console.error)
    refreshLoadedMidi()
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

  const handleMidiSoloToggle = useCallback((id) => {
    const key = `midi-${id}`
    setSoloSet(prev => {
      const next = new Set(prev)
      const willActivate = !next.has(key)
      if (willActivate) next.add(key); else next.delete(key)
      invoke('midi_channel_set_solo', { id, solo: willActivate }).then(() => loadConfig()).catch(console.error)
      return next
    })
  }, [])

  const handleMidiRemove = useCallback((id) => {
    invoke('midi_channel_remove', { id }).then(() => {
      setSelectedMidiId(sel => sel === id ? null : sel)
      loadConfig()
    }).catch(console.error)
  }, [])

  const sortedInputs = useMemo(() => config.input_channels.slice().sort((a, b) => a.order - b.order), [config.input_channels])
  const sortedReturns = useMemo(() => config.return_channels.slice().sort((a, b) => a.order - b.order), [config.return_channels])
  const sortedMidi = useMemo(() => (config.midi_channels || []).slice().sort((a, b) => a.order - b.order), [config.midi_channels])
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

      {/* ─── Mixer Grid (header rail + strips, subgrid rows) ─── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden" style={{ backgroundColor: PANEL_BG }}>
        <div
          className="h-full"
          style={{
            display: 'grid',
            gridTemplateRows: GRID_TEMPLATE,
            gridAutoFlow: 'column',
            // Columns are declared explicitly rather than left to
            // `gridAutoColumns`, because the spacer between the input block and
            // the return block has to be a flexible track while the strips stay
            // fixed. Auto columns would force one size on all of them.
            gridTemplateColumns: [
              RAIL_WIDTH,
              `repeat(${sortedInputs.length}, ${STRIP_WIDTH})`,
              `repeat(${sortedMidi.length}, ${STRIP_WIDTH})`,
              // Pushes returns to the right edge, and collapses to just the
              // divider once enough strips exist to fill the row.
              'minmax(17px, 1fr)',
              `repeat(${sortedReturns.length + 1}, ${STRIP_WIDTH})`,
            ].join(' '),
            // Rows are capped, so without this the grid stretches to fill the
            // window and every strip grows with it. Pin them to the top.
            alignContent: 'start',
            maxHeight: GRID_MAX_HEIGHT,
            padding: '0.75em 1em 1em 1em',
            rowGap: 4,
            columnGap: 8,
            width: '100%',
            // Never below the strips' own width: the parent scrolls instead of
            // squeezing them, which is what keeps the controls reachable.
            minWidth: 'max-content',
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

          {sortedMidi.map(ch => {
            const peak = peaks[ch.sink_name]
            const peakDb = typeof peak === 'number' ? peak : peak?.db ?? -60
            return (
              <MidiStrip
                key={ch.id}
                ch={ch}
                loaded={loadedMidiIds.has(ch.id)}
                selected={selectedMidiId === ch.id}
                onSelect={() => setSelectedMidiId(sel => sel === ch.id ? null : ch.id)}
                faderVal={getFader(`midi-${ch.id}`)}
                setFader={setFader}
                onRemove={handleMidiRemove}
                soloActive={soloSet.has(`midi-${ch.id}`)}
                onSoloToggle={handleMidiSoloToggle}
                dbL={peak?.l ?? peakDb}
                dbR={peak?.r ?? peakDb}
              />
            )
          })}

          {/* Divider between the input block and the return/master block. */}
          <div className="relative" style={{ gridRow: '1 / -1' }} aria-hidden="true">
            <div
              className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
              style={{
                background:
                  'linear-gradient(to bottom, transparent, rgba(255,255,255,0.26) 10%, rgba(255,255,255,0.26) 90%, transparent)',
                boxShadow: '1px 0 0 rgba(0,0,0,0.6)',
              }}
            />
            {/* Rotated caption. Fits even when the spacer collapses to its
                17px floor, so the two blocks stay labelled at any width. */}
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[8px] font-bold uppercase tracking-[0.2em]"
              style={{
                color: RAIL_TEXT,
                opacity: 0.75,
                writingMode: 'vertical-rl',
                transform: 'translate(-50%, -50%) rotate(180deg)',
                backgroundColor: PANEL_BG,
                padding: '6px 1px',
              }}
            >
              Returns
            </div>
          </div>

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
