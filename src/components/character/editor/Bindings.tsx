import { useState, useEffect } from 'react'
import type { Preset, Lorebook } from '../../../../shared/types'
import { logError } from '../../../lib/logger'

/** B-05：预设绑定选择器 */
export function PresetBinding({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [presets, setPresets] = useState<Preset[]>([])
  useEffect(() => { window.api.preset.list().then(setPresets).catch((e) => logError('CharacterEditor:loadPresets', e)) }, [])
  return (
    <div>
      <label className="label">绑定预设</label>
      <select className="input text-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">不绑定</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <p className="text-xs text-tavern-text-muted mt-1">切换到此角色时自动激活该预设</p>
    </div>
  )
}

/** B-05：世界书绑定选择器 */
export function LorebookBinding({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  useEffect(() => { window.api.lorebook.list().then(setLorebooks).catch((e) => logError('CharacterEditor:loadLorebooks', e)) }, [])
  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter(v => v !== id))
    else onChange([...value, id])
  }
  return (
    <div>
      <label className="label">绑定世界书</label>
      <div className="max-h-32 overflow-y-auto border border-tavern-border rounded-lg p-2 space-y-1">
        {lorebooks.length === 0 ? (
          <p className="text-xs text-tavern-text-muted py-1">暂无世界书</p>
        ) : (
          lorebooks.map((lb) => (
            <label key={lb.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-tavern-bg-hover rounded px-1 py-0.5">
              <input type="checkbox" checked={value.includes(lb.id)} onChange={() => toggle(lb.id)} className="accent-tavern-accent" />
              <span className="truncate">{lb.name}</span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-tavern-text-muted mt-1">切换到此角色时自动激活选中的世界书</p>
    </div>
  )
}
