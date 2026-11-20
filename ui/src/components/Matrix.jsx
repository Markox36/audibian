import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Search, X, Unplug } from 'lucide-react'

const TYPE_COLOR = {
  'Audio/Source': '#5c8f7a',
  'Audio/Sink': '#4f7cbf',
  'Stream/Output': '#4f9ab0',
  'Stream/Input': '#8860b0',
}

const nodeColor = (mc) => {
  for (const [k, c] of Object.entries(TYPE_COLOR))
    if (mc?.startsWith(k)) return c
  return '#6a7a94'
}

const displayName = (n) => n.nick || n.description || n.app_name || n.name

// Stable empty array so a node without ports doesn't produce a new value.
const EMPTY_PORTS = []

// Hide audibian-managed plumbing from the Matrix view: every virtual sink
// we create (audibian_master, audibian_<channel>, audibian_<return>,
// audibian_soundboard, audibian_return_*_src), our peak-meter capture
// streams, internal loopback/remap helper nodes, and pavucontrol's own
// monitoring streams. Routing for audibian_* strips lives in the Mixer,
// not here; surfacing them in both places just creates duplicate UI.
const HIDDEN_NODE_RE = /^(audibian([_-]|$)|(input|output)\.(loopback-|audibian_))/

const HIDDEN_APP_NAMES = new Set([
  'Control de volumen de PulseAudio',
  'PulseAudio Volume Control',
  'pavucontrol',
  'audibian',
  'audibian-meter',
])

const isAudioNode = (n) =>
  // 'Midi' covers MIDI controller/keyboard nodes (e.g. a channel's own
  // MIDI-in port, or a hardware controller) so they're wireable here too,
  // the same way audio routing already works.
  (n.media_class?.startsWith('Audio') || n.media_class?.startsWith('Stream') || n.media_class?.startsWith('Midi')) &&
  !HIDDEN_NODE_RE.test(n.name || '') &&
  !HIDDEN_APP_NAMES.has(n.app_name || '')

const EQ_CSS = `
@keyframes mx-eq { 0%,100% { transform: scaleY(.3) } 50% { transform: scaleY(1) } }
.mx-eq i { display:block; width:2px; height:10px; background:#45d99a; border-radius:1px; transform-origin:bottom; transform:scaleY(.6) }
@media (prefers-reduced-motion: no-preference) {
  .mx-eq i { animation: mx-eq .9s ease-in-out infinite }
  .mx-eq i:nth-child(2) { animation-delay: .3s }
  .mx-eq i:nth-child(3) { animation-delay: .6s }
}`

// Data is flowing through the node; not a level meter.
const Eq = () => (
  <span className="mx-eq inline-flex items-end gap-[2px] h-[10px] shrink-0" role="img" aria-label="activo" title="activo">
    <i /><i /><i />
  </span>
)

// Mode of a src/dst node pair given their sorted ports.
function pairMode(outs, ins, has) {
  if (!outs.length || !ins.length) return 'none'
  let count = 0
  for (const o of outs) for (const i of ins) if (has(o.id, i.id)) count++
  if (count === 0) return 'none'
  if (count === outs.length * ins.length) return 'mono'
  if (count === 2 && outs.length >= 2 && ins.length >= 2 && has(outs[0].id, ins[0].id) && has(outs[1].id, ins[1].id)) return 'stereo'
  return 'mixed'
}

const NEXT = (mode, canStereo) =>
  mode === 'none' ? (canStereo ? 'stereo' : 'mono') : mode === 'stereo' ? 'mono' : 'none'

const LABEL = { stereo: 'Stereo', mono: 'Mono', mixed: 'Parcial' }

