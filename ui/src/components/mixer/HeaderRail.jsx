import React from 'react'
import { RAIL_TEXT, RAIL_WIDTH } from './theme'


function HeaderRail() {
  const cells = ['Input', 'Sends', 'Output', 'Pan', 'Volume', 'Fader', 'Exclude']
  return (
    <div
      className="grid h-full select-none"
      style={{
        gridRow: 'span 7',
        gridTemplateRows: 'subgrid',
        padding: '4px 6px 6px 6px',
        borderTop: '2px solid transparent',
        minWidth: RAIL_WIDTH,
      }}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          className="flex items-center justify-end text-[9px] font-bold tracking-wider uppercase pr-2"
          style={{ color: RAIL_TEXT, pointerEvents: 'none', height: '100%' }}
        >
          {c}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Config modal

export { HeaderRail }
