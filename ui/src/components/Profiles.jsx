import React, { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Star, Trash2, Save, Settings2, Sparkles, FolderHeart, RefreshCw, Pencil, Copy } from 'lucide-react'

const ACTIVE_KEY = 'audibian.activeProfile'

// Profiles written before the ISO switch stored "<days since epoch>d HH:MM:SS UTC".
function parseCreated(s) {
  if (!s) return null
  const legacy = /^(\d+)d (\d+):(\d+):(\d+)/.exec(s)
  if (legacy) {
    const [, d, h, m, sec] = legacy.map(Number)
    return new Date(Date.UTC(1970, 0, 1 + d, h, m, sec))
  }
  const date = new Date(s)
  return Number.isNaN(date.getTime()) ? null : date
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })
function relativeDate(date) {
  if (!date) return ''
  const diff = (date.getTime() - Date.now()) / 1000
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']]
  let v = diff
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit)
    v /= size
  }
  return ''
}

export default function Profiles() {
  const [profiles, setProfiles] = useState([])
  const [config, setConfig] = useState(null)
  const [newName, setNewName] = useState('')
  const [status, setStatus] = useState('')
  const [active, setActive] = useState(() => localStorage.getItem(ACTIVE_KEY))
  const [editing, setEditing] = useState(null) // { kind: 'rename' | 'duplicate', name, value }

  const loadProfiles = useCallback(() => {
    invoke('list_profiles_info').then(setProfiles).catch(console.error)
  }, [])

  useEffect(() => {
    loadProfiles()
    invoke('get_app_config').then(setConfig).catch(console.error)
  }, [loadProfiles])

  const showStatus = (msg, delay = 2500) => {
    setStatus(msg)
    setTimeout(() => setStatus(''), delay)
  }

  const markActive = (name) => {
    setActive(name)
    if (name) localStorage.setItem(ACTIVE_KEY, name)
    else localStorage.removeItem(ACTIVE_KEY)
  }

  const applyProfile = (name) => {
    invoke('apply_profile_cmd', { name }).then(count => {
      markActive(name)
      showStatus(`"${name}" aplicado — ${count} enlaces activos`)
    }).catch(e => showStatus(`Error al aplicar: ${e}`))
  }

  const deleteProfile = (name) => {
    if (!confirm(`¿Borrar el perfil "${name}"?`)) return
    invoke('delete_profile', { name }).then(() => {
      if (active === name) markActive(null)
      showStatus(`"${name}" borrado`)
      loadProfiles()
    }).catch(e => showStatus(`Error al borrar: ${e}`))
  }

  const saveCurrent = (name, { overwrite = false } = {}) => {
    if (!name) return
    if (!overwrite && profiles.some(p => p.name === name)) {
      showStatus(`Ya existe "${name}". Usa ⟳ para actualizarlo`)
      return
    }
    invoke('snapshot_profile_cmd', { name }).then(ok => {
      if (!ok) return showStatus('No se pudo guardar el perfil')
      markActive(name)
      showStatus(overwrite ? `"${name}" actualizado` : `"${name}" guardado`)
      if (!overwrite) setNewName('')
      loadProfiles()
    }).catch(e => showStatus(`Error al guardar: ${e}`))
  }

  const updateProfile = (name) => {
    if (!confirm(`¿Sobrescribir "${name}" con el estado actual?`)) return
    saveCurrent(name, { overwrite: true })
  }

  const commitEdit = () => {
    const { kind, name, value } = editing
    const to = value.trim()
    setEditing(null)
    if (!to || (kind === 'rename' && to === name)) return
    const cmd = kind === 'rename' ? 'rename_profile' : 'duplicate_profile'
    invoke(cmd, { from: name, to }).then(() => {
      if (kind === 'rename') {
        if (active === name) markActive(to)
        if (config?.default_profile === name) setConfig({ ...config, default_profile: to })
      }
      loadProfiles()
    }).catch(e => showStatus(String(e)))
  }

  const setDefaultProfile = (name) => {
    const updated = { ...config, default_profile: name || null }
    setConfig(updated)
    invoke('save_app_config', { config: updated }).then(() => {
      showStatus(name ? `Perfil de arranque: "${name}"` : 'Sin perfil de arranque')
    }).catch(e => showStatus(`Error: ${e}`))
  }

  const iconBtn = 'p-1.5 rounded text-neutral-500 hover:text-neutral-100 hover:bg-white/[0.1] transition-colors'

  return (
    <div className="flex-1 overflow-auto bg-[#101013] p-6 flex flex-col gap-6 text-neutral-300 font-sans">
      {status && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-white/[0.05] border border-white/10 text-neutral-100 px-4 py-3 rounded-lg shadow-2xl">
          <Sparkles className="w-4 h-4 text-[#45d99a]" />
          <span className="text-xs font-semibold">{status}</span>
        </div>
      )}

      <div className="max-w-5xl w-full mx-auto flex flex-col gap-6">
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-5 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
            <div className="flex items-center gap-3">
              <FolderHeart className="w-5 h-5 text-[#45d99a]" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Perfiles</h2>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Nombre del perfil nuevo…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveCurrent(newName.trim())}
                className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 w-52 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-[#45d99a] focus:border-[#45d99a]"
              />
              <button
                onClick={() => saveCurrent(newName.trim())}
                disabled={!newName.trim()}
                className="inline-flex items-center gap-1.5 bg-[#45d99a] hover:bg-[#6fe0b3] disabled:opacity-40 disabled:hover:bg-[#45d99a] text-black font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3 rounded-md transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                Guardar actual
              </button>
            </div>
          </div>

          {profiles.length === 0 ? (
            <div className="text-center py-8 text-xs text-neutral-500">
              Aún no hay perfiles. Pon el mixer y la matriz como los quieres y pulsa «Guardar actual».
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {profiles.map(p => {
                const isActive = active === p.name
                const isDefault = config?.default_profile === p.name
                const created = parseCreated(p.created_at)
                const isEditing = editing?.name === p.name
                return (
                  <div
                    key={p.name}
                    className={`group relative flex flex-col rounded-xl border transition-all ${
                      isActive
                        ? 'border-[#45d99a] bg-[#45d99a]/[0.14] shadow-[0_0_18px_rgba(69,217,154,0.2)]'
                        : 'border-white/[0.08] bg-white/[0.04] hover:border-[#45d99a]/60'
                    }`}
                  >
                    {isEditing ? (
                      <form
                        className="flex flex-col gap-2 px-4 py-5"
                        onSubmit={e => { e.preventDefault(); commitEdit() }}
                      >
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                          {editing.kind === 'rename' ? 'Renombrar' : 'Duplicar como'}
                        </span>
                        <input
                          autoFocus
                          value={editing.value}
                          onChange={e => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={e => e.key === 'Escape' && setEditing(null)}
                          onBlur={commitEdit}
                          className="bg-black/30 border border-white/10 text-sm text-neutral-100 rounded-md py-1 px-2 focus:outline-none focus:ring-1 focus:ring-[#45d99a]"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => applyProfile(p.name)}
                        title={`Aplicar "${p.name}"`}
                        className="flex flex-col items-center gap-1.5 px-4 pt-6 pb-4 text-center cursor-pointer"
                      >
                        <span className="text-[15px] font-bold text-neutral-100 break-words max-w-full">{p.name}</span>
                        <span className="text-[10px] text-neutral-500">
                          {p.channels} canales · {p.links} enlaces
                        </span>
                        <span className="text-[10px] text-neutral-500" title={created?.toLocaleString('es')}>
                          {created ? `guardado ${relativeDate(created)}` : ''}
                        </span>
                        {isActive && <span className="text-[10px] font-semibold text-[#45d99a]">● activo</span>}
                      </button>
                    )}

                    {isDefault && (
                      <Star className="absolute top-2 left-2 w-3.5 h-3.5 text-[#45d99a] fill-current" aria-label="Perfil de arranque" />
                    )}

                    {!isEditing && (
                      <div className="flex items-center justify-center gap-0.5 pb-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => setDefaultProfile(isDefault ? '' : p.name)}
                          title={isDefault ? 'Quitar perfil de arranque' : 'Usar al arrancar'}
                          className={`${iconBtn} ${isDefault ? '!text-[#45d99a]' : ''}`}
                        >
                          <Star className="w-3.5 h-3.5 fill-current" />
                        </button>
                        <button onClick={() => updateProfile(p.name)} title="Actualizar con el estado actual" className={iconBtn}>
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditing({ kind: 'rename', name: p.name, value: p.name })} title="Renombrar" className={iconBtn}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditing({ kind: 'duplicate', name: p.name, value: `${p.name} copia` })} title="Duplicar" className={iconBtn}>
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteProfile(p.name)} title="Borrar" className={`${iconBtn} hover:!text-rose-400`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {config && (
          <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
            <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
              <Settings2 className="w-5 h-5 text-[#45d99a]" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Arranque</h2>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-neutral-300">Perfil de arranque</span>
                <span className="text-[11px] text-neutral-500">Se aplica solo cuando PipeWire conecta</span>
              </div>
              <select
                value={config.default_profile || ''}
                onChange={e => setDefaultProfile(e.target.value)}
                className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#45d99a] cursor-pointer"
              >
                <option value="">— Ninguno —</option>
                {profiles.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
