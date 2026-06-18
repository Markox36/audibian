import React, { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Trash2, Cpu, ExternalLink, Power, AlertTriangle, GripVertical, Monitor, EyeOff } from 'lucide-react'

// ---------------------------------------------------------------------------
// MIDI / VST channels. Each row is a Carla rack: audibian owns the channel,
// the sink, the plugin chain metadata; Carla hosts the actual plugins and
// edits parameter state. Mixer shows each channel as a regular strip.
// ---------------------------------------------------------------------------

const FORMATS = ['LV2', 'VST3', 'VST2', 'CLAP', 'SFZ']

export default function MidiChannels() {
  const [channels, setChannels] = useState([])
  const [carlaOk, setCarlaOk] = useState(true)
  const [embedAvailable, setEmbedAvailable] = useState(true)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(null) // { channel_id, format, identifier, name }

  const refresh = useCallback(() => {
    invoke('midi_channel_list').then(setChannels).catch(console.error)
  }, [])

  useEffect(() => {
    refresh()
    invoke('midi_carla_available').then(setCarlaOk).catch(() => setCarlaOk(false))
    invoke('midi_embed_available').then(setEmbedAvailable).catch(() => setEmbedAvailable(false))
  }, [refresh])

  const handleAddChannel = async () => {
    const name = newName.trim() || null
    await invoke('midi_channel_add', { name }).catch(console.error)
    setNewName('')
    refresh()
  }

  const handleRemove = (id) => {
    invoke('midi_channel_remove', { id }).then(refresh).catch(console.error)
  }

  const handleRename = (id, name) => {
    invoke('midi_channel_rename', { id, name }).then(refresh).catch(console.error)
  }

  const handleOpen = (id) => {
    invoke('midi_channel_open_gui', { id }).catch(console.error)
  }

  const handleClose = (id) => {
    invoke('midi_channel_close_gui', { id }).catch(console.error)
  }

  const commitPlugin = async () => {
    if (!adding) return
    const { channel_id, format, identifier, name } = adding
    const ident = (identifier || '').trim()
    if (!ident) return
    await invoke('midi_plugin_add', {
      channelId: channel_id,
      format,
      identifier: ident,
      name: (name || '').trim() || null,
    }).catch(console.error)
    setAdding(null)
    refresh()
  }

  const removePlugin = (channelId, pluginId) => {
    invoke('midi_plugin_remove', { channelId, pluginId }).then(refresh).catch(console.error)
  }

  const [embedded, setEmbedded] = useState({}) // key `${channelId}:${pluginId}` → true

  const showPluginGui = async (channelId, pluginId) => {
    await invoke('midi_plugin_show_native_gui', { channelId, pluginId }).catch(console.error)
    // Only mount embed slot when the session supports it. On Wayland the
    // plugin window stays floating; user can drag it manually.
    if (embedAvailable) {
      setEmbedded(e => ({ ...e, [`${channelId}:${pluginId}`]: true }))
    }
  }

  const hidePluginGui = async (channelId, pluginId) => {
    if (embedAvailable) {
      await invoke('midi_plugin_unembed_gui', { channelId, pluginId }).catch(() => {})
    }
    await invoke('midi_plugin_hide_native_gui', { channelId, pluginId }).catch(console.error)
    setEmbedded(e => {
      const next = { ...e }
      delete next[`${channelId}:${pluginId}`]
      return next
    })
  }

  const reorderPlugins = (channelId, pluginIds) => {
    invoke('midi_plugin_reorder', { channelId, pluginIds }).then(refresh).catch(console.error)
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#171717] text-neutral-300 font-sans overflow-hidden">

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/[0.04] border-b border-white/[0.08] gap-3 h-[42px] shrink-0 text-xs select-none">
        <div className="flex items-center gap-3">
          <Cpu className="w-3.5 h-3.5 text-[#7a638a]" />
          <span className="text-[10px] font-black tracking-[0.22em] text-neutral-100 uppercase">
            MIDI Channels
          </span>
          <span className="text-[9px] font-mono text-neutral-500">
            {channels.length} channel{channels.length === 1 ? '' : 's'} · plugins hosted in Carla
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddChannel() }}
            placeholder="New channel name"
            className="bg-black/40 border border-white/[0.08] text-[10px] text-neutral-100 rounded-md py-1 px-2 focus:outline-none focus:border-[#7a638a] w-44 font-sans"
          />
          <button
            onClick={handleAddChannel}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#7a638a]/20 hover:border-[#7a638a]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3 text-[#7a638a]" />
            Add Channel
          </button>
        </div>
      </div>

      {!carlaOk && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#a18c47]/10 border-b border-[#a18c47]/30 text-[10px] text-[#d4be75] font-mono shrink-0">
          <AlertTriangle className="w-3.5 h-3.5" />
          Carla not detected on PATH. Install <span className="font-bold">carla</span> (Debian/Ubuntu: <code>sudo apt install carla</code> · Arch: <code>sudo pacman -S carla</code>) to host plugins.
        </div>
      )}
      {carlaOk && !embedAvailable && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#4a6a8a]/10 border-b border-[#4a6a8a]/30 text-[10px] text-[#a9c4dd] font-mono shrink-0">
          <AlertTriangle className="w-3.5 h-3.5" />
          Wayland session detected — plugin windows can't be embedded inline. They'll open as floating windows. For inline embed, log in with an X11 session.
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <Cpu className="w-10 h-10 opacity-30 mb-3" />
            <div className="text-[11px] uppercase tracking-widest font-bold mb-1">No MIDI channels yet</div>
            <div className="text-[9px] font-mono opacity-70">Create a channel and open Carla to host LV2/VST3/CLAP instruments</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {channels.map(ch => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                carlaOk={carlaOk}
                onRename={handleRename}
                onRemove={handleRemove}
                onOpen={handleOpen}
                onClose={handleClose}
                onAddPlugin={() => setAdding({ channel_id: ch.id, format: 'LV2', identifier: '', name: '' })}
                onRemovePlugin={removePlugin}
                onReorderPlugins={reorderPlugins}
                onShowPluginGui={showPluginGui}
                onHidePluginGui={hidePluginGui}
                embedded={embedded}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add-plugin modal */}
      {adding && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setAdding(null)}
        >
          <div
            className="bg-[#1f1f1f] border border-white/[0.08] rounded-lg shadow-2xl max-w-md w-full flex flex-col gap-4 p-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#7a638a]" />
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-neutral-100">Add Plugin</span>
              </div>
            </div>

            <div className="grid grid-cols-[80px_1fr] gap-3">
              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">Format</label>
              <select
                value={adding.format}
                onChange={e => setAdding({ ...adding, format: e.target.value })}
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a]"
              >
                {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>

              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">
                {adding.format === 'LV2' ? 'URI' : 'Path'}
              </label>
              <input
                value={adding.identifier}
                onChange={e => setAdding({ ...adding, identifier: e.target.value })}
                placeholder={adding.format === 'LV2'
                  ? 'http://example.org/my-plugin'
                  : '/usr/lib/vst3/my-plugin.vst3'}
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a] font-mono"
              />

              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">Label</label>
              <input
                value={adding.name}
                onChange={e => setAdding({ ...adding, name: e.target.value })}
                placeholder="Display name (optional)"
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a]"
              />
            </div>

            <p className="text-[9px] text-neutral-500 font-mono leading-relaxed">
              Audibian records this entry for ordering / display. The actual plugin is loaded inside
              Carla — open the channel's host window with “Open Carla” and add the plugin there too
              (Carla persists its own project file at <code>~/.config/audibian/midi/midi_&lt;id&gt;.carxp</code>).
              For LV2 URIs, run <code>lv2ls</code> in a terminal to discover what's installed.
            </p>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3 mt-1">
              <button
                onClick={() => setAdding(null)}
                className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={commitPlugin}
                className="bg-[#7a638a] hover:bg-[#8e75a0] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors"
              >
                Add to chain
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ChannelRow({ channel, carlaOk, onRename, onRemove, onOpen, onClose, onAddPlugin, onRemovePlugin, onReorderPlugins, onShowPluginGui, onHidePluginGui, embedded }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(channel.name)
  useEffect(() => { setName(channel.name) }, [channel.name])

  const accent = channel.color || '#7a638a'

  const movePlugin = (idx, dir) => {
    const ids = channel.plugins.map(p => p.id)
    const j = idx + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    onReorderPlugins(channel.id, ids)
  }

  return (
    <div
      className="bg-[#1f1f1f] border border-white/[0.06] rounded-md p-3 flex flex-col gap-2"
      style={{ borderTop: `3px solid ${accent}` }}
    >
      <div className="flex items-center gap-3">
        <Cpu className="w-3.5 h-3.5" style={{ color: accent }} />
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => { setEditing(false); if (name.trim() && name !== channel.name) onRename(channel.id, name.trim()) }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { setName(channel.name); setEditing(false) }
            }}
            className="bg-black/40 border border-white/[0.08] text-[12px] text-neutral-100 font-bold px-2 py-0.5 rounded-sm flex-1 max-w-xs focus:outline-none focus:border-[#7a638a]"
          />
        ) : (
          <span
            onDoubleClick={() => setEditing(true)}
            className="text-[12px] font-bold text-neutral-100 cursor-text"
            title="Double-click to rename"
          >
            {channel.name}
          </span>
        )}
        <span className="text-[8.5px] font-mono text-neutral-500">{channel.sink_name}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onAddPlugin}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#7a638a]/15 hover:border-[#7a638a]/60 hover:text-white text-neutral-300 text-[9px] font-bold uppercase tracking-wider py-1 px-2 rounded-md transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            Plugin
          </button>
          <button
            onClick={() => onOpen(channel.id)}
            disabled={!carlaOk}
            className="bg-[#7a638a]/15 border border-[#7a638a]/40 hover:bg-[#7a638a]/30 hover:border-[#7a638a] text-[#c3b2cf] text-[9px] font-bold uppercase tracking-wider py-1 px-2 rounded-md transition-colors flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            title={carlaOk ? 'Open this channel\'s plugin rack in Carla' : 'Carla not installed'}
          >
            <ExternalLink className="w-3 h-3" />
            Open Carla
          </button>
          <button
            onClick={() => onClose(channel.id)}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-400 p-1.5 rounded-md transition-colors"
            title="Kill Carla process for this channel"
          >
            <Power className="w-3 h-3" />
          </button>
          <button
            onClick={() => {
              if (confirm(`Remove channel "${channel.name}"?`)) onRemove(channel.id)
            }}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#df4c55]/15 hover:border-[#df4c55]/60 hover:text-[#df4c55] text-neutral-400 p-1.5 rounded-md transition-colors"
            title="Remove channel"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {channel.plugins.length === 0 ? (
        <div className="text-[9px] text-neutral-600 font-mono italic px-1 py-2">No plugins in chain yet</div>
      ) : (
        <div className="flex flex-col gap-1">
          {channel.plugins.map((p, idx) => (
            <React.Fragment key={p.id}>
            <div
              className="flex items-center gap-2 bg-black/30 border border-white/[0.05] rounded-sm px-2 py-1.5"
            >
              <span className="text-neutral-600 font-mono text-[9px] w-5 text-right shrink-0">{idx + 1}</span>
              <span
                className="text-[8px] font-bold px-1.5 py-0.5 rounded-sm shrink-0"
                style={{ backgroundColor: `${accent}33`, color: accent }}
              >
                {p.format}
              </span>
              <span className="text-[10.5px] text-neutral-200 font-semibold truncate flex-1" title={p.identifier}>
                {p.name}
              </span>
              <span className="text-[8.5px] text-neutral-500 font-mono truncate max-w-[40%]" title={p.identifier}>
                {p.identifier}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => onShowPluginGui(channel.id, p.id)}
                  className="text-neutral-400 hover:text-[#7a638a] p-0.5"
                  title="Show plugin GUI (Carla must be running)"
                >
                  <Monitor className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onHidePluginGui(channel.id, p.id)}
                  className="text-neutral-500 hover:text-neutral-200 p-0.5"
                  title="Hide plugin GUI"
                >
                  <EyeOff className="w-3 h-3" />
                </button>
                <button
                  onClick={() => movePlugin(idx, -1)}
                  disabled={idx === 0}
                  className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed p-0.5 text-[10px]"
                  title="Move up"
                >▲</button>
                <button
                  onClick={() => movePlugin(idx, 1)}
                  disabled={idx === channel.plugins.length - 1}
                  className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed p-0.5 text-[10px]"
                  title="Move down"
                >▼</button>
                <button
                  onClick={() => onRemovePlugin(channel.id, p.id)}
                  className="text-neutral-500 hover:text-[#df4c55] p-0.5"
                  title="Remove plugin"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
            {embedded[`${channel.id}:${p.id}`] && (
              <PluginGuiSlot channelId={channel.id} pluginId={p.id} />
            )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// Reserved space for the embedded plugin window. Reports its on-screen
// rect to the backend so the X11 plugin window stays glued to this div
// even as the user scrolls or resizes audibian. Polls embed_gui until
// the plugin window appears (Carla can take a beat to map it).
function PluginGuiSlot({ channelId, pluginId }) {
  const ref = React.useRef(null)
  const [attached, setAttached] = useState(false)

  useEffect(() => {
    if (!ref.current) return

    const push = async (cmd) => {
      const r = ref.current?.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return false
      try {
        return await invoke(cmd, {
          channelId,
          pluginId,
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        })
      } catch { return false }
    }

    let cancelled = false
    let attempts = 0
    const tryEmbed = async () => {
      if (cancelled) return
      const ok = await push('midi_plugin_embed_gui')
      if (ok) { setAttached(true); return }
      attempts += 1
      if (attempts > 30) return // ~6s
      setTimeout(tryEmbed, 200)
    }
    tryEmbed()

    const reposition = () => push('midi_plugin_position_gui')
    const ro = new ResizeObserver(reposition)
    ro.observe(ref.current)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      cancelled = true
      ro.disconnect()
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [channelId, pluginId])

  return (
    <div
      ref={ref}
      className="w-full bg-black/40 border border-white/[0.05] rounded-sm flex items-center justify-center text-[9px] font-mono text-neutral-500"
      style={{ height: 420 }}
    >
      {attached ? '' : 'Waiting for plugin window…'}
    </div>
  )
}
