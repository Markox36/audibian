import React, { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Sliders, Waves, ShieldAlert, Sparkles, Volume2 } from 'lucide-react'

const DEFAULT_BANDS = [
  { filter_type: 'LowShelf',  frequency: 80,    gain_db: 0, q: 0.707, enabled: true },
  { filter_type: 'Peak',      frequency: 250,   gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'Peak',      frequency: 1000,  gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'Peak',      frequency: 4000,  gain_db: 0, q: 1.0,   enabled: true },
  { filter_type: 'HighShelf', frequency: 12000, gain_db: 0, q: 0.707, enabled: true },
]

const FILTER_TYPES = ['LowShelf', 'Peak', 'HighShelf', 'LowPass', 'HighPass', 'Notch']
const GAIN_TYPES = ['LowShelf', 'Peak', 'HighShelf']
const Q_MIN = 0.1
const Q_MAX = 10

const withGains = (gains) => DEFAULT_BANDS.map((b, i) => ({ ...b, gain_db: gains[i] }))
const PRESETS = {
  Plano: DEFAULT_BANDS,
  Voz: withGains([-4, -2, 3, 4, -1]),
  'Graves+': withGains([6, 3, 0, 0, 1]),
}

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
  } else if (filter_type === 'LowPass') {
    b0 = (1 - cosW0) / 2; b1 = 1 - cosW0; b2 = b0
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha
  } else if (filter_type === 'HighPass') {
    b0 = (1 + cosW0) / 2; b1 = -(1 + cosW0); b2 = b0
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha
  } else if (filter_type === 'Notch') {
    b0 = 1; b1 = -2 * cosW0; b2 = 1
    a0 = 1 + alpha; a1 = -2 * cosW0; a2 = 1 - alpha
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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Plot geometry shared by the canvas drawing and the node overlay.
const PLOT_H = 120
const dbToY = (db) => PLOT_H / 2 - (db / 24) * (PLOT_H / 2 - 8)
const yToDb = (y) => ((PLOT_H / 2 - y) / (PLOT_H / 2 - 8)) * 24
const freqToFrac = (f) => Math.log10(f / 20) / Math.log10(20000 / 20)
const fracToFreq = (x) => 20 * Math.pow(20000 / 20, x)

function EqCurve({ bands, selected, onSelect, onPatch, onQ }) {
  const canvasRef = useRef(null)
  const boxRef = useRef(null)
  const fs = 48000

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Deep dark background
    ctx.fillStyle = '#101013'
    ctx.fillRect(0, 0, W, H)

    // Grid lines (dB)
    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth = 1
    for (let db = -24; db <= 24; db += 6) {
      const y = dbToY(db)
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
      const x = freqToFrac(freq) * W
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

    // One pass over the curve, reused by the fill and the stroke: each sample
    // runs 5 biquads, so computing it twice doubled the cost of every slider
    // tick.
    const ys = new Float32Array(W)
    for (let x = 0; x < W; x++) {
      const f = fracToFreq(x / W)
      ys[x] = dbToY(combinedMagnitudeDb(bands, f, fs))
    }

    // Fill under curve
    ctx.beginPath()
    for (let x = 0; x < W; x++) {
      if (x === 0) ctx.moveTo(x, ys[x])
      else ctx.lineTo(x, ys[x])
    }
    ctx.lineTo(W, H / 2)
    ctx.lineTo(0, H / 2)
    ctx.closePath()
    ctx.fillStyle = 'rgba(69, 217, 154, 0.08)'
    ctx.fill()

    // Curve line
    ctx.strokeStyle = '#45d99a'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let x = 0; x < W; x++) {
      if (x === 0) ctx.moveTo(x, ys[x])
      else ctx.lineTo(x, ys[x])
    }
    ctx.stroke()
  }, [bands])

  // React wheel listeners are passive, so preventing page scroll needs a native one.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (e) => {
      const node = e.target.closest?.('[data-band]')
      if (!node || !Number.isFinite(e.deltaY) || e.deltaY === 0) return
      e.preventDefault()
      onQ(Number(node.dataset.band), e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [onQ])

  const drag = (e, idx, hasGain) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const r = boxRef.current.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1)
    const patch = { frequency: Math.round(fracToFreq(fx)) }
    if (hasGain) {
      const y = clamp((e.clientY - r.top) / r.height, 0, 1) * PLOT_H
      patch.gain_db = clamp(Math.round(yToDb(y) * 2) / 2, -24, 24)
    }
    onPatch(idx, patch)
  }

  const onKeyDown = (e, idx, band, hasGain) => {
    const big = e.shiftKey
    let patch = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const oct = (big ? 1 / 3 : 1 / 12) * (e.key === 'ArrowRight' ? 1 : -1)
      patch = { frequency: clamp(Math.round(band.frequency * Math.pow(2, oct)), 20, 20000) }
    } else if (hasGain && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const step = (big ? 3 : 0.5) * (e.key === 'ArrowUp' ? 1 : -1)
      patch = { gain_db: clamp(band.gain_db + step, -24, 24) }
    }
    if (!patch) return
    e.preventDefault()
    onPatch(idx, patch)
  }

  return (
    <div ref={boxRef} className="relative w-full border border-white/[0.08] bg-[#101013] rounded-lg my-3">
      <canvas ref={canvasRef} width={900} height={PLOT_H} className="w-full h-32 block rounded-lg" />
      {bands.map((band, idx) => {
        if (!band.enabled || !Number.isFinite(band.frequency) || !Number.isFinite(band.gain_db)) return null
        const hasGain = GAIN_TYPES.includes(band.filter_type)
        const left = clamp(freqToFrac(band.frequency), 0, 1) * 100
        const top = (dbToY(hasGain ? clamp(band.gain_db, -24, 24) : 0) / PLOT_H) * 100
        const sel = selected === idx
        return (
          <div
            key={idx}
            data-band={idx}
            role="slider"
            tabIndex={0}
            aria-label={`Banda ${idx + 1} ${band.filter_type}`}
            aria-orientation="horizontal"
            aria-valuemin={20}
            aria-valuemax={20000}
            aria-valuenow={band.frequency}
            aria-valuetext={`${band.frequency} Hz${hasGain ? `, ${band.gain_db.toFixed(1)} dB` : ''}, Q ${band.q.toFixed(2)}`}
            onFocus={() => onSelect(idx)}
            onKeyDown={e => onKeyDown(e, idx, band, hasGain)}
            onPointerDown={e => {
              e.currentTarget.setPointerCapture(e.pointerId)
              e.currentTarget.focus()
              onSelect(idx)
            }}
            onPointerMove={e => drag(e, idx, hasGain)}
            style={{ left: `${left}%`, top: `${top}%`, touchAction: 'none' }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 h-4 w-4 rounded-full border-2 flex items-center justify-center text-[8px] font-bold cursor-grab active:cursor-grabbing select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
              sel ? 'bg-[#45d99a] border-white text-black z-10' : 'bg-[#101013] border-[#45d99a] text-[#45d99a]'
            }`}
          >
            {idx + 1}
          </div>
        )
      })}
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
      className={`inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#45d99a] ${
        active ? 'bg-[#45d99a]' : 'bg-white/[0.06]'
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
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')

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
    setError('')
    invoke('start_eq', { targetSink, bands, sampleRate: 48000 })
      .then(() => setEqActive(true))
      .catch(() => setError('No se pudo iniciar el EQ'))
  }

  const removeEq = () => {
    setError('')
    invoke('stop_eq').then(() => setEqActive(false)).catch(() => setError('No se pudo detener el EQ'))
  }

  const toggleNs = (sourceName) => {
    setError('')
    if (nsList.includes(sourceName)) {
      invoke('stop_ns', { sourceName }).then(() =>
        setNsList(prev => prev.filter(n => n !== sourceName))
      ).catch(() => setError('No se pudo desactivar la supresión de ruido'))
    } else {
      invoke('start_ns', { sourceName }).then(() =>
        setNsList(prev => [...prev, sourceName])
      ).catch(() => setError('No se pudo activar la supresión de ruido'))
    }
  }

  const patchBand = useCallback((idx, patch) => {
    // A cleared number input yields NaN, which breaks the curve and makes
    // start_eq fail silently.
    if (!Object.values(patch).every(v => typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v))) return
    setBands(prev => prev.map((b, i) => i === idx ? { ...b, ...patch } : b))
  }, [])

  const updateBand = (idx, field, value) => patchBand(idx, { [field]: value })

  const scaleQ = useCallback((idx, factor) =>
    setBands(prev => prev.map((b, i) => i === idx
      ? { ...b, q: clamp(Math.round(b.q * factor * 100) / 100, Q_MIN, Q_MAX) }
      : b)), [])

  return (
    <div className="flex-1 overflow-auto bg-[#101013] p-6 flex flex-col gap-6 text-neutral-300 font-sans">
      <div className="max-w-4xl w-full mx-auto flex flex-col gap-6">
        
        {/* Equalizer Parametrico Card */}
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
            <div className="flex items-center gap-3">
              <Sliders className="w-5 h-5 text-[#45d99a]" />
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
                className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#45d99a] cursor-pointer"
              >
                <option value="">-- Select Sink --</option>
                {sinkNodes.map(n => (
                  <option key={n.id} value={n.name}>{displayName(n)}</option>
                ))}
              </select>
              <button 
                onClick={applyEq} 
                disabled={!targetSink}
                className="inline-flex items-center bg-[#45d99a] hover:bg-[#6fe0b3] disabled:opacity-40 disabled:hover:bg-[#45d99a] text-black font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3.5 rounded-md transition-colors"
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

          {/* Interactive curve */}
          <EqCurve bands={bands} selected={selected} onSelect={setSelected} onPatch={patchBand} onQ={scaleQ} />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] text-neutral-500 font-semibold uppercase tracking-wider">Presets:</span>
            {Object.keys(PRESETS).map(name => (
              <button
                key={name}
                type="button"
                onClick={() => setBands(PRESETS[name])}
                className="bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-neutral-300 text-[10px] font-bold tracking-wider uppercase py-1 px-2.5 rounded-md transition-colors"
              >
                {name}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-neutral-600 hidden md:inline">Arrastra los nodos · rueda = Q · flechas = frecuencia/ganancia</span>
          </div>

          {error && (
            <div role="alert" className="border border-[#ff6b6e]/30 bg-[#ff6b6e]/10 text-[#ff6b6e] text-xs rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {/* EQ Bands controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 mt-1">
            {bands.map((band, idx) => {
              const hasGain = GAIN_TYPES.includes(band.filter_type)
              return (
              <div
                key={idx}
                onFocus={() => setSelected(idx)}
                onPointerDown={() => setSelected(idx)}
                className={`border rounded-lg p-3.5 flex flex-col gap-3.5 transition-all ${
                  selected === idx ? 'border-[#45d99a] ring-1 ring-[#45d99a]/60' : 'border-white/[0.08]'
                } ${
                  band.enabled
                    ? 'bg-[#101013]'
                    : 'bg-white/[0.03] opacity-40 hover:opacity-60'
                }`}
              >
                <div className="flex items-center justify-between gap-2 border-b border-white/[0.08] pb-2">
                  <select
                    aria-label={`Tipo de filtro de la banda ${idx + 1}`}
                    value={band.filter_type}
                    onChange={e => patchBand(idx, { filter_type: e.target.value })}
                    className="min-w-0 bg-transparent text-[10px] font-extrabold uppercase tracking-wider text-[#45d99a] focus:outline-none focus:ring-1 focus:ring-[#45d99a] rounded cursor-pointer"
                  >
                    {FILTER_TYPES.map(t => (
                      <option key={t} value={t} className="bg-[#101013] text-neutral-200">{t}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => updateBand(idx, 'enabled', !band.enabled)}
                    className={`text-[9px] font-bold tracking-wider uppercase py-0.5 px-2 rounded border transition-colors ${
                      band.enabled
                        ? 'bg-[#45d99a]/10 text-[#45d99a] border-[#45d99a]/20'
                        : 'bg-white/[0.05] text-neutral-500 border-white/[0.08]'
                    }`}
                  >
                    {band.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Frecuencia</span>
                    <span className="text-neutral-400">{band.frequency}Hz</span>
                  </div>
                  <input
                    type="number"
                    value={band.frequency}
                    min="20"
                    max="20000"
                    onChange={e => updateBand(idx, 'frequency', parseFloat(e.target.value))}
                    className="bg-white/[0.05] border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1 px-2 w-full focus:outline-none focus:border-[#45d99a] text-center font-mono"
                  />
                </div>

                <div className={`flex flex-col gap-1.5 ${hasGain ? '' : 'opacity-40'}`}>
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Ganancia</span>
                    <span className="text-neutral-400">{hasGain ? `${band.gain_db >= 0 ? '+' : ''}${band.gain_db.toFixed(1)} dB` : 'n/a'}</span>
                  </div>
                  <input
                    type="range"
                    min="-24"
                    max="24"
                    step="0.5"
                    value={band.gain_db}
                    disabled={!hasGain}
                    onChange={e => updateBand(idx, 'gain_db', parseFloat(e.target.value))}
                    className="accent-[#45d99a] h-1.5 w-full bg-white/[0.05] rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-neutral-500 uppercase">
                    <span>Q</span>
                    <span className="text-neutral-400">{band.q.toFixed(2)}</span>
                  </div>
                  <input
                    type="number"
                    value={band.q}
                    min={Q_MIN}
                    max={Q_MAX}
                    step="0.1"
                    onChange={e => updateBand(idx, 'q', parseFloat(e.target.value))}
                    className="bg-white/[0.05] border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1 px-2 w-full focus:outline-none focus:border-[#45d99a] text-center font-mono"
                  />
                </div>
              </div>
              )
            })}
          </div>
        </div>

        {/* Noise Suppression Card */}
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
          <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
            <Waves className="w-5 h-5 text-[#45d99a]" />
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
                        active ? 'text-[#45d99a]' : 'text-neutral-500'
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
