import React, { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Power, Monitor, EyeOff, Trash2, X, FolderOpen, Sparkles } from 'lucide-react'
import { CREAM, FAINT, GREEN, PANEL_BG, RAIL_TEXT } from './theme'

// Device-chain footer for the selected MIDI channel — same idea as
// Ableton Live's bottom panel: pick a channel, its plugin slot shows up
// here instead of a separate tab/modal.
function PluginFooter({ channel, loaded, onClose, onRefresh }) {
  const [browsing, setBrowsing] = useState(false)
  const [scanPaths, setScanPaths] = useState([])
  const [manualPath, setManualPath] = useState('')

  if (!channel) return null
  const plugin = channel.plugins?.[0]

  const openBrowse = async () => {
    const paths = await invoke('midi_plugin_scan').catch(() => [])
    setScanPaths(paths)
    setBrowsing(true)
  }

  const addPlugin = async (path) => {
    const p = (path || '').trim()
    if (!p) return
    await invoke('midi_plugin_add', {
      channelId: channel.id,
      format: 'VST3',
      identifier: p,
      name: null,
    }).catch(console.error)
    setBrowsing(false)
    setManualPath('')
    onRefresh()
  }

  const removePlugin = async () => {
    if (!plugin) return
    await invoke('midi_plugin_unload', { channelId: channel.id }).catch(() => {})
    await invoke('midi_plugin_remove', { channelId: channel.id, pluginId: plugin.id }).catch(console.error)
    onRefresh()
  }

  return (
    <div
      className="shrink-0 border-t flex flex-col"
      style={{ backgroundColor: PANEL_BG, borderColor: FAINT, height: 130 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b" style={{ borderColor: FAINT }}>
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em]" style={{ color: CREAM }}>
          <Sparkles className="w-3.5 h-3.5" style={{ color: channel.color || GREEN }} />
          {channel.name}
        </div>
        <button onClick={onClose} className="hover:text-white transition-colors" style={{ color: RAIL_TEXT }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 flex items-center px-4 gap-4 overflow-x-auto">
        {!plugin ? (
          browsing ? (
            <div className="flex items-center gap-2 w-full">
              <select
                onChange={e => e.target.value && addPlugin(e.target.value)}
                defaultValue=""
                className="bg-white/[0.05] border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 max-w-md"
              >
                <option value="" disabled>
                  {scanPaths.length ? `${scanPaths.length} found in default VST3 paths…` : 'Nothing found in default VST3 paths'}
                </option>
                {scanPaths.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <span className="text-[9px]" style={{ color: RAIL_TEXT }}>or</span>
              <input
                value={manualPath}
                onChange={e => setManualPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addPlugin(manualPath) }}
                placeholder="/path/to/plugin.vst3"
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 font-mono flex-1 focus:outline-none focus:ring-1"
                style={{ '--tw-ring-color': GREEN }}
              />
              <button
                onClick={() => addPlugin(manualPath)}
                className="text-[10px] font-bold uppercase py-1.5 px-3 rounded-md shrink-0"
                style={{ backgroundColor: GREEN, color: 'black' }}
              >
                Add
              </button>
              <button
                onClick={() => setBrowsing(false)}
                className="text-[10px] font-semibold uppercase py-1.5 px-3 rounded-md shrink-0 bg-white/[0.05] border border-white/[0.08]"
                style={{ color: RAIL_TEXT }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={openBrowse}
              className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider py-2 px-4 rounded-md border border-dashed"
              style={{ color: RAIL_TEXT, borderColor: FAINT }}
            >
              <FolderOpen className="w-4 h-4" />
              Add Plugin (VST3)
            </button>
          )
        ) : (
          <>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-bold truncate" style={{ color: CREAM }}>{plugin.name}</span>
              <span className="text-[9px] font-mono truncate max-w-xs" style={{ color: RAIL_TEXT }} title={plugin.identifier}>
                {plugin.identifier}
              </span>
            </div>

            <div className="h-8 w-px shrink-0" style={{ backgroundColor: FAINT }} />

            <button
              onClick={() => invoke(loaded ? 'midi_plugin_unload' : 'midi_plugin_load', { channelId: channel.id }).then(onRefresh).catch(console.error)}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase py-1.5 px-3 rounded-md shrink-0"
              style={{
                backgroundColor: loaded ? 'transparent' : GREEN,
                color: loaded ? RAIL_TEXT : 'black',
                border: `1px solid ${loaded ? FAINT : GREEN}`,
              }}
            >
              <Power className="w-3.5 h-3.5" />
              {loaded ? 'Unload' : 'Load'}
            </button>

            <button
              onClick={() => invoke('midi_plugin_test_note', { channelId: channel.id }).catch(console.error)}
              disabled={!loaded}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase py-1.5 px-3 rounded-md shrink-0 bg-white/[0.05] border border-white/[0.08] disabled:opacity-40"
              style={{ color: CREAM }}
              title="Play a test note"
            >
              <Play className="w-3.5 h-3.5" />
              Test Note
            </button>

            <button
              onClick={() => invoke('midi_plugin_show_native_gui', { channelId: channel.id, pluginId: plugin.id }).catch(console.error)}
              disabled={!loaded}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase py-1.5 px-3 rounded-md shrink-0 bg-white/[0.05] border border-white/[0.08] disabled:opacity-40"
              style={{ color: CREAM }}
              title="Open the plugin's native window"
            >
              <Monitor className="w-3.5 h-3.5" />
              GUI
            </button>
            <button
              onClick={() => invoke('midi_plugin_hide_native_gui', { channelId: channel.id, pluginId: plugin.id }).catch(console.error)}
              disabled={!loaded}
              className="flex items-center justify-center p-1.5 rounded-md shrink-0 bg-white/[0.05] border border-white/[0.08] disabled:opacity-40 hover:text-white transition-colors"
              style={{ color: RAIL_TEXT }}
              title="Close the plugin window"
            >
              <EyeOff className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={removePlugin}
              className="flex items-center justify-center p-1.5 rounded-md shrink-0 bg-white/[0.05] border border-white/[0.08] hover:text-[#ff6b6e] transition-colors ml-auto"
              style={{ color: RAIL_TEXT }}
              title="Remove plugin"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export { PluginFooter }
