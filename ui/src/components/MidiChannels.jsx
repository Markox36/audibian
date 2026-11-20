import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  Trash2,
  Cpu,
  Play,
  Power,
  AlertTriangle,
  Monitor,
  EyeOff,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { subscribeBars, subscribeReadout } from "./mixer/meterStore";
import { GREEN, RED } from "./mixer/theme";

// ---------------------------------------------------------------------------
// MIDI / VST channels as a vertical rack. Each row hosts a plugin in-process
// (see src/midi/ on the Rust side) — audibian owns the channel, the sink, and
// the plugin itself, no external host. Mixer shows each channel as a regular
// strip.
//
// TRUTH: the backend host only loads `plugins[0]` of a channel
// (`midi_plugin_load`). Chips ②+ are stored and reorderable but are NOT
// processed; they are rendered muted and labelled as such.
// ---------------------------------------------------------------------------

const FORMATS = ["VST3"];
const CHAIN_WARNING =
  "Solo el primer plugin se carga; la cadena en serie aún no está soportada";
const LOADED_POLL_MS = 3000;

export default function MidiChannels() {
  const [channels, setChannels] = useState([]);
  const [loadedIds, setLoadedIds] = useState(() => new Set());
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(null); // { channel_id, format, identifier, name }

  const fail = (what) => (e) => setError(`${what}: ${e?.message ?? e}`);

  const refreshLoaded = useCallback(() => {
    invoke("midi_loaded_channel_ids")
      .then((ids) => setLoadedIds(new Set(Array.isArray(ids) ? ids : [])))
      // Background poll, not a user action: keep the last known state.
      .catch(console.error);
  }, []);

  const refresh = useCallback(() => {
    invoke("midi_channel_list")
      .then((list) => setChannels(Array.isArray(list) ? list : []))
      .catch((e) => setError(`No se pudieron listar los canales: ${e?.message ?? e}`));
    refreshLoaded();
  }, [refreshLoaded]);

  useEffect(() => {
    refresh();
    const t = setInterval(refreshLoaded, LOADED_POLL_MS);
    return () => clearInterval(t);
  }, [refresh, refreshLoaded]);

  const handleAddChannel = async () => {
    const name = newName.trim() || null;
    await invoke("midi_channel_add", { name }).catch(
      fail("No se pudo crear el canal"),
    );
    setNewName("");
    refresh();
  };

  const handleRemove = (id) => {
    invoke("midi_channel_remove", { id })
      .then(refresh)
      .catch(fail("No se pudo eliminar el canal"));
  };

  const handleRename = (id, name) => {
    invoke("midi_channel_rename", { id, name })
      .then(refresh)
      .catch(fail("No se pudo renombrar el canal"));
  };

  const setBusy = (id, on) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleLoad = async (id) => {
    setBusy(id, true);
    try {
      const ok = await invoke("midi_plugin_load", { channelId: id });
      if (ok === false)
        setError(
          "No se pudo cargar el plugin del canal (¿ruta .vst3 válida y formato VST3?)",
        );
    } catch (e) {
      fail("No se pudo cargar el plugin")(e);
    } finally {
      setBusy(id, false);
      refreshLoaded();
    }
  };

  const handleUnload = async (id) => {
    setBusy(id, true);
    try {
      await invoke("midi_plugin_unload", { channelId: id });
    } catch (e) {
      fail("No se pudo descargar el plugin")(e);
    } finally {
      setBusy(id, false);
      refreshLoaded();
    }
  };

  const handleTestNote = (id) => {
    invoke("midi_plugin_test_note", { channelId: id })
      .then((ok) => {
        if (ok === false)
          setError("No se pudo enviar la nota: el plugin del canal no está cargado");
      })
      .catch(fail("No se pudo enviar la nota de prueba"));
  };

  const commitPlugin = async () => {
    if (!adding) return;
    const { channel_id, format, identifier, name } = adding;
    const ident = (identifier || "").trim();
    if (!ident) return;
    await invoke("midi_plugin_add", {
      channelId: channel_id,
      format,
      identifier: ident,
      name: (name || "").trim() || null,
    }).catch(fail("No se pudo añadir el plugin"));
    setAdding(null);
    refresh();
  };

  const removePlugin = (channelId, pluginId) => {
    invoke("midi_plugin_remove", { channelId, pluginId })
      .then(refresh)
      .catch(fail("No se pudo quitar el plugin"));
  };

  const showPluginGui = (channelId, pluginId) =>
    invoke("midi_plugin_show_native_gui", { channelId, pluginId })
      .then((ok) => {
        if (ok === false)
          setError("No se pudo abrir la GUI: carga primero el plugin del canal");
      })
      .catch(fail("No se pudo abrir la GUI del plugin"));

  const hidePluginGui = (channelId, pluginId) =>
    invoke("midi_plugin_hide_native_gui", { channelId, pluginId }).catch(
      fail("No se pudo ocultar la GUI del plugin"),
    );

  const reorderPlugins = (channelId, pluginIds) => {
    invoke("midi_plugin_reorder", { channelId, pluginIds })
      .then(refresh)
      .catch(fail("No se pudo reordenar la cadena"));
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#101013] text-neutral-300 font-sans overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-white/[0.04] border-b border-white/[0.08] gap-3 h-[42px] shrink-0 text-xs select-none">
        <div className="flex items-center gap-3">
          <Cpu className="w-3.5 h-3.5 text-[#7a638a]" />
          <span className="text-[10px] font-black tracking-[0.22em] text-neutral-100 uppercase">
            Canales MIDI
          </span>
          <span className="text-[9px] font-mono text-neutral-500">
            {channels.length} canal{channels.length === 1 ? "" : "es"} ·
            plugins alojados en el proceso
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddChannel();
            }}
            placeholder="Nombre del canal nuevo"
            aria-label="Nombre del canal nuevo"
            className="bg-black/40 border border-white/[0.08] text-[10px] text-neutral-100 rounded-md py-1 px-2 focus:outline-none focus:border-[#7a638a] w-44 font-sans"
          />
          <button
            onClick={handleAddChannel}
            className="bg-white/[0.05] border border-white/[0.08] hover:bg-[#7a638a]/20 hover:border-[#7a638a]/60 hover:text-white text-neutral-200 text-[9px] font-bold uppercase tracking-wider py-1 px-2.5 rounded-md transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3 text-[#7a638a]" />
            Añadir canal
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 px-4 py-2 bg-[#4a6a8a]/10 border-b border-[#4a6a8a]/30 text-[10px] text-[#a9c4dd] font-mono shrink-0">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span>
          {CHAIN_WARNING}. Tras reordenar o quitar el primer plugin, vuelve a
          cargar el canal. Las GUIs se abren en su propia ventana y los plugins
          cargados reciben MIDI en vivo de los teclados conectados.
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-4 py-2 bg-[#ff6b6e]/10 border-b border-[#ff6b6e]/30 text-[10px] text-[#ff9fa1] font-mono shrink-0"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Cerrar aviso"
            className="text-[#ff9fa1] hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <Cpu className="w-10 h-10 opacity-30 mb-3" />
            <div className="text-[11px] uppercase tracking-widest font-bold mb-1">
              Aún no hay canales MIDI
            </div>
            <div className="text-[9px] font-mono opacity-70">
              Crea un canal y carga un instrumento VST3 para empezar
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {channels.map((ch) => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                loaded={loadedIds.has(ch.id)}
                busy={busyIds.has(ch.id)}
                onRename={handleRename}
                onRemove={handleRemove}
                onLoad={handleLoad}
                onUnload={handleUnload}
                onTestNote={handleTestNote}
                onAddPlugin={() =>
                  setAdding({
                    channel_id: ch.id,
                    format: "VST3",
                    identifier: "",
                    name: "",
                  })
                }
                onRemovePlugin={removePlugin}
                onReorderPlugins={reorderPlugins}
                onShowPluginGui={showPluginGui}
                onHidePluginGui={hidePluginGui}
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
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#7a638a]" />
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-neutral-100">
                  Añadir plugin
                </span>
              </div>
            </div>

            <div className="grid grid-cols-[80px_1fr] gap-3">
              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">
                Formato
              </label>
              <select
                value={adding.format}
                onChange={(e) =>
                  setAdding({ ...adding, format: e.target.value })
                }
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a]"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>

              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">
                Ruta
              </label>
              <input
                value={adding.identifier}
                onChange={(e) =>
                  setAdding({ ...adding, identifier: e.target.value })
                }
                placeholder="/usr/lib/vst3/my-plugin.vst3"
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a] font-mono"
              />

              <label className="text-[9px] font-bold text-neutral-400 uppercase tracking-wider self-center">
                Etiqueta
              </label>
              <input
                value={adding.name}
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                placeholder="Nombre visible (opcional)"
                className="bg-black/40 border border-white/[0.08] text-xs text-neutral-100 rounded-md py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-[#7a638a]"
              />
            </div>

            <p className="text-[9px] text-neutral-500 font-mono leading-relaxed">
              Apunta a un bundle <code>.vst3</code>. {CHAIN_WARNING}: pulsa el
              botón de encendido de la fila del canal para alojarlo.
            </p>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3 mt-1">
              <button
                onClick={() => setAdding(null)}
                className="bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.1] text-neutral-300 text-xs font-semibold py-1.5 px-4 rounded-md transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={commitPlugin}
                className="bg-[#7a638a] hover:bg-[#8e75a0] text-white text-xs font-bold py-1.5 px-4 rounded-md transition-colors"
              >
                Añadir a la cadena
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ICON_BTN =
  "bg-white/[0.05] border border-white/[0.08] text-neutral-400 p-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

function ChannelRow({
  channel,
  loaded,
  busy,
  onRename,
  onRemove,
  onLoad,
  onUnload,
  onTestNote,
  onAddPlugin,
  onRemovePlugin,
  onReorderPlugins,
  onShowPluginGui,
  onHidePluginGui,
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const [dragIdx, setDragIdx] = useState(null);
  useEffect(() => {
    setName(channel.name);
  }, [channel.name]);

  const accent = channel.color || "#7a638a";
  const plugins = channel.plugins || [];
  const first = plugins[0];

  // Level meter: the meter store writes these elements directly (no React
  // renders per level change). Same wiring as MidiStrip / MeterFader.
  const barLRef = useRef(null);
  const barRRef = useRef(null);
  const readoutRef = useRef(null);
  useEffect(() => {
    const unBars = subscribeBars(
      channel.sink_name,
      barLRef.current,
      barRRef.current,
    );
    const unReadout = subscribeReadout(channel.sink_name, readoutRef.current);
    return () => {
      unBars();
      unReadout();
    };
  }, [channel.sink_name]);

  const moveTo = (from, to) => {
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from === to ||
      to < 0 ||
      to >= plugins.length
    )
      return;
    const ids = plugins.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorderPlugins(channel.id, ids);
  };

  const meterBar = (ref) => (
    <div className="relative w-2 h-10 rounded-[1px] border border-white/[0.07] bg-black/70 overflow-hidden">
      <div
        ref={ref}
        className="absolute inset-0 origin-bottom will-change-transform"
        style={{
          transform: "scaleY(0)",
          background: `linear-gradient(to top, ${GREEN} 0%, ${GREEN} 78%, ${RED} 100%)`,
        }}
      />
    </div>
  );

  return (
    <div
      className="bg-white/[0.05] border border-white/[0.08] rounded-xl p-3 flex items-center gap-4"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      {/* Name + transport */}
      <div className="flex flex-col gap-1.5 w-56 shrink-0 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor: loaded ? GREEN : "rgba(255,255,255,0.18)",
            }}
            title={loaded ? "Plugin cargado" : "Plugin sin cargar"}
          />
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (name.trim() && name !== channel.name)
                  onRename(channel.id, name.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setName(channel.name);
                  setEditing(false);
                }
              }}
              aria-label="Nombre del canal"
              className="bg-black/40 border border-white/[0.08] text-[12px] text-neutral-100 font-bold px-2 py-0.5 rounded-sm flex-1 min-w-0 focus:outline-none focus:border-[#7a638a]"
            />
          ) : (
            <span
              role="button"
              tabIndex={0}
              onDoubleClick={() => setEditing(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "F2") setEditing(true);
              }}
              className="text-[12px] font-bold text-neutral-100 cursor-text truncate focus:outline-none focus-visible:ring-1 focus-visible:ring-[#7a638a] rounded-sm"
              title="Doble clic (o Enter) para renombrar"
            >
              {channel.name}
            </span>
          )}
        </div>
        <div
          className="text-[8.5px] font-mono text-neutral-500 truncate"
          title={channel.sink_name}
        >
          {channel.sink_name}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => (loaded ? onUnload(channel.id) : onLoad(channel.id))}
            disabled={busy || (!loaded && !first)}
            aria-pressed={loaded}
            className={`${ICON_BTN} ${
              loaded
                ? "!bg-[#45d99a]/15 !border-[#45d99a]/60 !text-[#45d99a] hover:!bg-[#ff6b6e]/15 hover:!border-[#ff6b6e]/60 hover:!text-[#ff6b6e]"
                : "hover:bg-[#45d99a]/15 hover:border-[#45d99a]/60 hover:text-[#45d99a]"
            }`}
            title={
              loaded
                ? "Descargar el plugin del canal"
                : first
                  ? `Cargar «${first.name}»`
                  : "Añade un plugin primero"
            }
            aria-label={loaded ? "Descargar plugin" : "Cargar plugin"}
          >
            <Power className="w-3 h-3" />
          </button>
          <button
            onClick={() => onShowPluginGui(channel.id, first?.id)}
            disabled={!loaded || !first}
            className={`${ICON_BTN} hover:text-[#7a638a]`}
            title="Mostrar la GUI del plugin cargado"
            aria-label="Mostrar GUI del plugin"
          >
            <Monitor className="w-3 h-3" />
          </button>
          <button
            onClick={() => onHidePluginGui(channel.id, first?.id)}
            disabled={!loaded || !first}
            className={`${ICON_BTN} hover:text-neutral-100`}
            title="Ocultar la GUI del plugin"
            aria-label="Ocultar GUI del plugin"
          >
            <EyeOff className="w-3 h-3" />
          </button>
          <button
            onClick={() => onTestNote(channel.id)}
            disabled={!loaded}
            className={`${ICON_BTN} hover:bg-[#45d99a]/15 hover:border-[#45d99a]/60 hover:text-[#45d99a]`}
            title="Tocar una nota de prueba en el plugin cargado"
            aria-label="Nota de prueba"
          >
            <Play className="w-3 h-3" />
          </button>
          <button
            onClick={() => {
              if (confirm(`¿Eliminar el canal "${channel.name}"?`))
                onRemove(channel.id);
            }}
            className={`${ICON_BTN} hover:bg-[#ff6b6e]/15 hover:border-[#ff6b6e]/60 hover:text-[#ff6b6e]`}
            title="Eliminar canal"
            aria-label="Eliminar canal"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Plugin chain */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="text-[8.5px] font-bold uppercase tracking-wider text-neutral-500">
          Cadena de plugins
        </div>
        <div className="flex items-center flex-wrap gap-1.5">
          {plugins.map((p, idx) => {
            const muted = idx > 0;
            return (
              <React.Fragment key={p.id}>
                {idx > 0 && (
                  <span className="text-neutral-600 text-[11px]" aria-hidden>
                    →
                  </span>
                )}
                <div
                  draggable
                  onDragStart={(e) => {
                    setDragIdx(idx);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(p.id));
                  }}
                  onDragOver={(e) => {
                    if (dragIdx !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    moveTo(dragIdx, idx);
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  title={muted ? `${CHAIN_WARNING}\n${p.identifier}` : p.identifier}
                  className={`flex items-center gap-1 rounded-md pl-1.5 pr-0.5 py-0.5 cursor-grab ${
                    muted
                      ? "border border-dashed border-white/[0.15] bg-white/[0.02] opacity-55"
                      : "border bg-black/30"
                  } ${dragIdx === idx ? "opacity-40" : ""}`}
                  style={muted ? undefined : { borderColor: `${accent}99` }}
                >
                  <span
                    className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center shrink-0"
                    style={
                      muted
                        ? { backgroundColor: "rgba(255,255,255,0.08)", color: "#8a8a8a" }
                        : { backgroundColor: `${accent}33`, color: accent }
                    }
                  >
                    {idx + 1}
                  </span>
                  <span
                    className={`text-[10.5px] font-semibold truncate max-w-[160px] ${
                      muted ? "text-neutral-400" : "text-neutral-100"
                    }`}
                  >
                    {p.name}
                  </span>
                  {muted && (
                    <span className="text-[8px] font-mono uppercase text-neutral-500">
                      inactivo
                    </span>
                  )}
                  <button
                    onClick={() => moveTo(idx, idx - 1)}
                    disabled={idx === 0}
                    className="text-neutral-500 hover:text-neutral-100 disabled:opacity-25 disabled:cursor-not-allowed p-0.5"
                    title="Mover a la izquierda"
                    aria-label={`Mover ${p.name} a la izquierda`}
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => moveTo(idx, idx + 1)}
                    disabled={idx === plugins.length - 1}
                    className="text-neutral-500 hover:text-neutral-100 disabled:opacity-25 disabled:cursor-not-allowed p-0.5"
                    title="Mover a la derecha"
                    aria-label={`Mover ${p.name} a la derecha`}
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => onRemovePlugin(channel.id, p.id)}
                    className="text-neutral-500 hover:text-[#ff6b6e] p-0.5"
                    title="Quitar plugin"
                    aria-label={`Quitar ${p.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </React.Fragment>
            );
          })}
          {plugins.length > 0 && (
            <span className="text-neutral-600 text-[11px]" aria-hidden>
              →
            </span>
          )}
          <button
            onClick={onAddPlugin}
            className="border border-dashed border-white/[0.2] hover:border-[#7a638a] hover:bg-[#7a638a]/15 hover:text-white text-neutral-400 rounded-md p-1 transition-colors"
            title="Añadir plugin a la cadena"
            aria-label="Añadir plugin"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {plugins.length === 0 ? (
          <div className="text-[9px] text-neutral-600 font-mono italic">
            Sin plugins en la cadena
          </div>
        ) : (
          plugins.length > 1 && (
            <div className="text-[9px] text-neutral-500 font-mono">
              {CHAIN_WARNING}.
            </div>
          )
        )}
      </div>

      {/* Output meter */}
      <div
        className={`flex items-end gap-2 shrink-0 ${loaded ? "" : "opacity-50"}`}
        title="Nivel de salida del canal"
      >
        <div className="flex gap-0.5">
          {meterBar(barLRef)}
          {meterBar(barRRef)}
        </div>
        <div className="flex flex-col items-end gap-0.5 w-12">
          <span
            ref={readoutRef}
            className="text-[10px] font-mono font-bold px-1 rounded-sm tabular-nums"
            style={{ backgroundColor: "rgba(0,0,0,0.25)", color: GREEN }}
          >
            -inf
          </span>
          <span className="text-[8px] font-mono uppercase text-neutral-500">
            dB
          </span>
        </div>
      </div>
    </div>
  );
}
