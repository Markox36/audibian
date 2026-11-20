// Coalesces backend writes made while dragging a control.
//
// Every `invoke` here shells out to `pactl`; a mousemove stream fires far
// faster than that round-trip, so only the latest value is kept and sent once
// per animation frame. `flush()` on mouse-up guarantees the final value is
// actually delivered.
export function createRafSend() {
  let pending = null
  let raf = 0

  const run = () => {
    raf = 0
    const fn = pending
    pending = null
    if (fn) fn()
  }

  return {
    queue(fn) {
      pending = fn
      if (!raf) raf = requestAnimationFrame(run)
    },
    flush() {
      if (raf) {
        cancelAnimationFrame(raf)
        run()
      }
    },
  }
}
