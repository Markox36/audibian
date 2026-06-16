import React, { useEffect, useState, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Trash2, Plus, Square, Music, Scissors } from 'lucide-react'

// ---------------------------------------------------------------------------
// Soundboard tab. Sounds play into the `audibian_soundboard` virtual input
// strip (auto-provisioned at startup) so routing/fader/sends are managed
// from the Mixer like any other input channel.
// ---------------------------------------------------------------------------

const fmtTime = (ms) => {
  if (ms == null) return '—'
  const s = ms / 1000
  const m = Math.floor(s / 60)
  const r = (s - m * 60)
  return m > 0 ? `${m}:${r.toFixed(2).padStart(5, '0')}` : `${r.toFixed(2)}s`
}

export default function Soundboard() {
  const [sounds, setSounds] = useState([])
  const [renaming, setRenaming] = useState(null) // { id, value }
  const [trimming, setTrimming] = useState(null) // { id, start, end }
  const [adding, setAdding] = useState(false)
  // Poll while there are sounds without a duration yet (background probe).
  const pollRef = useRef(null)

  const refresh = useCallback(() => {
    invoke('soundboard_list').then(setSounds).catch(console.error)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Keep polling list while any sound is still being probed. Cheap call,
  // stops automatically once every entry has a duration.
  useEffect(() => {
    const needs = sounds.some(s => s.duration_ms == null)
    if (!needs) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(refresh, 500)
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [sounds, refresh])

  const handleAdd = async () => {
    if (adding) return
    setAdding(true)
    try {
      const paths = await invoke('soundboard_pick_file').catch(() => [])
      if (!paths || paths.length === 0) return
      // Backend persists each entry immediately + copies/probes in bg.
      // Fire all calls in parallel; refresh once at the end.
      await Promise.all(
        paths.map(p =>
          invoke('soundboard_add', { sourcePath: p, displayName: null })
            .catch(console.error)
        )
      )
      refresh()
    } finally {
      setAdding(false)
    }
  }

  const handlePlay = (id) => {
    invoke('soundboard_play', { id }).catch(console.error)
  }

  const handleStopAll = () => {
    invoke('soundboard_stop_all').catch(console.error)
  }

  const handleRemove = (id) => {
    invoke('soundboard_remove', { id }).then(refresh).catch(console.error)
  }

  const commitRename = () => {
    if (!renaming) return
    const { id, value } = renaming
    const trimmed = (value || '').trim()
    if (trimmed) {
      invoke('soundboard_rename', { id, name: trimmed })
        .then(refresh)
        .catch(console.error)
    }
    setRenaming(null)
  }

  const openTrim = (s) => {
    setTrimming({
      id: s.id,
      start: s.start_ms != null ? (s.start_ms / 1000).toFixed(2) : '',
      end: s.end_ms != null ? (s.end_ms / 1000).toFixed(2) : '',
      duration_ms: s.duration_ms,
    })
  }

  const commitTrim = () => {
    if (!trimming) return
    const parse = (v) => {
      const t = (v || '').trim()
      if (!t) return null
      const n = parseFloat(t)
      if (!isFinite(n) || n < 0) return null
      return Math.round(n * 1000)
    }
    const startMs = parse(trimming.start)
    const endMs = parse(trimming.end)
    invoke('soundboard_set_trim', {
      id: trimming.id,
      startMs,
      endMs,
    }).then(refresh).catch(console.error)
    setTrimming(null)
  }

  const clearTrim = () => {
    if (!trimming) return
    invoke('soundboard_set_trim', {
      id: trimming.id,
      startMs: null,
      endMs: null,
    }).then(refresh).catch(console.error)
    setTrimming(null)
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#171717] text-neutral-300 font-sans overflow-hidden">

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/[0.04] border-b border-white/[0.08] gap-3 h-[42px] shrink-0 text-xs text-neutral-300 select-none">
        <div className="flex items-center gap-3">
          <Music className="w-3.5 h-3.5 text-[#4169e1]" />
          <span className="text-[10px] font-black tracking-[0.22em] text-neutral-100 uppercase">
            Soundboard
          </span>
          <span className="text-[9px] font-mono text-neutral-500">
            {sounds.length} sound{sounds.length === 1 ? '' : 's'} · routed via Mixer strip <span className="text-neutral-300">Soundboard</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAdd}
            disabled={adding}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#4169e1]/15 hover:border-[#4169e1]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-3 h-3 text-[#4169e1]" />
            {adding ? 'Picking…' : 'Add Sounds'}
          </button>
          <button
            onClick={handleStopAll}
            disabled={sounds.length === 0}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Square className="w-3 h-3" />
            Stop all
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {sounds.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <Music className="w-10 h-10 opacity-30 mb-3" />
            <div className="text-[11px] uppercase tracking-widest font-bold mb-1">No sounds yet</div>
            <div className="text-[9px] font-mono opacity-70">Use “Add Sounds” to upload one or many at once</div>
          </div>
        ) : (
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
            {sounds.map(s => {
              const hasTrim = s.start_ms != null || s.end_ms != null
              const trimDur = hasTrim
                ? ((s.end_ms ?? s.duration_ms ?? 0) - (s.start_ms ?? 0))
                : s.duration_ms
              return (
                <div
                  key={s.id}
                  className="bg-[#1f1f1f] border border-white/[0.06] rounded-md p-2.5 flex flex-col gap-2 hover:border-[#4169e1]/40 transition-colors group"
                >
                  <div className="flex items-center justify-between gap-1">
                    {renaming?.id === s.id ? (
                      <input
                        autoFocus
                        value={renaming.value}
                        onChange={e => setRenaming({ id: s.id, value: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        className="flex-1 min-w-0 bg-black/40 border border-white/[0.08] text-[11px] text-neutral-100 font-semibold px-1.5 py-0.5 rounded-sm focus:outline-none focus:border-[#4169e1]"
                      />
                    ) : (
                      <div
                        onDoubleClick={() => setRenaming({ id: s.id, value: s.name })}
                        className="text-[11px] font-semibold text-neutral-100 truncate flex-1 cursor-text"
                        title={`${s.name} — ${s.path}`}
                      >
                        {s.name}
                      </div>
                    )}
                    <button
                      onClick={() => openTrim(s)}
                      className={`p-0.5 transition-colors shrink-0 ${
                        hasTrim
                          ? 'text-[#a18c47] hover:text-[#d4be75]'
                          : 'text-neutral-500 hover:text-neutral-200 opacity-0 group-hover:opacity-100'
                      }`}
                      title={hasTrim ? `Trimmed: ${fmtTime(s.start_ms ?? 0)} → ${fmtTime(s.end_ms ?? s.duration_ms)}` : 'Trim'}
                    >
                      <Scissors className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRemove(s.id)}
                      className="text-neutral-500 hover:text-[#df4c55] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[8.5px] font-mono text-neutral-500">
                    <span>
                      {s.duration_ms == null
                        ? <span className="text-neutral-600 italic">importing…</span>
                        : <>dur {fmtTime(s.duration_ms)}</>}
                    </span>
                    {hasTrim && (
                      <span className="text-[#a18c47]">trim {fmtTime(trimDur)}</span>
                    )}
                  </div>

                  <button
                    onClick={() => handlePlay(s.id)}
                    disabled={s.duration_ms == null}
                    className="w-full bg-[#4169e1]/15 border border-[#4169e1]/40 hover:bg-[#4169e1]/30 hover:border-[#4169e1] text-[#4169e1] text-[10px] font-bold uppercase tracking-wider py-2 rounded-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play className="w-3 h-3" />
                    Play
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Trim modal */}
      {trimming && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setTrimming(null)}
        >
          <div
            className="bg-[#1f1f1f] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Scissors className="w-4 h-4 text-[#4169e1]" />
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-neutral-100">Trim sound</span>
              </div>
              <span className="text-[9px] font-mono text-neutral-500">
                full {fmtTime(trimming.duration_ms)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">Start (s)</label>
                <input
                  type="number"
                  min="0"
                  step="0.05"
                  value={trimming.start}
                  onChange={e => setTrimming({ ...trimming, start: e.target.value })}
                  placeholder="0"
                  className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1] w-full font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider">End (s)</label>
                <input
                  type="number"
                  min="0"
                  step="0.05"
                  value={trimming.end}
                  onChange={e => setTrimming({ ...trimming, end: e.target.value })}
                  placeholder={trimming.duration_ms != null ? (trimming.duration_ms / 1000).toFixed(2) : '∞'}
                  className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1] w-full font-mono"
                />
              </div>
            </div>

            <p className="text-[9px] text-neutral-500 font-mono leading-relaxed">
              Leave a field empty to play from the natural start / to the natural end.
              Trim is applied on the fly via ffmpeg → paplay, the original file is kept.
            </p>

            <div className="flex items-center justify-between border-t border-white/[0.08] pt-3 mt-1">
              <button
                onClick={clearTrim}
                className="bg-white/[0.04] border border-white/[0.08] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-400 text-xs font-semibold py-1.5 px-3 rounded-md transition-colors"
              >
                Clear trim
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTrimming(null)}
                  className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={commitTrim}
                  className="bg-[#4169e1] hover:bg-[#5478e8] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors shadow-[0_1px_3px_rgba(65,105,225,0.35)]"
                >
                  Save trim
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
