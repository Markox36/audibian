import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertCircle } from 'lucide-react'
import './App.css'
import Matrix from './components/Matrix'
import Mixer from './components/Mixer'
import Effects from './components/Effects'
import Profiles from './components/Profiles'
import Settings from './components/Settings'

export default function App() {
  const [activeTab, setActiveTab] = useState('matrix')
  const [graph, setGraph] = useState({ nodes: [], ports: [], links: [] })
  const [pwConnected, setPwConnected] = useState(true)
  const [uiScale, setUiScale] = useState(1.0)

  const applyScale = (scale) => {
    document.documentElement.style.zoom = scale
    setUiScale(scale)
  }

  useEffect(() => {
    invoke('get_app_config').then(cfg => {
      if (cfg.ui_scale) applyScale(cfg.ui_scale)
    }).catch(() => {})

    invoke('get_graph').then(g => {
      setGraph({
        nodes: Object.values(g.nodes || {}),
        ports: Object.values(g.ports || {}),
        links: Object.values(g.links || {}),
      })
    }).catch(console.error)

    const unlisten = []

    listen('pw-node-added', e => {
      setGraph(prev => {
        const nodes = prev.nodes.filter(n => n.id !== e.payload.id)
        nodes.push(e.payload)
        return { ...prev, nodes }
      })
    }).then(u => unlisten.push(u))

    listen('pw-node-removed', e => {
      const id = e.payload
      setGraph(prev => ({
        nodes: prev.nodes.filter(n => n.id !== id),
        ports: prev.ports.filter(p => p.node_id !== id),
        links: prev.links.filter(l => l.output_node_id !== id && l.input_node_id !== id),
      }))
    }).then(u => unlisten.push(u))

    listen('pw-port-added', e => {
      setGraph(prev => {
        const ports = prev.ports.filter(p => p.id !== e.payload.id)
        ports.push(e.payload)
        return { ...prev, ports }
      })
    }).then(u => unlisten.push(u))

    listen('pw-port-removed', e => {
      const id = e.payload
      setGraph(prev => ({
        ...prev,
        ports: prev.ports.filter(p => p.id !== id),
        links: prev.links.filter(l => l.output_port_id !== id && l.input_port_id !== id),
      }))
    }).then(u => unlisten.push(u))

    listen('pw-link-added', e => {
      setGraph(prev => {
        const links = prev.links.filter(l => l.id !== e.payload.id)
        links.push(e.payload)
        return { ...prev, links }
      })
    }).then(u => unlisten.push(u))

    listen('pw-link-removed', e => {
      const id = e.payload
      setGraph(prev => ({
        ...prev,
        links: prev.links.filter(l => l.id !== id),
      }))
    }).then(u => unlisten.push(u))

    listen('pw-disconnected', () => {
      setPwConnected(false)
    }).then(u => unlisten.push(u))

    listen('pw-node-volume', e => {
      const { node_id, volume, muted } = e.payload
      setGraph(prev => ({
        ...prev,
        nodes: prev.nodes.map(n => n.id === node_id ? { ...n, volume, muted } : n),
      }))
    }).then(u => unlisten.push(u))

    return () => unlisten.forEach(u => u())
  }, [])

  const handleCreateLink = (outputPortId, inputPortId) => {
    invoke('create_link', { outputPortId, inputPortId }).catch(console.error)
  }

  const handleDestroyLink = (linkId) => {
    invoke('destroy_link', { linkId }).catch(console.error)
  }

  const tabs = [
    { id: 'matrix', label: 'Matrix' },
    { id: 'mixer', label: 'Mixer' },
    { id: 'effects', label: 'Effects' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'settings', label: '⚙' },
  ]

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden font-sans bg-[#171717] text-[#f2f2f2] select-none">
      {!pwConnected && (
        <div className="flex items-center justify-center gap-2 py-1.5 px-4 shrink-0 text-xs font-semibold uppercase tracking-wider bg-[#df4c55]/[0.12] border-b border-[#df4c55]/30 text-[#df4c55]">
          <AlertCircle className="w-4 h-4 animate-pulse text-[#df4c55]" />
          <span>Pipewire Disconnected — Audio Graph Unavailable</span>
        </div>
      )}

      <header className="flex items-center justify-between px-4 shrink-0 h-11 border-b border-white/[0.08] bg-white/[0.05]">
        <div className="flex items-center gap-5">
          <span className="text-sm font-bold tracking-[0.12em] uppercase text-[#4169e1]">
            Audibian
          </span>

          <nav className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.09] border border-white/[0.08]">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-3.5 py-1 rounded-md text-xs font-semibold tracking-wider uppercase transition-all duration-150 outline-none ${
                  activeTab === t.id
                    ? 'bg-[#4169e1] text-white shadow-[0_1px_3px_rgba(65,105,225,0.35)]'
                    : 'bg-transparent text-[#7a7a7a]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono text-[#7a7a7a]">
          <span>Tauri-Engine v2.0</span>
          <span className="h-3 w-px bg-white/[0.08] inline-block" />
          <span className="flex items-center gap-1.5 text-[#38b868]">
            <span className="h-1.5 w-1.5 rounded-full animate-pulse bg-[#38b868] inline-block" />
            online
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 bg-[#171717]">
        {activeTab === 'matrix' && (
          <Matrix
            graph={graph}
            onCreateLink={handleCreateLink}
            onDestroyLink={handleDestroyLink}
          />
        )}
        {activeTab === 'mixer' && <Mixer graph={graph} />}
        {activeTab === 'effects' && <Effects graph={graph} />}
        {activeTab === 'profiles' && <Profiles />}
        {activeTab === 'settings' && (
          <Settings uiScale={uiScale} onScaleChange={applyScale} />
        )}
      </main>
    </div>
  )
}
