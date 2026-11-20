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

const handlers = {
  get_mixer_config: () => state,
  get_solo_set: () => [],
  get_app_config: () => ({ ui_scale: 1.0, autostart: false, low_latency: false, default_profile: null }),
  get_graph: () => ({ nodes: {}, ports: {}, links: {} }),
}

export function invoke(cmd, args) {
  const fn = handlers[cmd]
  if (fn) return Promise.resolve(fn(args))
  // Mutations are no-ops: the fixture is what we want to look at.
  console.debug('[mock] invoke', cmd, args)
  return Promise.resolve(null)
}
