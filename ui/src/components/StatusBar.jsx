import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

const ACTIVE_KEY = 'audibian.activeProfile'
const readProfile = () => {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}

export default function StatusBar({ graph, pwConnected }) {
  const [profile, setProfile] = useState(readProfile)
  const [pw, setPw] = useState(null) // null = unavailable

  useEffect(() => {
    const onProfile = (e) => setProfile(e.detail || null)
    window.addEventListener('audibian:active-profile', onProfile)
    return () => window.removeEventListener('audibian:active-profile', onProfile)
  }, [])

  useEffect(() => {
    let alive = true
    const poll = () => invoke('get_pw_status')
      .then(s => { if (alive) setPw(s) })
      .catch(() => { if (alive) setPw(null) })
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const sinks = graph.nodes.filter(n => n.media_class === 'Audio/Sink').length
  const q = Number(pw?.quantum)
  const r = Number(pw?.rate)
  const ok = Number.isFinite(q) && Number.isFinite(r) && q > 0 && r > 0
  const color = pwConnected ? '#45d99a' : '#ff6b6e'

  return (
    <footer className="flex items-center gap-4 px-3 sm:px-4 py-1 shrink-0 border-t border-white/[0.08] bg-white/[0.03] text-[10px] font-mono tracking-wider text-[#9a988c] overflow-x-auto whitespace-nowrap">
      <span className="flex items-center gap-1.5" style={{ color }}>
        <span className="h-1.5 w-1.5 rounded-full inline-block" style={{ background: color }} />
        {pwConnected ? 'PipeWire conectado' : 'Desconectado'}
      </span>
      <span>Perfil: {profile || '—'}</span>
      <span>{sinks} sinks · {graph.links.length} enlaces</span>
      <span className="ml-auto">
        {ok ? `quantum ${q} · ${((q / r) * 1000).toFixed(1)} ms` : 'quantum —'}
      </span>
    </footer>
  )
}
