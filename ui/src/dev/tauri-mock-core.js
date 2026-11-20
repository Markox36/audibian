// Browser stand-in for `@tauri-apps/api/core`, wired in by vite.config.js
// when AUDIBIAN_UI_MOCK=1.
//
// Purpose: iterate on the UI in a normal browser window. Running the real app
// a second time (`cargo tauri dev`, or launching the AppImage again) starts a
// second Audibian that fights the running one for the PipeWire graph and
// leaves duplicate pactl modules behind. This never touches PipeWire.
//
// The fixture mirrors a realistic session: several inputs, one return bus and
// a master, so strip widths and overflow behave like they do in practice.

const state = {
  input_channels: [
    { id: 1, name: 'Microfono', sink_name: 'audibian_microfono', order: 0, fader: 1.0, pan: 0, muted: false, color: null, source_name: 'AIR 192 4' },
    { id: 2, name: 'Discord',   sink_name: 'audibian_discord',   order: 1, fader: 0.8, pan: 0, muted: false, color: null, source_name: null },
    { id: 3, name: 'Brave',     sink_name: 'audibian_brave',     order: 2, fader: 0.8, pan: 0, muted: false, color: null, source_name: null },
    { id: 4, name: 'Spotify',   sink_name: 'audibian_spotify',   order: 3, fader: 0.7, pan: -0.3, muted: false, color: null, source_name: null },
    { id: 5, name: 'Soundboard',sink_name: 'audibian_soundboard',order: 4, fader: 0.6, pan: 0, muted: false, color: null, source_name: null },
    { id: 6, name: 'Piano',     sink_name: 'audibian_piano',     order: 5, fader: 0.9, pan: 0.2, muted: false, color: null, source_name: null },
  ],
  return_channels: [
    { id: 8, name: 'Reverb', sink_name: 'audibian_return_8', order: 0, fader: 0.75, pan: 0, muted: false, color: null },
  ],
  sends: [
    { input_channel_id: 1, return_channel_id: 8, enabled: true },
    { input_channel_id: 5, return_channel_id: 8, enabled: true },
    { input_channel_id: 6, return_channel_id: 8, enabled: true },
  ],
  master_sink: 'alsa_output.usb-M-Audio_AIR_192_4-00.analog-stereo',
  master_fader: 1.0,
  master_pan: 0,
  master_muted: false,
  global_scale: 1.0,
}


// --- Matrix / soundboard / MIDI fixtures -----------------------------------
const mkNode = (id, name, media_class, extra = {}) => ({
  id, name, nick: null, description: extra.description ?? name, app_name: extra.app_name ?? null,
  node_type: 'Unknown', media_class, x: 0, y: 0, volume: 1, muted: false,
})
const NODES = [
  mkNode(10, 'brave', 'Stream/Output/Audio', { description: 'Brave', app_name: 'Brave' }),
  mkNode(11, 'spotify', 'Stream/Output/Audio', { description: 'Spotify', app_name: 'Spotify' }),
  mkNode(12, 'discord', 'Stream/Output/Audio', { description: 'Discord', app_name: 'WEBRTC VoiceEngine' }),
  mkNode(20, 'alsa_input.usb-air', 'Audio/Source', { description: 'AIR 192 4 (micrófono)' }),
  mkNode(30, 'alsa_output.usb-air', 'Audio/Sink', { description: 'Auriculares (AIR 192 4)' }),
  mkNode(31, 'alsa_output.speakers', 'Audio/Sink', { description: 'Altavoces' }),
  mkNode(40, 'obs-capture', 'Stream/Input/Audio', { description: 'OBS (captura)', app_name: 'OBS' }),
]
const PORTS = []
let pid = 100
for (const n of NODES) {
  const mc = n.media_class
  const outs = mc.startsWith('Stream/Output') || mc === 'Audio/Source'
  const ins = mc === 'Audio/Sink' || mc.startsWith('Stream/Input')
  for (const [i, ch] of ['FL', 'FR'].entries()) {
    if (outs) PORTS.push({ id: pid++, node_id: n.id, name: `output_${ch}`, direction: 'Output', media_type: 'Audio', port_index: i })
    if (ins) PORTS.push({ id: pid++, node_id: n.id, name: `playback_${ch}`, direction: 'Input', media_type: 'Audio', port_index: i })
  }
}
const portOf = (node, dir, i) => PORTS.find(p => p.node_id === node && p.direction === dir && p.port_index === i)
const LINKS = []
let lid = 500
const stereo = (a, b) => [0, 1].forEach(i => {
  const o = portOf(a, 'Output', i), n = portOf(b, 'Input', i)
  LINKS.push({ id: lid++, output_node_id: a, output_port_id: o.id, input_node_id: b, input_port_id: n.id, active: true })
})
stereo(10, 30); stereo(11, 30); stereo(11, 31); stereo(12, 30); stereo(12, 40); stereo(20, 40)
const byId = (arr) => Object.fromEntries(arr.map(x => [x.id, x]))
const GRAPH = { nodes: byId(NODES), ports: byId(PORTS), links: byId(LINKS) }

