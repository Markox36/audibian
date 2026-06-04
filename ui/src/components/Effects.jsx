import React, { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Sliders, Waves, ShieldAlert, Sparkles, Volume2 } from 'lucide-react'

const DEFAULT_BANDS = [
  { filter_type: 'LowShelf',  frequency: 80,    gain_db: 0, q: 0.707, enabled: true },
  { filter_type: 'Peak',      frequency: 250,   gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'Peak',      frequency: 1000,  gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'Peak',      frequency: 4000,  gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'HighShelf', frequency: 12000, gain_db: 0, q: 0.707, enabled: true },
]

function biquadMagnitudeDb(band, f, fs) {
  if (!band.enabled) return 0
  const { filter_type, frequency, gain_db, q } = band
  const f0 = Math.max(20, Math.min(frequency, fs / 2 - 1))
  const qv = Math.max(0.1, q)
  const gdb = Math.max(-24, Math.min(gain_db, 24))
  const w0 = 2 * Math.PI * f0 / fs
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = sinW0 / (2 * qv)
  const A = Math.pow(10, gdb / 40)

  let b0, b1, b2, a0, a1, a2
  if (filter_type === 'Peak') {
    b0 = 1 + alpha * A; b1 = -2 * cosW0; b2 = 1 - alpha * A
    a0 = 1 + alpha / A; a1 = -2 * cosW0; a2 = 1 - alpha / A
  } else if (filter_type === 'LowShelf') {
    const sqA = Math.sqrt(A)
    b0 = A * ((A + 1) - (A - 1) * cosW0 + 2 * sqA * alpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cosW0)
    b2 = A * ((A + 1) - (A - 1) * cosW0 - 2 * sqA * alpha)
    a0 = (A + 1) + (A - 1) * cosW0 + 2 * sqA * alpha
    a1 = -2 * ((A - 1) + (A + 1) * cosW0)
    a2 = (A + 1) + (A - 1) * cosW0 - 2 * sqA * alpha
  } else if (filter_type === 'HighShelf') {
    const sqA = Math.sqrt(A)
    b0 = A * ((A + 1) + (A - 1) * cosW0 + 2 * sqA * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cosW0)
    b2 = A * ((A + 1) + (A - 1) * cosW0 - 2 * sqA * alpha)
    a0 = (A + 1) - (A - 1) * cosW0 + 2 * sqA * alpha
    a1 = 2 * ((A - 1) - (A + 1) * cosW0)
    a2 = (A + 1) - (A - 1) * cosW0 - 2 * sqA * alpha
  } else {
    return 0
  }

  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0
  const na1 = a1 / a0, na2 = a2 / a0
  const w = 2 * Math.PI * f / fs
  const numRe = nb0 + nb1 * Math.cos(w) + nb2 * Math.cos(2 * w)
  const numIm = -nb1 * Math.sin(w) - nb2 * Math.sin(2 * w)
  const denRe = 1 + na1 * Math.cos(w) + na2 * Math.cos(2 * w)
  const denIm = -na1 * Math.sin(w) - na2 * Math.sin(2 * w)
  const numMag2 = numRe * numRe + numIm * numIm
  const denMag2 = denRe * denRe + denIm * denIm
  if (denMag2 < 1e-30) return 0
  return 10 * Math.log10(numMag2 / denMag2)
}

function combinedMagnitudeDb(bands, f, fs) {
  return bands.reduce((sum, b) => sum + biquadMagnitudeDb(b, f, fs), 0)
}

