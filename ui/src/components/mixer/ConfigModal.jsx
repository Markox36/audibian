import React, { useState, useEffect } from 'react'
import { Settings, X } from 'lucide-react'
import { CREAM, GREEN, RAIL_TEXT } from './theme'


function ConfigModal({ modal, onSave, onCancel }) {
  const [localModal, setLocalModal] = useState(modal)
  useEffect(() => { setLocalModal(modal) }, [modal])
  if (!localModal) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-[#1a1a1a] border border-white/[0.08] rounded-lg shadow-2xl max-w-sm w-full flex flex-col gap-4 p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4" style={{ color: GREEN }} />
            <span className="text-[11px] font-extrabold uppercase tracking-widest" style={{ color: CREAM }}>Configure Strip</span>
          </div>
          <button onClick={onCancel} className="text-neutral-500 hover:text-neutral-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-wider" style={{ color: RAIL_TEXT }}>Title</label>
            <input
              type="text"
              value={localModal.name}
              onChange={e => setLocalModal({ ...localModal, name: e.target.value })}
              className="bg-black/40 border border-white/[0.08] text-xs rounded-md py-1.5 px-3 focus:outline-none focus:ring-1 focus:ring-[#3ecf8e] w-full"
              style={{ color: CREAM }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-wider" style={{ color: RAIL_TEXT }}>Color</label>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="color"
                value={localModal.color || GREEN}
                onChange={e => setLocalModal({ ...localModal, color: e.target.value })}
                className="h-8 w-12 bg-transparent border border-white/[0.08] rounded-md cursor-pointer p-0.5"
              />
              <div className="flex gap-1.5 ml-auto">
                {DESIGNER_COLORS.map(c => {
                  const isActive = (localModal.color || '').toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      onClick={() => setLocalModal({ ...localModal, color: c })}
                      style={{ backgroundColor: c }}
                      className={`w-6 h-6 rounded-full border ${isActive ? 'border-white scale-110' : 'border-white/10'}`}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] pt-3 mt-1">
          <button onClick={onCancel} className="bg-white/[0.05] border border-white/[0.08] text-xs font-semibold py-1.5 px-4 rounded-md" style={{ color: CREAM }}>
            Cancel
          </button>
          <button
            onClick={() => onSave(localModal)}
            className="text-xs font-bold py-1.5 px-4 rounded-md"
            style={{ backgroundColor: GREEN, color: 'black' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Mixer component

export { ConfigModal }
