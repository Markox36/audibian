import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { Settings as SettingsIcon, Monitor, Volume2, Power, Keyboard, Info } from 'lucide-react'

const SCALE_PRESETS = [
  { label: '75%',  value: 0.75 },
  { label: '90%',  value: 0.90 },
  { label: '100%', value: 1.00 },
  { label: '110%', value: 1.10 },
  { label: '125%', value: 1.25 },
  { label: '133%', value: 1.33 },
  { label: '150%', value: 1.50 },
  { label: '175%', value: 1.75 },
  { label: '200%', value: 2.00 },
]

const CATEGORIES = [
  { id: 'general', label: 'General', Icon: Monitor },
  { id: 'audio', label: 'Audio', Icon: Volume2 },
  { id: 'startup', label: 'Arranque', Icon: Power },
  { id: 'shortcuts', label: 'Atajos', Icon: Keyboard },
  { id: 'about', label: 'Acerca de', Icon: Info },
]

const SHORTCUTS = [
  { group: 'Faders', items: [
    ['↑ / ↓', 'Ajustar volumen ±1'],
    ['Re Pág / Av Pág', 'Ajustar volumen ±10'],
    ['Inicio', 'Ganancia unidad (0 dB)'],
  ] },
  { group: 'Pan', items: [
    ['← / →', 'Mover el pan'],
    ['Inicio', 'Centrar'],
    ['Doble clic', 'Restablecer al centro'],
  ] },
  { group: 'Soundboard', items: [
    ['Tecla asignada', 'Reproduce el pad correspondiente'],
    ['Esc', 'Detener todos los sonidos'],
    ['Nota', 'Las teclas solo funcionan en la pestaña Soundboard'],
  ] },
]

const Toggle = ({ label, hint, checked, onChange }) => (
  <label className="flex items-center justify-between gap-3 text-xs cursor-pointer">
    <span className="flex flex-col gap-1">
      <span className="font-semibold text-neutral-300">{label}</span>
      <span className="text-[11px] text-neutral-500">{hint}</span>
    </span>
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      className="h-4 w-4 accent-[#45d99a] cursor-pointer"
    />
  </label>
)

const Title = ({ children }) => (
  <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">{children}</div>
)

