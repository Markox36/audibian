import React, { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Star, Trash2, Play, Save, Settings2, Sparkles, FolderHeart } from 'lucide-react'

export default function Profiles() {
  const [profiles, setProfiles] = useState([])
  const [config, setConfig] = useState(null)
  const [newName, setNewName] = useState('')
  const [status, setStatus] = useState('')

  const loadProfiles = () => {
    invoke('list_profiles').then(setProfiles).catch(console.error)
  }

  const loadConfig = () => {
    invoke('get_app_config').then(setConfig).catch(console.error)
  }

  useEffect(() => {
    loadProfiles()
    loadConfig()
  }, [])

  const showStatus = (msg, delay = 2500) => {
    setStatus(msg)
    setTimeout(() => setStatus(''), delay)
  }

  const applyProfile = (name) => {
    invoke('apply_profile_cmd', { name }).then(count => {
      showStatus(`Applied profile "${name}" — ${count} links active`)
    }).catch(e => showStatus(`Error applying profile: ${e}`))
  }

  const deleteProfile = (name) => {
    if (!confirm(`Delete profile "${name}"?`)) return
    invoke('delete_profile', { name }).then(() => {
      showStatus(`Deleted "${name}"`)
      loadProfiles()
    }).catch(console.error)
  }

  const snapshotProfile = () => {
    const name = newName.trim()
    if (!name) return
    invoke('snapshot_profile_cmd', { name }).then(ok => {
      if (ok) {
        showStatus(`Saved profile "${name}"`)
        setNewName('')
        loadProfiles()
      } else {
        showStatus('Failed to save profile')
      }
    }).catch(console.error)
  }

  const setDefaultProfile = (name) => {
    const updated = { ...config, default_profile: name || null }
    setConfig(updated)
    invoke('save_app_config', { config: updated }).then(() => {
      showStatus(`Default profile set to "${name || 'none'}"`)
    }).catch(console.error)
  }

  return (
    <div className="flex-1 overflow-auto bg-[#171717] p-6 flex flex-col gap-6 text-neutral-300 font-sans">
      {/* Floating Status Notification Toast */}
      {status && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-white/[0.05] border border-white/10 text-neutral-100 px-4 py-3 rounded-lg shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-300">
          <Sparkles className="w-4 h-4 text-[#4169e1]" />
          <span className="text-xs font-semibold">{status}</span>
        </div>
      )}

      {/* Main Profiles Panel */}
      <div className="max-w-4xl w-full mx-auto flex flex-col gap-6">
        
        {/* Saved Profiles Card Container */}
        <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
            <div className="flex items-center gap-3">
              <FolderHeart className="w-5 h-5 text-[#4169e1]" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Audio Profiles</h2>
            </div>
            
            {/* Input Snapshot Tool */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="New profile name..."
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && snapshotProfile()}
                className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 w-44 placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-[#4169e1] focus:border-[#4169e1]"
              />
              <button 
                onClick={snapshotProfile} 
                disabled={!newName.trim()}
                className="inline-flex items-center gap-1.5 bg-[#4169e1] hover:bg-[#5578e8] disabled:opacity-40 disabled:hover:bg-[#4169e1] text-black font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3 rounded-md transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                Save Current
              </button>
            </div>
          </div>

          {/* Profiles Grid / List */}
          {profiles.length === 0 ? (
            <div className="text-center py-8 text-xs text-neutral-500">
              No profiles saved yet. Use "Save Current" to snapshot the active matrix connections.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {profiles.map(name => {
                const isDefault = config?.default_profile === name
                return (
                  <div 
                    key={name} 
                    className={`flex items-center justify-between border rounded-lg p-3.5 transition-all ${
                      isDefault 
                        ? 'border-[#4169e1]/30 bg-[#4169e1]/[0.03] hover:bg-[#4169e1]/[0.05]' 
                        : 'border-white/[0.08] bg-white/[0.03] hover:border-white/[0.12] hover:bg-white/[0.06]/20'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-xs font-bold text-neutral-200 truncate">{name}</span>
                      {isDefault && (
                        <span className="bg-[#4169e1]/10 text-[#4169e1] border border-[#4169e1]/20 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wider uppercase">
                          default
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Star (Default Setting) */}
                      <button
                        onClick={() => setDefaultProfile(isDefault ? '' : name)}
                        title={isDefault ? 'Remove default status' : 'Set as default profile'}
                        className={`p-1.5 rounded hover:bg-white/[0.1] transition-colors ${
                          isDefault ? 'text-[#4169e1]' : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                      >
                        <Star className="w-4 h-4 fill-current" />
                      </button>

                      {/* Play (Apply Profile) */}
                      <button 
                        onClick={() => applyProfile(name)}
                        title="Apply Profile"
                        className="inline-flex items-center gap-1 bg-white/[0.08] hover:bg-white/[0.12] text-neutral-200 text-[10px] font-bold uppercase tracking-wider py-1 px-2.5 rounded border border-white/[0.12] transition-colors"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        Apply
                      </button>

                      {/* Delete Profile */}
                      <button 
                        onClick={() => deleteProfile(name)}
                        title="Delete Profile"
                        className="p-1.5 rounded hover:bg-rose-950/30 text-neutral-500 hover:text-rose-400 border border-transparent hover:border-rose-900/50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Global Configuration Setting Card */}
        {config && (
          <div className="border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-4 shadow-lg">
            <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
              <Settings2 className="w-5 h-5 text-[#4169e1]" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Startup Behavior</h2>
            </div>
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-neutral-300">Default Startup Profile</span>
                <span className="text-[11px] text-neutral-500">Automatically apply this profile when PipeWire connects</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <select
                  value={config.default_profile || ''}
                  onChange={e => setDefaultProfile(e.target.value)}
                  className="bg-white/[0.05] border border-white/10 text-xs text-neutral-100 rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#4169e1] cursor-pointer"
                >
                  <option value="">-- None --</option>
                  {profiles.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <button
                  onClick={() => invoke('save_app_config', { config }).catch(console.error).then(() => showStatus('Configuration saved successfully'))}
                  className="inline-flex items-center bg-white/[0.06] hover:bg-white/[0.1] text-neutral-200 font-extrabold text-[10px] tracking-wider uppercase py-1.5 px-3.5 border border-white/[0.12] rounded-md transition-colors"
                >
                  Save Config
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
