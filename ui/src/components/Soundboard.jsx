import React, { useEffect, useState, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Square, Music, Scissors, MoreHorizontal } from 'lucide-react'

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

const PALETTE = ['#45d99a', '#5ab0ff', '#b48cff', '#ff8fb3', '#ffb454', '#ff6b6e', '#4fd6e0', '#c6e05a']
const defaultColor = (id) => {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
const normKey = (k) => (k.length === 1 ? k.toUpperCase() : k)
const isTyping = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
const playLen = (s) => (s.duration_ms == null ? null : (s.end_ms ?? s.duration_ms) - (s.start_ms ?? 0))

export default function Soundboard() {
  const [sounds, setSounds] = useState([])
  const [renaming, setRenaming] = useState(null) // { id, value }
  const [trimming, setTrimming] = useState(null) // { id, start, end }
  const [adding, setAdding] = useState(false)
  const [playError, setPlayError] = useState('')
  const [plays, setPlays] = useState({}) // id -> { n, ms } progress bar run
  const [menu, setMenu] = useState(null) // { id, x, y, mode: 'main' | 'color' }
  const [capturing, setCapturing] = useState(null) // sound id awaiting a key
  // Poll while there are sounds without a duration yet (background probe).
  const pollRef = useRef(null)
  const live = useRef({})
  live.current = { sounds, capturing, menu, trimming, renaming }

  const refresh = useCallback(() => {
    invoke('soundboard_list').then(setSounds).catch(e => setPlayError(`No se pudo cargar la lista: ${e}`))
  }, [])

  useEffect(() => { refresh() }, [refresh])

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
            .catch(fail('Error al añadir'))
        )
      )
      refresh()
    } finally {
      setAdding(false)
    }
  }

  const handlePlay = async (id) => {
    setPlayError('')
    try {
      await invoke('soundboard_play', { id })
      const s = live.current.sounds.find(x => x.id === id)
      const ms = s && playLen(s)
      setPlays(p => {
        const next = { ...p }
        if (Number.isFinite(ms) && ms > 0) next[id] = { n: (p[id]?.n ?? 0) + 1, ms }
        else delete next[id]
        return next
      })
    } catch (error) {
      setPlayError(`Error al reproducir: ${error}`)
    }
  }

  const handleStopAll = () => {
    setPlays({})
    invoke('soundboard_stop_all').catch(e => setPlayError(`Error al parar: ${e}`))
  }

  const fail = (what) => (e) => setPlayError(`${what}: ${e}`)

  const handleRemove = (id) => {
    invoke('soundboard_remove', { id }).then(refresh).catch(fail('Error al quitar'))
  }

  const setMeta = (s, key, color) => {
    setPlayError('')
    invoke('soundboard_set_meta', { id: s.id, key, color })
      .then(refresh)
      .catch(fail('Error al guardar'))
  }

  const commitRename = () => {
    if (!renaming) return
    const { id, value } = renaming
    const trimmed = (value || '').trim()
    if (trimmed) {
      invoke('soundboard_rename', { id, name: trimmed })
        .then(refresh)
        .catch(fail('Error al renombrar'))
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
      if (!Number.isFinite(n) || n < 0) return null
      return Math.round(n * 1000)
    }
    invoke('soundboard_set_trim', {
      id: trimming.id,
      startMs: parse(trimming.start),
      endMs: parse(trimming.end),
    }).then(refresh).catch(fail('Error al recortar'))
    setTrimming(null)
  }

  const clearTrim = () => {
    if (!trimming) return
    invoke('soundboard_set_trim', {
      id: trimming.id,
      startMs: null,
      endMs: null,
    }).then(refresh).catch(fail('Error al recortar'))
    setTrimming(null)
  }

  const askRemove = (s) => {
    if (window.confirm(`¿Quitar «${s.name}» del soundboard?`)) handleRemove(s.id)
  }

  // One keydown listener for the lifetime of the tab (not a global hotkey).
  const handlers = useRef({})
  handlers.current = { handlePlay, handleStopAll, setMeta }
  useEffect(() => {
    const onKey = (e) => {
      const { sounds, capturing, menu, trimming, renaming } = live.current
      if (capturing != null) {
        e.preventDefault()
        if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
        const s = sounds.find(x => x.id === capturing)
        setCapturing(null)
        if (e.key === 'Escape' || !s) return
        handlers.current.setMeta(s, e.key === 'Backspace' ? null : normKey(e.key), s.color ?? null)
        return
      }
      if (isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return
      if (e.key === 'Escape') {
        if (menu) setMenu(null)
        else if (!trimming && !renaming) handlers.current.handleStopAll()
        return
      }
      if (trimming || menu) return
      const k = normKey(e.key)
      const s = sounds.find(x => x.key === k)
      if (s && s.duration_ms != null) {
        e.preventDefault()
        handlers.current.handlePlay(s.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const menuSound = menu && sounds.find(s => s.id === menu.id)
  const openMenu = (id, x, y) => setMenu({ id, x, y, mode: 'main' })
  const menuItem = 'w-full text-left px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-white/[0.08] focus:bg-white/[0.08] focus:outline-none'

  return (
    <div className="flex-1 flex flex-col h-full bg-[#101013] text-neutral-300 font-sans overflow-hidden">
      <style>{'@keyframes sb-fill{from{width:0}to{width:100%}}'}</style>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/[0.04] border-b border-white/[0.08] gap-3 h-[42px] shrink-0 text-xs text-neutral-300 select-none">
        <div className="flex items-center gap-3">
          <Music className="w-3.5 h-3.5 text-[#45d99a]" />
          <span className="text-[10px] font-black tracking-[0.22em] text-neutral-100 uppercase">
            Soundboard
          </span>
          <span className="text-[9px] font-mono text-neutral-500">
            {sounds.length} sonido{sounds.length === 1 ? '' : 's'} · salida por el strip <span className="text-neutral-300">Soundboard</span> del Mixer
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAdd}
            disabled={adding}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#45d99a]/15 hover:border-[#45d99a]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-3 h-3 text-[#45d99a]" />
            {adding ? 'Eligiendo…' : 'Añadir sonidos'}
          </button>
          <button
            onClick={handleStopAll}
            disabled={sounds.length === 0}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#ff6b6e]/15 hover:border-[#ff6b6e]/60 hover:text-[#ff6b6e] text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Square className="w-3 h-3" />
            Parar todo
            <kbd className="font-mono text-[8px] text-neutral-500 border border-white/[0.12] rounded px-1">Esc</kbd>
          </button>
        </div>
      </div>
      {playError && (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-sm border border-[#ff6b6e]/40 bg-[#ff6b6e]/10 px-3 py-2 text-[10px] text-[#ff9b9d]"
        >
          {playError}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {sounds.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <Music className="w-10 h-10 opacity-30 mb-3" />
            <div className="text-[11px] uppercase tracking-widest font-bold mb-1">Aún no hay sonidos</div>
            <div className="text-[9px] font-mono opacity-70">Usa «Añadir sonidos» para subir uno o varios a la vez</div>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
            {sounds.map(s => {
              const hasTrim = s.start_ms != null || s.end_ms != null
              const color = s.color || defaultColor(s.id)
              const run = plays[s.id]
              const ready = s.duration_ms != null
              return (
                <div
                  key={s.id}
                  onContextMenu={e => { e.preventDefault(); openMenu(s.id, e.clientX, e.clientY) }}
                  style={{ backgroundColor: `${color}26`, borderColor: `${color}99` }}
                  className="relative overflow-hidden rounded-xl border min-h-[110px] group"
                >
                  <button
                    onClick={() => handlePlay(s.id)}
                    disabled={!ready}
                    aria-label={`Reproducir ${s.name}`}
                    className="absolute inset-0 w-full h-full hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/60 transition-colors disabled:cursor-not-allowed"
                  />
                  <div className="relative pointer-events-none h-full p-3 pb-4 flex flex-col justify-between gap-2">
                    <div className="flex items-start justify-between gap-2">
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
                          className="pointer-events-auto flex-1 min-w-0 bg-black/40 border border-white/[0.08] text-[12px] text-neutral-100 font-semibold px-1.5 py-0.5 rounded-sm focus:outline-none focus:border-[#45d99a]"
                        />
                      ) : (
                        <div className="text-[12px] font-semibold text-neutral-100 break-words line-clamp-2 flex-1 min-w-0" title={`${s.name} — ${s.path}`}>
                          {s.name}
                        </div>
                      )}
                      <button
                        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); openMenu(s.id, r.left, r.bottom) }}
                        aria-label={`Opciones de ${s.name}`}
                        aria-haspopup="menu"
                        className="pointer-events-auto shrink-0 p-0.5 rounded text-neutral-300 hover:text-white hover:bg-black/30 focus-visible:ring-2 focus-visible:ring-white/60"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-end justify-between text-[9px] font-mono text-neutral-300/80">
                      <span>
                        {!ready
                          ? <span className="italic text-neutral-400">importando…</span>
                          : <>{hasTrim && <Scissors className="inline w-3 h-3 mr-1 -mt-0.5" />}{fmtTime(playLen(s))}</>}
                      </span>
                      {s.key && (
                        <kbd className="font-mono text-[10px] font-bold text-neutral-100 bg-black/40 border border-white/20 rounded px-1.5 py-0.5">
                          {s.key}
                        </kbd>
                      )}
                    </div>
                  </div>
                  {run && (
                    <div className="absolute left-0 bottom-0 h-1 w-full bg-black/30 pointer-events-none">
                      <div
                        key={run.n}
                        onAnimationEnd={() => setPlays(p => { const n = { ...p }; delete n[s.id]; return n })}
                        style={{ backgroundColor: color, animation: `sb-fill ${run.ms}ms linear forwards` }}
                        className="h-full"
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 py-1.5 border-t border-white/[0.08] text-[9px] font-mono text-neutral-500 select-none">
        Las teclas solo funcionan con la pestaña Soundboard abierta (no son atajos globales). Clic derecho o ⋯ para editar un pad.
      </div>

      {capturing != null && (
        <div role="status" className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 rounded-md border border-[#45d99a]/60 bg-[#101013] px-4 py-2 text-[11px] text-neutral-100 shadow-2xl">
          Pulsa una tecla para asignarla · Retroceso la borra · Esc cancela
        </div>
      )}

      {/* Pad menu */}
      {menu && menuSound && (
        <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null) }}>
          <div
            role="menu"
            style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 220)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 260)) }}
            className="absolute w-52 rounded-lg border border-white/[0.1] bg-[#1a1a1f] shadow-2xl py-1"
            onClick={e => e.stopPropagation()}
          >
            {menu.mode === 'main' ? (
              <>
                <button role="menuitem" autoFocus className={menuItem} onClick={() => { setRenaming({ id: menuSound.id, value: menuSound.name }); setMenu(null) }}>Renombrar</button>
                <button role="menuitem" className={menuItem} onClick={() => { openTrim(menuSound); setMenu(null) }}>Recortar</button>
                <button role="menuitem" className={menuItem} onClick={() => setMenu({ ...menu, mode: 'color' })}>Color…</button>
                <button role="menuitem" className={menuItem} onClick={() => { setCapturing(menuSound.id); setMenu(null) }}>
                  Asignar tecla{menuSound.key ? ` (${menuSound.key})` : ''}
                </button>
                <button role="menuitem" className={`${menuItem} text-[#ff6b6e]`} onClick={() => { askRemove(menuSound); setMenu(null) }}>Quitar</button>
              </>
            ) : (
              <div className="px-3 py-2 flex flex-col gap-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-neutral-400">Color</div>
                <div className="flex flex-wrap gap-1.5">
                  {PALETTE.map(c => (
                    <button
                      key={c}
                      aria-label={`Color ${c}`}
                      onClick={() => { setMeta(menuSound, menuSound.key ?? null, c); setMenu(null) }}
                      style={{ backgroundColor: c }}
                      className="w-6 h-6 rounded-md border border-white/20 focus-visible:ring-2 focus-visible:ring-white/70"
                    />
                  ))}
                </div>
                <label className="flex items-center gap-2 text-[10px] text-neutral-300">
                  Personalizado
                  <input
                    type="color"
                    defaultValue={menuSound.color || defaultColor(menuSound.id)}
                    onChange={e => setMeta(menuSound, menuSound.key ?? null, e.target.value)}
                    className="w-8 h-6 bg-transparent border-0 p-0"
                  />
                </label>
                <button className="text-left text-[10px] text-neutral-400 hover:text-neutral-100" onClick={() => setMenu({ ...menu, mode: 'main' })}>← Volver</button>
              </div>
            )}
          </div>
        </div>
      )}


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
                <Scissors className="w-4 h-4 text-[#45d99a]" />
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
                  className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#45d99a] focus:border-[#45d99a] w-full font-mono"
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
                  className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#45d99a] focus:border-[#45d99a] w-full font-mono"
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
                className="bg-white/[0.04] border border-white/[0.08] hover:bg-[#ff6b6e]/15 hover:border-[#ff6b6e]/60 hover:text-[#ff6b6e] text-neutral-400 text-xs font-semibold py-1.5 px-3 rounded-md transition-colors"
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
                  className="bg-[#45d99a] hover:bg-[#6fe0b3] text-black text-xs font-bold py-1.5 px-4 rounded-md transition-colors shadow-[0_1px_3px_rgba(69,217,154,0.35)]"
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