function EqCurve({ bands }) {
  const canvasRef = useRef(null)
  const fs = 48000

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Deep dark background
    ctx.fillStyle = '#171717'
    ctx.fillRect(0, 0, W, H)

    // Grid lines (dB)
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    for (let db = -24; db <= 24; db += 6) {
      const y = H / 2 - (db / 24) * (H / 2 - 8)
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
      if (db !== 0) {
        ctx.fillStyle = '#4b5563'
        ctx.font = '8px monospace'
        ctx.fillText(`${db > 0 ? '+' : ''}${db} dB`, 4, y - 3)
      }
    }

    // Frequency grid (20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k)
    const freqMarks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
    freqMarks.forEach(freq => {
      const x = Math.log10(freq / 20) / Math.log10(20000 / 20) * W
      ctx.strokeStyle = '#2a2a2a'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      const label = freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`
      ctx.fillStyle = '#4b5563'
      ctx.font = '8px monospace'
      ctx.fillText(label, x + 2, H - 4)
    })

    // Zero dB line
    ctx.strokeStyle = '#333333'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, H / 2)
    ctx.lineTo(W, H / 2)
    ctx.stroke()

    // Fill under curve (Orange gradient glow)
    ctx.beginPath()
    for (let x = 0; x < W; x++) {
      const f = 20 * Math.pow(20000 / 20, x / W)
      const db = combinedMagnitudeDb(bands, f, fs)
      const y = H / 2 - (db / 24) * (H / 2 - 8)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.lineTo(W, H / 2)
    ctx.lineTo(0, H / 2)
    ctx.closePath()
    ctx.fillStyle = 'rgba(65, 105, 225, 0.08)'
    ctx.fill()

    // Curve line (Orange theme)
    ctx.strokeStyle = '#4169e1'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let x = 0; x < W; x++) {
      const f = 20 * Math.pow(20000 / 20, x / W)
      const db = combinedMagnitudeDb(bands, f, fs)
      const y = H / 2 - (db / 24) * (H / 2 - 8)
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }, [bands])

  return (
    <div className="w-full border border-white/[0.08] bg-[#171717] rounded-lg overflow-hidden my-3">
      <canvas ref={canvasRef} width={900} height={120} className="w-full h-32 block" />
    </div>
  )
}

function NsToggle({ active, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onChange}
      className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1] ${
        active ? 'bg-[#4169e1]' : 'bg-white/[0.06]'
      }`}
    >
      <span
        className={`pointer-events-none block h-4 w-4 rounded-full bg-neutral-100 shadow-lg ring-0 transition-transform ${
          active ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export default function Effects({ graph }) {
  const [bands, setBands] = useState(DEFAULT_BANDS)
  const [targetSink, setTargetSink] = useState('')
  const [eqActive, setEqActive] = useState(false)
  const [nsList, setNsList] = useState([])

  const sinkNodes = graph.nodes.filter(n => n.media_class?.includes('Sink'))
  const sourceNodes = graph.nodes.filter(n => n.media_class === 'Audio/Source')

  const displayName = (node) => node.nick || node.description || node.app_name || node.name

  useEffect(() => {
    invoke('get_eq_target').then(t => {
      if (t) { setTargetSink(t); setEqActive(true) }
    }).catch(() => {})
    invoke('get_ns_active').then(setNsList).catch(() => {})
  }, [])

  const applyEq = () => {
    if (!targetSink) return
    invoke('start_eq', { targetSink, bands, sampleRate: 48000 })
      .then(() => setEqActive(true))
      .catch(console.error)
  }

  const removeEq = () => {
    invoke('stop_eq').then(() => setEqActive(false)).catch(console.error)
  }

  const toggleNs = (sourceName) => {
    if (nsList.includes(sourceName)) {
      invoke('stop_ns', { sourceName }).then(() =>
        setNsList(prev => prev.filter(n => n !== sourceName))
      ).catch(console.error)
    } else {
      invoke('start_ns', { sourceName }).then(() =>
        setNsList(prev => [...prev, sourceName])
      ).catch(console.error)
    }
  }

  const updateBand = (idx, field, value) => {
    setBands(prev => prev.map((b, i) => i === idx ? { ...b, [field]: value } : b))
  }

  return (
    <div className="flex-1 overflow-auto bg-[#171717] p-6 flex flex-col gap-6 text-neutral-300 font-sans">
      <div className="max-w-4xl w-full mx-auto flex flex-col gap-6">
        
        {/* Equalizer Parametrico Card */}
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
            <div className="flex items-center gap-3">
              <Sliders className="w-5 h-5 text-[#4169e1]" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Parametric Equalizer</h2>
              {eqActive && (
                <span className="bg-emerald-500/10 text-emerald-450 border border-emerald-500/20 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wider uppercase flex items-center gap-1">
                  <span className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />
                  Active
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-neutral-500 font-semibold uppercase tracking-wider">Sink:</span>
              <select
                value={targetSink}
                onChange={e => setTargetSink(e.target.value)}
                className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#4169e1] cursor-pointer"
              >
                <option value="">-- Select Sink --</option>
                {sinkNodes.map(n => (
                  <option key={n.id} value={n.name}>{displayName(n)}</option>
                ))}
              </select>
              <button 
                onClick={applyEq} 
                disabled={!targetSink}
                className="inline-flex items-center bg-[#4169e1] hover:bg-[#5578e8] disabled:opacity-40 disabled:hover:bg-[#4169e1] text-black font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3.5 rounded-md transition-colors"
              >
                {eqActive ? 'Update' : 'Apply'}
              </button>
              {eqActive && (
                <button 
                  onClick={removeEq}
                  className="inline-flex items-center bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3.5 rounded-md transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Canvas Graph */}
          <EqCurve bands={bands} />

          {/* EQ Bands controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 mt-1">
            {bands.map((band, idx) => (
              <div 
                key={idx} 
                className={`border rounded-lg p-3.5 flex flex-col gap-3.5 transition-all ${
                  band.enabled 
                    ? 'border-white/[0.08] bg-[#171717]' 
                    : 'border-white/[0.08] bg-white/[0.03] opacity-40 hover:opacity-60'
                }`}
              >
                <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#4169e1]">{band.filter_type}</span>
                  <button
                    onClick={() => updateBand(idx, 'enabled', !band.enabled)}
                    className={`text-[9px] font-bold tracking-wider uppercase py-0.5 px-2 rounded border transition-colors ${
                      band.enabled 
                        ? 'bg-[#4169e1]/10 text-[#4169e1] border-[#4169e1]/20' 
                        : 'bg-white/[0.05] text-neutral-500 border-white/[0.08]'
                    }`}
                  >
                    {band.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Frequency</span>
                    <span className="text-neutral-400">{band.frequency}Hz</span>
                  </div>
                  <input
                    type="number"
                    value={band.frequency}
                    min="20"
                    max="20000"
                    onChange={e => updateBand(idx, 'frequency', parseFloat(e.target.value))}
                    className="bg-white/[0.05] border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1 px-2 w-full focus:outline-none focus:border-[#4169e1] text-center font-mono"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Gain</span>
                    <span className="text-neutral-400">{band.gain_db >= 0 ? '+' : ''}{band.gain_db.toFixed(1)} dB</span>
                  </div>
                  <input
                    type="range"
                    min="-24"
                    max="24"
                    step="0.5"
                    value={band.gain_db}
                    onChange={e => updateBand(idx, 'gain_db', parseFloat(e.target.value))}
                    className="accent-[#4169e1] h-1.5 w-full bg-white/[0.05] rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Bandwidth Q</span>
                    <span className="text-neutral-400">{band.q.toFixed(2)}</span>
                  </div>
                  <input
                    type="number"
                    value={band.q}
                    min="0.1"
                    max="10"
                    step="0.1"
                    onChange={e => updateBand(idx, 'q', parseFloat(e.target.value))}
                    className="bg-white/[0.05] border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1 px-2 w-full focus:outline-none focus:border-[#4169e1] text-center font-mono"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Noise Suppression Card */}
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
          <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
            <Waves className="w-5 h-5 text-[#4169e1]" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Noise Suppression</h2>
          </div>

          {sourceNodes.length === 0 ? (
            <div className="text-center py-8 text-xs text-neutral-500">
              No audio sources detected for noise suppression.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {sourceNodes.map(n => {
                const active = nsList.includes(n.name)
                return (
                  <div 
                    key={n.id} 
                    className="flex items-center justify-between border border-white/[0.08] bg-white/[0.03] p-4 rounded-lg hover:border-white/[0.12] hover:bg-white/[0.06]/10 transition-all"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-bold text-neutral-200">{displayName(n)}</span>
                      <span className="text-[9px] font-mono text-neutral-500">{n.media_class}</span>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-bold tracking-wider uppercase font-mono ${
                        active ? 'text-[#4169e1]' : 'text-neutral-500'
                      }`}>
                        {active ? 'Suppression On' : 'Suppression Off'}
                      </span>
                      <NsToggle
                        active={active}
                        onChange={() => toggleNs(n.name)}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
