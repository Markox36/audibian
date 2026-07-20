// Browser stand-in for `@tauri-apps/api/event`. See tauri-mock-core.js.
//
// Peak meters are driven by `pw-node-peak` events from the Rust side. Here a
// timer feeds plausible levels so the meters render at a realistic height
// instead of sitting at -inf, which is what decides how tall the meter row
// actually looks.

const SINKS = [
  'audibian_microfono', 'audibian_discord', 'audibian_brave',
  'audibian_spotify', 'audibian_soundboard', 'audibian_piano',
  'audibian_return_8', 'audibian_master',
]

export function listen(event, handler) {
  if (event !== 'pw-node-peak') return Promise.resolve(() => {})

  let t = 0
  const timer = setInterval(() => {
    t += 0.08
    SINKS.forEach((name, i) => {
      // Two detuned sines per channel so left and right differ and the
      // stereo meters are visibly independent.
      const l = -46 + 40 * Math.abs(Math.sin(t + i))
      const r = -46 + 40 * Math.abs(Math.sin(t * 1.13 + i * 0.7))
      handler({ payload: { node_name: name, db: Math.max(l, r), db_l: l, db_r: r } })
    })
  }, 80)

  return Promise.resolve(() => clearInterval(timer))
}