const SOUNDS = [
  { id: 2, name: 'fplol', path: '/x/2.mp3', duration_ms: 25536, start_ms: null, end_ms: 5000, key: 'Q', color: '#a18c47' },
  { id: 3, name: 'superestrella', path: '/x/3.mp3', duration_ms: 5184, start_ms: null, end_ms: 2000, key: 'W', color: null },
  { id: 4, name: 'panchito-repartidor', path: '/x/4.mp3', duration_ms: 15073, start_ms: null, end_ms: 5000, key: null, color: '#4169e1' },
  { id: 5, name: 'symphony', path: '/x/5.wav', duration_ms: 5317, start_ms: null, end_ms: null, key: 'E', color: null },
  { id: 6, name: 'latigo', path: '/x/6.mp3', duration_ms: 1149, start_ms: null, end_ms: null, key: null, color: null },
]
const MIDI = [
  { id: 30, name: 'Piano', sink_name: 'audibian_piano', color: null, fader: 0.9, pan: 0, muted: false, plugins: [
    { id: 1, format: 'VST3', identifier: '/home/u/.vst3/Pianoteq 8.vst3', name: 'Pianoteq 8' },
    { id: 2, format: 'VST3', identifier: '/home/u/.vst3/Reverb.vst3', name: 'Reverb' } ] },
  { id: 31, name: 'Kontakt', sink_name: 'audibian_kontakt', color: null, fader: 1, pan: 0, muted: false, plugins: [] },
]

const handlers = {
  get_mixer_config: () => state,
  get_solo_set: () => [],
  get_app_config: () => ({ ui_scale: 1.0, autostart: false, low_latency: false, default_profile: 'Streaming' }),
  list_profiles_info: () => [
    { name: 'Streaming', created_at: '2026-11-17T14:03:12Z', channels: 6, links: 14 },
    { name: 'Música', created_at: '20400d 09:10:00 UTC', channels: 4, links: 8 },
    { name: 'Gaming', created_at: '2026-11-06T20:00:00Z', channels: 5, links: 11 },
  ],
  get_graph: () => GRAPH,
  get_pw_status: () => ({ quantum: 256, rate: 48000 }),
  get_node_activity: () => [10, 12, 20],
  get_ns_active: () => [],
  get_eq_target: () => null,
  soundboard_list: () => SOUNDS,
  midi_channel_list: () => MIDI,
  midi_loaded_channel_ids: () => [30],
  list_profiles: () => ['Streaming', 'Música', 'Gaming'],
  soundboard_set_meta: () => null,
}

export function invoke(cmd, args) {
  const fn = handlers[cmd]
  if (fn) return Promise.resolve(fn(args))
  // Mutations are no-ops: the fixture is what we want to look at.
  console.debug('[mock] invoke', cmd, args)
  return Promise.resolve(null)
}
