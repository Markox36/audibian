import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertCircle } from 'lucide-react'
import './App.css'
import Matrix from './components/Matrix'
import Mixer from './components/mixer/Mixer'
import Effects from './components/Effects'
import Profiles from './components/Profiles'
import Settings from './components/Settings'
import Soundboard from './components/Soundboard'
import MidiChannels from './components/MidiChannels'

const TAB_IDS = ['matrix', 'mixer', 'soundboard', 'midi', 'effects', 'profiles', 'settings']

export default function App() {
  // `?tab=mixer` opens straight onto a tab. Harmless in the packaged app,
  // and it lets the mocked dev server (AUDIBIAN_UI_MOCK=1) be screenshotted
  // on a specific tab without clicking through the UI.
  const [activeTab, setActiveTab] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab')
    return TAB_IDS.includes(wanted) ? wanted : 'matrix'
  })
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
    { id: 'soundboard', label: 'Soundboard' },
    { id: 'midi', label: 'MIDI' },
    { id: 'effects', label: 'Effects' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'settings', label: '⚙' },
  ]

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden font-sans bg-[#101013] text-[#eceade] select-none">
      {!pwConnected && (
        <div className="flex items-center justify-center gap-2 py-1.5 px-4 shrink-0 text-xs font-semibold uppercase tracking-wider bg-[#ff6b6e]/[0.12] border-b border-[#ff6b6e]/30 text-[#ff6b6e]">
          <AlertCircle className="w-4 h-4 animate-pulse text-[#ff6b6e]" />
          <span>Pipewire Disconnected — Audio Graph Unavailable</span>
        </div>
      )}

      <header className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-1.5 shrink-0 min-h-11 border-b border-white/[0.08] bg-gradient-to-b from-white/[0.07] to-white/[0.02]">
        <div className="flex items-center gap-3 sm:gap-5 min-w-0 flex-wrap">
          <span className="text-sm font-bold tracking-[0.12em] uppercase text-[#45d99a] shrink-0">
            Audibian
          </span>

          <nav className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/[0.09] border border-white/[0.08] overflow-x-auto max-w-full">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-2 sm:px-3.5 py-1 rounded-md text-[10px] sm:text-xs font-semibold tracking-wider uppercase transition-all duration-150 outline-none shrink-0 ${
                  activeTab === t.id
                    ? 'bg-[#45d99a] text-black shadow-[0_1px_3px_rgba(69,217,154,0.35)]'
                    : 'bg-transparent text-[#9a988c] hover:text-neutral-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="hidden sm:flex items-center gap-3 text-xs font-mono text-[#9a988c]">
          <span>Tauri-Engine v2.0</span>
          <span className="h-3 w-px bg-white/[0.08] inline-block" />
          <span className="flex items-center gap-1.5 text-[#45d99a]">
            <span className="h-1.5 w-1.5 rounded-full animate-pulse bg-[#45d99a] inline-block" />
            online
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 bg-[#101013]">
        {activeTab === 'matrix' && (
          <Matrix
            graph={graph}
            onCreateLink={handleCreateLink}
            onDestroyLink={handleDestroyLink}
          />
        )}
        {activeTab === 'mixer' && <Mixer graph={graph} />}
        {activeTab === 'soundboard' && <Soundboard />}
        {activeTab === 'midi' && <MidiChannels />}
        {activeTab === 'effects' && <Effects graph={graph} />}
        {activeTab === 'profiles' && <Profiles />}
        {activeTab === 'settings' && (
          <Settings uiScale={uiScale} onScaleChange={applyScale} />
        )}
      </main>
    </div>
  )
}
