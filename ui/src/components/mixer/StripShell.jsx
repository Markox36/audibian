import React from 'react'
import { CREAM, STRIP_BG } from './theme'


function StripFrame({ accent, children, dragClasses, style, onDragOver, onDragLeave, onDrop, editing }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`grid h-full transition-all duration-200 ${dragClasses}`}
      style={{
        gridRow: 'span 7',
        gridTemplateRows: 'subgrid',
        gridTemplateColumns: '1fr',
        width: '100%',
        minWidth: 0,
        overflow: 'hidden',
        padding: '4px 4px 6px 4px',
        backgroundColor: STRIP_BG,
        borderRadius: 4,
        border: '1px solid rgba(255, 255, 255, 0.03)',
        borderTop: `2px solid ${editing ? accent : 'transparent'}`,
        color: CREAM,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function CellLabel({ children, color = CREAM, ...rest }) {
  return (
    <div
      className="text-[9px] font-bold tracking-wider uppercase text-center truncate px-1 leading-none flex items-center justify-center w-full h-full bg-black/25 border border-white/[0.04] rounded-sm"
      style={{ color }}
      {...rest}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Input strip

export { StripFrame, CellLabel }