export default function Matrix({ graph, onCreateLink, onDestroyLink }) {
  const { nodes, ports, links } = graph
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [onlyConnected, setOnlyConnected] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [running, setRunning] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [status, setStatus] = useState(null)
  const fail = useCallback((e) => setError(String(e)), [])

  const portsIndex = useMemo(() => {
    const m = new Map()
    for (const p of ports) {
      const k = `${p.node_id}-${p.direction}`
      const arr = m.get(k)
      if (arr) arr.push(p)
      else m.set(k, [p])
    }
    for (const arr of m.values()) arr.sort((a, b) => a.port_index - b.port_index)
    return m
  }, [ports])
  const portsOf = useCallback(
    (nodeId, dir) => portsIndex.get(`${nodeId}-${dir}`) ?? EMPTY_PORTS,
    [portsIndex]
  )

  const linkLookup = useMemo(() => {
    const m = new Map()
    for (const l of links) m.set(`${l.output_port_id}-${l.input_port_id}`, l)
    return m
  }, [links])

  const audioNodes = useMemo(
    () => nodes.filter(isAudioNode).sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [nodes]
  )

  // Nodes that have at least one link (for "Solo conectados").
  const linkedNodes = useMemo(() => {
    const nodeOfPort = new Map()
    for (const p of ports) nodeOfPort.set(p.id, p.node_id)
    const s = new Set()
    for (const l of links) {
      s.add(nodeOfPort.get(l.output_port_id))
      s.add(nodeOfPort.get(l.input_port_id))
    }
    return s
  }, [ports, links])

  const { rows, cols } = useMemo(() => {
    const q = search.toLowerCase().trim()
    const keep = (n) =>
      (!q || displayName(n).toLowerCase().includes(q)) && (!onlyConnected || linkedNodes.has(n.id))
    return {
      rows: audioNodes.filter(n => portsOf(n.id, 'Output').length && keep(n)),
      cols: audioNodes.filter(n => portsOf(n.id, 'Input').length && keep(n)),
    }
  }, [audioNodes, portsOf, search, onlyConnected, linkedNodes])

  const apps = useMemo(() => rows.filter(n => n.media_class?.startsWith('Stream/Output')), [rows])
  const inputs = useMemo(() => rows.filter(n => !n.media_class?.startsWith('Stream/Output')), [rows])

  const has = useCallback((o, i) => linkLookup.has(`${o}-${i}`), [linkLookup])

  // Per-row string of "mode+/-" per column so memoised rows only re-render
  // when one of their own cells changes.
  const modesByRow = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const outs = portsOf(r.id, 'Output')
      m.set(r.id, cols.map(c => {
        const ins = portsOf(c.id, 'Input')
        return pairMode(outs, ins, has) + (outs.length >= 2 && ins.length >= 2 ? '+' : '-')
      }).join(','))
    }
    return m
  }, [rows, cols, portsOf, has])

  // Latest graph data for stable callbacks.
  const ctx = useRef({})
  ctx.current = { nodes, portsOf, linkLookup, onCreateLink, onDestroyLink }

  const persist = useCallback((src, dst, pairs) =>
    invoke('save_matrix_connections', {
      srcNode: src.name, dstNode: dst.name,
      links: pairs.map(([o, i]) => [o.name, i.name]),
    }), [])

  const cycle = useCallback((src, dst, mode, canStereo) => {
    const { portsOf, linkLookup, onCreateLink, onDestroyLink } = ctx.current
    const outs = portsOf(src.id, 'Output')
    const ins = portsOf(dst.id, 'Input')
    const next = NEXT(mode, canStereo)
    const want = []
    if (next === 'stereo') for (let i = 0; i < 2; i++) want.push([outs[i], ins[i]])
    else if (next === 'mono') for (const o of outs) for (const i of ins) want.push([o, i])
    const ops = []
    for (const o of outs) for (const i of ins) {
      const l = linkLookup.get(`${o.id}-${i.id}`)
      if (l) ops.push(onDestroyLink(l.id))
    }
    for (const [o, i] of want) ops.push(onCreateLink(o.id, i.id))
    setError('')
    Promise.all(ops).then(() => persist(src, dst, want)).catch(fail)
  }, [persist, fail])

  // Persist the node pair's full expected link set only once the op succeeded.
  const togglePort = useCallback((src, dst, op, ip) => {
    const { portsOf, linkLookup, onCreateLink, onDestroyLink } = ctx.current
    const link = linkLookup.get(`${op.id}-${ip.id}`)
    const run = link ? onDestroyLink(link.id) : onCreateLink(op.id, ip.id)
    setError('')
    run.then(() => {
      const want = []
      for (const o of portsOf(src.id, 'Output')) for (const i of portsOf(dst.id, 'Input')) {
        const on = o.id === op.id && i.id === ip.id ? !link : linkLookup.has(`${o.id}-${i.id}`)
        if (on) want.push([o, i])
      }
      return persist(src, dst, want)
    }).catch(fail)
  }, [persist, fail])

  const toggleExpanded = useCallback((id) => setExpanded(cur => (cur === id ? null : id)), [])

  // Activity polling.
  useEffect(() => {
    let last = ''
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      invoke('get_node_activity').then(ids => {
        const arr = Array.isArray(ids) ? ids.filter(Number.isFinite).sort((a, b) => a - b) : []
        const key = arr.join(',')
        if (key !== last) { last = key; setRunning(new Set(arr)) }
      }).catch(() => { if (last) { last = ''; setRunning(new Set()) } })
    }
    tick()
    const t = setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', tick) }
  }, [])

  const saveProfile = async (e) => {
    e.preventDefault()
    const name = profileName.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      const ok = await invoke('snapshot_profile_cmd', { name })
      if (ok === true) {
        localStorage.setItem('audibian.activeProfile', name)
        window.dispatchEvent(new CustomEvent('audibian:active-profile', { detail: name }))
        setStatus({ ok: true, text: `Perfil «${name}» guardado` })
        setProfileName('')
        setSaveOpen(false)
      } else {
        setStatus({ ok: false, text: 'No se pudo guardar el perfil' })
      }
    } catch (err) {
      setStatus({ ok: false, text: `No se pudo guardar el perfil: ${err}` })
    } finally {
      setSaving(false)
    }
  }
  const [saveOpen, setSaveOpen] = useState(false)

  if (!audioNodes.length) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#101013]">
        <div className="flex flex-col items-center gap-3.5 p-8 rounded-2xl border border-white/[0.08] bg-[#1b1b1b] max-w-xs text-center">
          <Unplug className="w-9 h-9 text-[#9a988c] opacity-50" />
          <p className="text-sm font-semibold text-[#eceade]">No Audio Nodes Detected</p>
          <p className="text-xs text-[#9a988c] leading-relaxed">
            Connect audio sources or streams to view them in the connection matrix.
          </p>
        </div>
      </div>
    )
  }

  const renderGroup = (title, list) => list.length > 0 && (
    <React.Fragment key={title}>
      <tr>
        <th
          colSpan={cols.length + 1}
          className="sticky left-0 text-left bg-[#101013] px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a988c]"
        >
          {title}
        </th>
      </tr>
      {list.map(r => (
        <Row
          key={r.id}
          row={r}
          cols={cols}
          modes={modesByRow.get(r.id)}
          active={running.has(r.id)}
          open={expanded === r.id}
          onToggle={toggleExpanded}
          onCycle={cycle}
          onTogglePort={togglePort}
          portsOf={expanded === r.id ? portsOf : null}
          has={expanded === r.id ? has : null}
        />
      ))}
    </React.Fragment>
  )

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#101013] text-neutral-300 font-sans">
      <style>{EQ_CSS}</style>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-white/[0.08] bg-[#1b1b1b]">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-md">
          <Search className="w-3 h-3 text-[#9a988c] shrink-0" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar..."
            aria-label="Buscar nodos"
            className="w-44 bg-transparent border-none outline-none text-[#eceade] text-xs placeholder-[#9a988c]/60"
          />
        </div>
        <button
          type="button"
          aria-pressed={onlyConnected}
          onClick={() => setOnlyConnected(v => !v)}
          className={`px-2.5 py-1.5 rounded-md border text-[11px] font-semibold cursor-pointer ${onlyConnected
            ? 'bg-[#45d99a] border-[#45d99a] text-black'
            : 'bg-white/[0.04] border-white/[0.08] text-[#9a988c]'}`}
        >
          Solo conectados
        </button>
        <div className="flex-1" />
        {status && (
          <span role="status" className={`text-[11px] ${status.ok ? 'text-[#45d99a]' : 'text-[#ff9b9d]'}`}>
            {status.text}
          </span>
        )}
        {saveOpen ? (
          <form onSubmit={saveProfile} className="flex items-center gap-1.5">
            <input
              autoFocus
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              placeholder="Nombre del perfil"
              aria-label="Nombre del perfil"
              className="w-40 px-2.5 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-md outline-none text-[#eceade] text-xs placeholder-[#9a988c]/60"
            />
            <button
              type="submit"
              disabled={saving || !profileName.trim()}
              className="px-2.5 py-1.5 rounded-md bg-[#45d99a] text-black text-[11px] font-semibold cursor-pointer disabled:opacity-40"
            >
              Guardar
            </button>
            <button
              type="button"
              onClick={() => setSaveOpen(false)}
              aria-label="Cancelar"
              className="p-1.5 rounded-md border border-white/[0.08] text-[#9a988c] cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => { setSaveOpen(true); setStatus(null) }}
            className="px-2.5 py-1.5 rounded-md border border-white/[0.08] bg-white/[0.05] text-[11px] font-semibold text-[#eceade] cursor-pointer hover:bg-white/[0.1]"
          >
            Guardar como perfil
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-sm border border-[#ff6b6e]/40 bg-[#ff6b6e]/10 px-3 py-2 text-[11px] text-[#ff9b9d]"
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {rows.length === 0 || cols.length === 0 ? (
          <div className="p-8 text-center text-[#9a988c] text-xs">Ningún nodo coincide con el filtro.</div>
        ) : (
          <table className="border-separate border-spacing-0 text-[11px]">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-30 bg-[#101013] min-w-[200px] border-b border-white/[0.08]" />
                {cols.map(c => (
                  <th
                    key={c.id}
                    className="sticky top-0 z-20 bg-[#101013] border-b border-white/[0.08] px-2 py-2 min-w-[96px] max-w-[140px] align-bottom"
                    title={displayName(c)}
                  >
                    <div className="flex items-center justify-center gap-1.5">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: nodeColor(c.media_class) }} />
                      <span className="truncate text-[11px] font-semibold text-[#eceade]">{displayName(c)}</span>
                      {running.has(c.id) && <Eq />}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {renderGroup('Aplicaciones', apps)}
              {renderGroup('Entradas', inputs)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const Row = React.memo(function Row({ row, cols, modes, active, open, onToggle, onCycle, onTogglePort, portsOf, has }) {
  const tokens = modes ? modes.split(',') : []
  const name = displayName(row)
  return (
    <>
      <tr>
        <th
          scope="row"
          className="sticky left-0 z-10 bg-[#101013] border-b border-white/[0.05] px-3 py-1.5 text-left font-normal min-w-[200px] max-w-[240px]"
        >
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: nodeColor(row.media_class) }} />
            <span className="truncate text-xs font-semibold text-[#eceade]" title={name}>{name}</span>
            {active && <Eq />}
            <button
              type="button"
              onClick={() => onToggle(row.id)}
              aria-expanded={open}
              className="ml-auto shrink-0 text-[10px] text-[#9a988c] hover:text-[#eceade] cursor-pointer"
            >
              Avanzado {open ? '▴' : '▾'}
            </button>
          </div>
        </th>
        {cols.map((c, idx) => {
          const t = tokens[idx] ?? 'none-'
          const mode = t.slice(0, -1)
          const canStereo = t.endsWith('+')
          const label = LABEL[mode]
          return (
            <td key={c.id} className="border-b border-white/[0.05] p-1 text-center">
              <button
                type="button"
                onClick={() => onCycle(row, c, mode, canStereo)}
                title={`${name} → ${displayName(c)}${label ? `: ${label}` : ''}`}
                aria-label={`${name} a ${displayName(c)}: ${label ?? 'sin conexión'}`}
                className={`w-full min-w-[64px] px-2 py-1 rounded-md border text-[10px] font-semibold cursor-pointer ${mode === 'none'
                  ? 'border-transparent text-[#9a988c]/50 hover:bg-white/[0.06]'
                  : mode === 'mixed'
                    ? 'bg-[#45d99a]/[0.12] border-[#45d99a]/40 text-[#45d99a]'
                    : 'bg-[#45d99a] border-[#45d99a] text-black'}`}
              >
                {label ?? '—'}
              </button>
            </td>
          )
        })}
      </tr>
      {open && portsOf && (
        <tr>
          <td colSpan={cols.length + 1} className="bg-white/[0.02] border-b border-white/[0.05] p-0">
            <div className="sticky left-0 w-fit max-w-full p-3 flex flex-wrap gap-3">
              {cols.map(dst => {
                const outs = portsOf(row.id, 'Output')
                const ins = portsOf(dst.id, 'Input')
                if (!ins.length) return null
                return (
                  <div key={dst.id} className="border border-white/[0.08] rounded-lg bg-[#1e1e1e] w-fit">
                    <div
                      className="px-3 py-1.5 border-b border-white/[0.08] text-xs font-semibold text-[#eceade]"
                      style={{ borderLeft: `3px solid ${nodeColor(dst.media_class)}` }}
                    >
                      {displayName(dst)}
                    </div>
                    <div className="p-2 overflow-x-auto">
                      <table className="border-separate border-spacing-1 text-[11px]">
                        <thead>
                          <tr>
                            <th />
                            {ins.map(p => (
                              <th key={p.id} className="text-[9px] font-mono font-semibold text-[#9a988c] px-1.5 py-0.5 text-center min-w-[44px] uppercase tracking-[0.03em]">
                                {p.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {outs.map(mp => (
                            <tr key={mp.id}>
                              <td className="text-[10px] font-mono text-[#9a988c] px-2.5 py-1 text-right whitespace-nowrap">
                                {mp.name} <span className="text-[#45d99a] font-bold">→</span>
                              </td>
                              {ins.map(ip => {
                                const conn = has(mp.id, ip.id)
                                return (
                                  <td key={ip.id} className="p-0">
                                    <button
                                      type="button"
                                      className={`mx-conn w-7 h-7 block mx-auto rounded-md cursor-pointer p-0 ${conn
                                        ? 'bg-[#45d99a] border border-[#45d99a]/70'
                                        : 'bg-white/[0.04] border border-white/[0.08]'}`}
                                      onClick={() => onTogglePort(row, dst, mp, ip)}
                                      aria-pressed={conn}
                                      title={conn ? `Desconectar ${mp.name} → ${ip.name}` : `Conectar ${mp.name} → ${ip.name}`}
                                    />
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  )
})
