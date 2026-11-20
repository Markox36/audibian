import React, { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Settings as SettingsIcon, Monitor } from 'lucide-react'

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

export default function Settings({ uiScale, onScaleChange }) {
  const [autostart, setAutostart] = useState(false)

  useEffect(() => {
    invoke('get_app_config').then(cfg => setAutostart(!!cfg.autostart)).catch(console.error)
  }, [])

  // Always round-trips the whole config so the other fields survive the save.
  const saveField = async (patch) => {
    try {
      const cfg = await invoke('get_app_config')
      await invoke('save_app_config', { config: { ...cfg, ...patch } })
    } catch (e) {
      console.error('save_app_config failed', e)
    }
  }

  const save = (scale) => {
    onScaleChange(scale)
    saveField({ ui_scale: scale })
  }

  const toggleAutostart = (next) => {
    setAutostart(next)
    saveField({ autostart: next })
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#101013] text-neutral-300">
      <div className="max-w-md w-full border border-white/[0.08] bg-white/[0.05] rounded-xl p-6 flex flex-col gap-6 shadow-xl">
        <div className="flex items-center gap-3 border-b border-white/[0.08] pb-4">
          <SettingsIcon className="w-5 h-5 text-[#45d99a]" />
          <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200">Application Settings</h2>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-neutral-400 uppercase tracking-wider">
            <Monitor className="w-4 h-4 text-neutral-500" />
            <span>UI Scaling</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {SCALE_PRESETS.map(p => {
              const isActive = Math.abs(uiScale - p.value) < 0.01
              return (
                <button
                  key={p.value}
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

          <div className="flex items-center justify-between text-xs text-neutral-500 font-mono mt-2 pt-4 border-t border-white/[0.08]">
            <span>Current Scale:</span>
            <span className="font-bold text-neutral-400">{Math.round(uiScale * 100)}%</span>
          </div>

          <label className="flex items-center justify-between gap-3 text-xs mt-2 pt-4 border-t border-white/[0.08] cursor-pointer">
            <span className="flex flex-col gap-1">
              <span className="font-semibold text-neutral-300">Start with the session</span>
              <span className="text-[11px] text-neutral-500">Creates an XDG autostart entry</span>
            </span>
            <input
              type="checkbox"
              checked={autostart}
              onChange={e => toggleAutostart(e.target.checked)}
              className="h-4 w-4 accent-[#45d99a] cursor-pointer"
            />
          </label>
        </div>
      </div>
    </div>
  )
}