export default function Settings({ uiScale, onScaleChange }) {
  const [cat, setCat] = useState('general')
  const [cfg, setCfg] = useState({})
  const [profiles, setProfiles] = useState([])
  const [version, setVersion] = useState('—')
  const [status, setStatus] = useState(null) // { ok, msg }

  useEffect(() => {
    invoke('get_app_config').then(c => setCfg(c || {}))
      .catch(e => setStatus({ ok: false, msg: `Error al cargar: ${e}` }))
    invoke('list_profiles').then(p => setProfiles(Array.isArray(p) ? p : []))
      .catch(e => setStatus({ ok: false, msg: `Error al listar perfiles: ${e}` }))
    getVersion().then(v => setVersion(v || '—')).catch(() => setVersion('—'))
  }, [])

  useEffect(() => {
    if (status?.ok) {
      const t = setTimeout(() => setStatus(null), 2000)
      return () => clearTimeout(t)
    }
  }, [status])

  // Always round-trips the whole config so the other fields survive the save.
  const saveField = async (patch) => {
    try {
      const current = await invoke('get_app_config')
      const next = { ...current, ...patch }
      await invoke('save_app_config', { config: next })
      setCfg(next)
      setStatus({ ok: true, msg: 'Guardado' })
    } catch (e) {
      setStatus({ ok: false, msg: `Error al guardar: ${e}` })
    }
  }

  const save = (scale) => {
    onScaleChange(scale)
    saveField({ ui_scale: scale })
  }

  const profile = cfg.default_profile ?? ''

  return (
    <div className="flex-1 flex min-h-0 bg-[#101013] text-neutral-300">
      <nav aria-label="Categorías de ajustes" className="w-48 shrink-0 border-r border-white/[0.08] p-3 flex flex-col gap-1">
        <div className="flex items-center gap-2 px-2 pb-3 text-sm font-bold uppercase tracking-wider text-neutral-200">
          <SettingsIcon className="w-4 h-4 text-[#45d99a]" />
          Ajustes
        </div>
        {CATEGORIES.map(({ id, label, Icon }) => {
          const active = cat === id
          return (
            <button
              key={id}
              aria-current={active ? 'page' : undefined}
              onClick={() => setCat(id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold text-left border transition-colors outline-none focus-visible:border-[#45d99a] ${
                active
                  ? 'bg-[#45d99a]/10 border-[#45d99a]/40 text-[#45d99a]'
                  : 'border-transparent text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          )
        })}
      </nav>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-5 shadow-xl">
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">
              {CATEGORIES.find(c => c.id === cat).label}
            </h2>
            <span
              role="status"
              className={`text-[11px] font-semibold ${status?.ok ? 'text-[#45d99a]' : 'text-[#ff6b6e]'}`}
            >
              {status?.msg}
            </span>
          </div>

          {cat === 'general' && (
            <div className="flex flex-col gap-4">
              <Title>Escala de la interfaz</Title>
              <div className="grid grid-cols-3 gap-2">
                {SCALE_PRESETS.map(p => {
                  const isActive = Number.isFinite(uiScale) && Math.abs(uiScale - p.value) < 0.01
                  return (
                    <button
                      key={p.value}
                      aria-pressed={isActive}
                      className={`flex items-center justify-center rounded-md text-xs font-bold py-2 px-3 border transition-colors outline-none ${
                        isActive
                          ? 'bg-[#45d99a] border-[#45d99a] text-black hover:bg-[#6fe0b3]'
                          : 'bg-white/[0.05] border-white/[0.08] text-neutral-400 hover:bg-white/[0.07] hover:text-neutral-100'
                      }`}
                      onClick={() => save(p.value)}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center justify-between text-xs text-neutral-500 font-mono pt-4 border-t border-white/[0.08]">
                <span>Escala actual:</span>
                <span className="font-bold text-neutral-400">
                  {Number.isFinite(uiScale) ? Math.round(uiScale * 100) : '—'}%
                </span>
              </div>
            </div>
          )}

          {cat === 'audio' && (
            <Toggle
              label="Baja latencia"
              hint="Fija el quantum de PipeWire en 256. Se aplica al reiniciar PipeWire."
              checked={!!cfg.low_latency}
              onChange={v => saveField({ low_latency: v })}
            />
          )}

          {cat === 'startup' && (
            <div className="flex flex-col gap-5">
              <Toggle
                label="Iniciar con la sesión"
                hint="Crea una entrada de autoarranque XDG"
                checked={!!cfg.autostart}
                onChange={v => saveField({ autostart: v })}
              />
              <label className="flex items-center justify-between gap-3 text-xs">
                <span className="flex flex-col gap-1">
                  <span className="font-semibold text-neutral-300">Perfil de arranque</span>
                  <span className="text-[11px] text-neutral-500">Se aplica al abrir Audibian</span>
                </span>
                <select
                  value={profile}
                  onChange={e => saveField({ default_profile: e.target.value || null })}
                  className="bg-[#101013] border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-neutral-300 outline-none focus-visible:border-[#45d99a]"
                >
                  <option value="">— Ninguno —</option>
                  {profile && !profiles.includes(profile) && <option value={profile}>{profile}</option>}
                  {profiles.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
          )}

          {cat === 'shortcuts' && (
            <div className="flex flex-col gap-5">
              {SHORTCUTS.map(g => (
                <div key={g.group} className="flex flex-col gap-2">
                  <Title>{g.group}</Title>
                  <dl className="flex flex-col gap-1.5 text-xs">
                    {g.items.map(([k, d]) => (
                      <div key={k + d} className="flex items-center justify-between gap-3">
                        <dt><kbd className="font-mono text-[11px] text-neutral-200 bg-white/[0.07] border border-white/[0.08] rounded px-1.5 py-0.5">{k}</kbd></dt>
                        <dd className="text-neutral-400 text-right">{d}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}

          {cat === 'about' && (
            <dl className="flex flex-col gap-3 text-xs">
              <div className="flex justify-between"><dt className="text-neutral-500">Versión</dt><dd className="font-mono text-neutral-300">{version}</dd></div>
              <div className="flex justify-between"><dt className="text-neutral-500">Licencia</dt><dd className="font-mono text-neutral-300">GPL-3.0</dd></div>
              <div className="flex justify-between gap-3">
                <dt className="text-neutral-500">Repositorio</dt>
                <dd>
                  <a href="https://github.com/Markox36/audibian" target="_blank" rel="noreferrer" className="font-mono text-[#45d99a] hover:underline">
                    https://github.com/Markox36/audibian
                  </a>
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </div>
  )
}
