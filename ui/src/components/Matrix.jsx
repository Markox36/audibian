import React, { useState, useMemo } from 'react'
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

const isAudioNode = (n) =>
  n.media_class?.startsWith('Audio') || n.media_class?.startsWith('Stream')

export default function Matrix({ graph, onCreateLink, onDestroyLink }) {
  const { nodes, ports, links } = graph
  const [direction, setDirection] = useState('outputs')
  const [selectedId, setSelectedId] = useState(null)
  const [search, setSearch] = useState('')

  const sideDir = direction === 'outputs' ? 'Output' : 'Input'
  const otherDir = direction === 'outputs' ? 'Input' : 'Output'

  const portsOf = (nodeId, dir) =>
    ports.filter(p => p.node_id === nodeId && p.direction === dir)
      .sort((a, b) => a.port_index - b.port_index)

  const sidebarNodes = useMemo(() => {
    const q = search.toLowerCase().trim()
    return nodes
      .filter(isAudioNode)
      .filter(n => ports.some(p => p.node_id === n.id && p.direction === sideDir))
      .filter(n => !q || displayName(n).toLowerCase().includes(q))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
  }, [nodes, ports, sideDir, search])

  const otherNodes = useMemo(() =>
    nodes
      .filter(isAudioNode)
      .filter(n => ports.some(p => p.node_id === n.id && p.direction === otherDir))
      .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [nodes, ports, otherDir]
  )

  const connCount = useMemo(() => {
    const m = new Map()
    for (const l of links) {
      const localId = sideDir === 'Output' ? l.output_port_id : l.input_port_id
      const p = ports.find(p => p.id === localId)
      if (p) m.set(p.node_id, (m.get(p.node_id) ?? 0) + 1)
    }
    return m
  }, [links, ports, sideDir])

  const linkLookup = useMemo(() => {
    const m = new Map()
    for (const l of links) m.set(`${l.output_port_id}-${l.input_port_id}`, l)
    return m
  }, [links])

  const effectiveSelected = useMemo(() => {
    if (selectedId) {
      const found = sidebarNodes.find(n => n.id === selectedId)
      if (found) return found
    }
    return sidebarNodes[0] ?? null
  }, [selectedId, sidebarNodes])

  const linkIdOf = (myPort, otherPort) => {
    const outId = sideDir === 'Output' ? myPort.id : otherPort.id
    const inId = sideDir === 'Output' ? otherPort.id : myPort.id
    return [outId, inId]
  }
  const isConnected = (myPort, otherPort) => {
    const [outId, inId] = linkIdOf(myPort, otherPort)
    return linkLookup.has(`${outId}-${inId}`)
  }
  const toggleConn = (myPort, otherPort) => {
    const [outId, inId] = linkIdOf(myPort, otherPort)
    const link = linkLookup.get(`${outId}-${inId}`)
    if (link) onDestroyLink(link.id)
    else onCreateLink(outId, inId)

    // Compute expected new state for this node pair and persist
    const otherNode = nodes.find(n => n.id === otherPort.node_id)
    if (otherNode && effectiveSelected) {
      const isNowConn = !link
      const otherPorts = portsOf(otherNode.id, otherDir)
      const newLinks = []
      for (const mp of myPorts) {
        for (const op of otherPorts) {
          const [oId, iId] = linkIdOf(mp, op)
          let conn = linkLookup.has(`${oId}-${iId}`)
          if (mp.id === myPort.id && op.id === otherPort.id) conn = isNowConn
          if (conn) {
            newLinks.push([
              sideDir === 'Output' ? mp.name : op.name,
              sideDir === 'Output' ? op.name : mp.name,
            ])
          }
        }
      }
      saveNodePair(otherNode, newLinks)
    }
  }

  const clearNode = () => {
    if (!effectiveSelected) return
    const myPortIds = new Set(portsOf(effectiveSelected.id, sideDir).map(p => p.id))
    for (const l of links) {
      const id = sideDir === 'Output' ? l.output_port_id : l.input_port_id
      if (myPortIds.has(id)) onDestroyLink(l.id)
    }
    // Wipe persisted connections for all pairs involving this node
    for (const other of otherNodes) {
      saveNodePair(other, [])
    }
  }



  const myPorts = effectiveSelected ? portsOf(effectiveSelected.id, sideDir) : []

  const getConnMode = (targetNodeId) => {
    const targetPorts = portsOf(targetNodeId, otherDir)
    if (myPorts.length === 0 || targetPorts.length === 0) return 'none'

    let connCount = 0
    const totalPairs = myPorts.length * targetPorts.length
    for (const mp of myPorts) {
      for (const tp of targetPorts) {
        if (isConnected(mp, tp)) connCount++
      }
    }

    if (connCount === 0) return 'none'
    // All×all = mono mode
    if (connCount === totalPairs) return 'mono'
    // L→L + R→R only = stereo
    const hasL2L = isConnected(myPorts[0], targetPorts[0])
    const hasR2R = myPorts.length >= 2 && targetPorts.length >= 2 && isConnected(myPorts[1], targetPorts[1])
    if (hasL2L && hasR2R && connCount === 2) return 'stereo'
    return 'mixed'
  }

  const saveNodePair = (targetNode, newLinks) => {
    if (!effectiveSelected || !targetNode) return
    const srcName = sideDir === 'Output' ? effectiveSelected.name : targetNode.name
    const dstName = sideDir === 'Output' ? targetNode.name : effectiveSelected.name
    invoke('save_matrix_connections', { srcNode: srcName, dstNode: dstName, links: newLinks }).catch(console.error)
  }

  const clearPairLinks = (targetNodeId) => {
    const targetPorts = portsOf(targetNodeId, otherDir)
    const targetPortIds = new Set(targetPorts.map(p => p.id))
    const myPortIds = new Set(myPorts.map(p => p.id))
    for (const l of links) {
      const myId = sideDir === 'Output' ? l.output_port_id : l.input_port_id
      const otherId = sideDir === 'Output' ? l.input_port_id : l.output_port_id
      if (myPortIds.has(myId) && targetPortIds.has(otherId)) {
        onDestroyLink(l.id)
      }
    }
  }

  // Mono = all output ports → all input ports (L→L, L→R, R→L, R→R)
  const connectMono = (targetNodeId) => {
    if (!myPorts.length) return
    const targetPorts = portsOf(targetNodeId, otherDir)
    if (!targetPorts.length) return
    const targetNode = nodes.find(n => n.id === targetNodeId)

    clearPairLinks(targetNodeId)

    const newLinks = []
    for (const mp of myPorts) {
      for (const tp of targetPorts) {
        const [outId, inId] = linkIdOf(mp, tp)
        onCreateLink(outId, inId)
        newLinks.push([
          sideDir === 'Output' ? mp.name : tp.name,
          sideDir === 'Output' ? tp.name : mp.name,
        ])
      }
    }
    saveNodePair(targetNode, newLinks)
  }

  const connectStereo = (targetNodeId) => {
    const targetPorts = portsOf(targetNodeId, otherDir)
    if (myPorts.length < 2 || targetPorts.length < 2) return
    const targetNode = nodes.find(n => n.id === targetNodeId)

    clearPairLinks(targetNodeId)

    const newLinks = []
    for (let i = 0; i < 2; i++) {
      const [outId, inId] = linkIdOf(myPorts[i], targetPorts[i])
      onCreateLink(outId, inId)
      newLinks.push([
        sideDir === 'Output' ? myPorts[i].name : targetPorts[i].name,
        sideDir === 'Output' ? targetPorts[i].name : myPorts[i].name,
      ])
    }
    saveNodePair(targetNode, newLinks)
  }

  if (!nodes.filter(isAudioNode).length) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#171717]">
        <div className="flex flex-col items-center gap-3.5 p-8 rounded-2xl border border-white/[0.08] bg-[#1b1b1b] max-w-xs text-center">
          <Unplug className="w-9 h-9 text-[#7a7a7a] opacity-50" />
          <p className="text-sm font-semibold text-[#f2f2f2]">No Audio Nodes Detected</p>
          <p className="text-xs text-[#7a7a7a] leading-relaxed">
            Connect audio sources or streams to view them in the connection matrix.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden bg-[#171717] text-[#f2f2f2] font-sans">

      {/* ── SIDEBAR ──────────────────────────────────────────────── */}
      <aside className="w-[280px] min-w-[280px] flex flex-col border-r border-white/[0.08] bg-[#1b1b1b]">

        {/* Direction tabs */}
        <div className="flex p-2 gap-1 border-b border-white/[0.08]">
          {[['outputs', 'Entradas'], ['inputs', 'Salidas']].map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => { setDirection(k); setSelectedId(null) }}
              className={`flex-1 py-1.5 px-2 text-[11px] font-bold uppercase tracking-[0.06em] rounded-md cursor-pointer transition-colors ${direction === k
                ? 'bg-[#4169e1] text-white'
                : 'bg-transparent text-[#7a7a7a] border border-white/[0.08]'
                }`}
            >
              {lbl}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="p-2 border-b border-white/[0.08]">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-md">
            <Search className="w-3 h-3 text-[#7a7a7a] shrink-0" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar nodos..."
              className="flex-1 bg-transparent border-none outline-none text-[#f2f2f2] text-xs placeholder-[#7a7a7a]/60"
            />
          </div>
        </div>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {sidebarNodes.length === 0 ? (
            <div className="p-4 text-[11px] text-[#7a7a7a] text-center">
              No se encontraron {direction === 'outputs' ? 'entradas' : 'salidas'}.
            </div>
          ) : sidebarNodes.map(n => {
            const isSel = effectiveSelected?.id === n.id
            const cnt = connCount.get(n.id) ?? 0
            const c = nodeColor(n.media_class)
            return (
              <button
                key={n.id}
                onClick={() => setSelectedId(n.id)}
                className={`mx-side-item flex items-center justify-between w-full px-2.5 py-2 mb-0.5 gap-2 rounded-md cursor-pointer text-left transition-colors ${isSel
                  ? 'bg-[#4169e1]/[0.16] border border-[#4169e1]/40 text-[#f2f2f2]'
                  : 'bg-transparent border border-transparent text-[#7a7a7a]'
                  }`}
                style={{ borderLeft: `3px solid ${c}` }}
                title={displayName(n)}
              >
                <span className={`overflow-hidden text-ellipsis whitespace-nowrap text-xs flex-1 min-w-0 ${isSel ? 'font-semibold' : 'font-medium'}`}>
                  {displayName(n)}
                </span>
                <span className={`text-[10px] font-mono px-1.5 py-px rounded shrink-0 ${cnt > 0
                  ? 'text-[#4169e1] bg-[#4169e1]/[0.12]'
                  : 'text-[#7a7a7a] bg-white/[0.04]'
                  }`}>
                  {cnt}
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── DETAIL ───────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {!effectiveSelected ? (
          <div className="flex-1 flex items-center justify-center text-[#7a7a7a] text-sm">
            Select a node from the sidebar.
          </div>
        ) : (
          <Detail
            node={effectiveSelected}
            myPorts={myPorts}
            otherNodes={otherNodes}
            portsOf={portsOf}
            otherDir={otherDir}
            isConnected={isConnected}
            toggleConn={toggleConn}
            clearNode={clearNode}
            getConnMode={getConnMode}
            connectMono={connectMono}
            connectStereo={connectStereo}
          />
        )}
      </main>
    </div>
  )
}

function Detail({
  node,
  myPorts,
  otherNodes,
  portsOf,
  otherDir,
  isConnected,
  toggleConn,
  clearNode,
  getConnMode,
  connectMono,
  connectStereo,
}) {
  const [pairTarget, setPairTarget] = useState('')
  const c = nodeColor(node.media_class)
  const totalConn = otherNodes.reduce((sum, o) =>
    sum + portsOf(o.id, otherDir).reduce((s, op) =>
      s + myPorts.reduce((ss, mp) => ss + (isConnected(mp, op) ? 1 : 0), 0)
      , 0)
    , 0)

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08] bg-[#1b1b1b]">
        <div className="flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c }} />
          <div>
            <div className="text-sm font-semibold text-[#f2f2f2]">{displayName(node)}</div>
            <div className="text-[10px] font-mono text-[#7a7a7a] mt-px">
              {node.media_class} · {myPorts.length} port{myPorts.length !== 1 ? 's' : ''} · {totalConn} active
            </div>
          </div>
        </div>
      </div>

      {/* Mini-grids scroll */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {otherNodes.length === 0 ? (
          <div className="p-8 text-center text-[#7a7a7a] text-xs">
            No targets available.
          </div>
        ) : otherNodes.map(other => {
          const otherPorts = portsOf(other.id, otherDir)
          if (!otherPorts.length) return null
          const oc = nodeColor(other.media_class)
          return (
            <div key={other.id} className="border border-white/[0.08] rounded-lg bg-[#1e1e1e] h-[400px]">
              <div
                className="flex items-center justify-between px-3.5 py-2 border-b border-white/[0.08]"
                style={{ borderLeft: `3px solid ${oc}` }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-semibold text-[#f2f2f2]">{displayName(other)}</span>
                  <span className="text-[9px] font-mono text-[#7a7a7a] uppercase tracking-[0.05em]">
                    {other.media_class}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => connectMono(other.id)}
                    disabled={!myPorts.length || !otherPorts.length}
                    className={`px-2 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                      getConnMode(other.id) === 'mono'
                        ? 'bg-[#4169e1] border-[#4169e1] text-white'
                        : 'bg-white/[0.04] border-white/[0.08] text-[#7a7a7a] hover:text-[#f2f2f2] hover:bg-white/[0.1]'
                    }`}
                  >
                    Mono
                  </button>
                  <button
                    onClick={() => connectStereo(other.id)}
                    disabled={myPorts.length < 2 || otherPorts.length < 2}
                    className={`px-2 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                      getConnMode(other.id) === 'stereo'
                        ? 'bg-[#4169e1] border-[#4169e1] text-white'
                        : 'bg-white/[0.04] border-white/[0.08] text-[#7a7a7a] hover:text-[#f2f2f2] hover:bg-white/[0.1]'
                    }`}
                  >
                    Stereo
                  </button>
                </div>
              </div>
              <div className="p-3 overflow-x-auto">
                <table className="border-separate border-spacing-1 text-[11px]">
                  <thead>
                    <tr>
                      <th />
                      {otherPorts.map(p => (
                        <th key={p.id} className="text-[9px] font-mono font-semibold text-[#7a7a7a] px-1.5 py-0.5 text-center min-w-[44px] uppercase tracking-[0.03em]">
                          {p.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {myPorts.map(mp => (
                      <tr key={mp.id}>
                        <td className="text-[10px] font-mono text-[#7a7a7a] px-2.5 py-1 text-right whitespace-nowrap">
                          {mp.name} <span className="text-[#4169e1] font-bold">→</span>
                        </td>
                        {otherPorts.map(op => {
                          const conn = isConnected(mp, op)
                          return (
                            <td key={op.id} className="p-0">
                              <button
                                className={`mx-conn w-7 h-7 block mx-auto rounded-md cursor-pointer p-0 ${conn
                                  ? 'bg-[#4169e1] border border-[#4169e1]/70'
                                  : 'bg-white/[0.04] border border-white/[0.08]'
                                  }`}
                                onClick={() => toggleConn(mp, op)}
                                aria-pressed={conn}
                                title={conn ? `Disconnect ${mp.name} → ${op.name}` : `Connect ${mp.name} → ${op.name}`}
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

      {/* Bulk actions footer */}
      <div className="flex gap-2 px-5 py-2.5 border-t border-white/[0.08] bg-[#1b1b1b] items-center">
        <div className="flex-1" />

        <button
          onClick={clearNode}
          className="mx-btn inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#df4c55]/[0.12] text-[#df4c55] border border-[#df4c55]/30 rounded-md cursor-pointer text-[11px] font-semibold"
        >
          <X className="w-3 h-3" />
          Clear all
        </button>
      </div>
    </>
  )
}
