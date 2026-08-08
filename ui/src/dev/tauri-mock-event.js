// Browser stand-in for `@tauri-apps/api/event`. See tauri-mock-core.js.
//
// Peak meters are driven by batched `pw-node-peaks` events from the Rust side:
// one event per frame carrying `[node_name, db_l, db_r]` tuples for every
// meter that moved. Here a timer feeds plausible levels in that same shape so
// the meters render at a realistic height instead of sitting at -inf, which is
// what decides how tall the meter row actually looks.

const SINKS = [
  'audibian_microfono', 'audibian_discord', 'audibian_brave',
  'audibian_spotify', 'audibian_soundboard', 'audibian_piano',
  'audibian_return_8', 'audibian_master',
]

export function listen(event, handler) {
  if (event !== 'pw-node-peaks') return Promise.resolve(() => {})

  let t = 0
  // 40ms matches the backend's batch interval.
  const timer = setInterval(() => {
    t += 0.08
    // Two detuned sines per channel so left and right differ and the stereo
    // meters are visibly independent.
    const batch = SINKS.map((name, i) => [
      name,
      -46 + 40 * Math.abs(Math.sin(t + i)),
      -46 + 40 * Math.abs(Math.sin(t * 1.13 + i * 0.7)),
    ])
    handler({ payload: batch })
  }, 40)

  return Promise.resolve(() => clearInterval(timer))
}
