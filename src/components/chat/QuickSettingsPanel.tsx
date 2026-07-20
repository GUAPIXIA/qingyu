import { useState, useEffect } from 'react'
import { X, Sliders, BookOpen, Cpu } from 'lucide-react'
import type { Preset, Lorebook } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'

interface QuickSettingsPanelProps {
  open: boolean
  onClose: () => void
}

export function QuickSettingsPanel({ open, onClose }: QuickSettingsPanelProps) {
  const { activePresetId, activeLorebookId, setActivePreset, setActiveLorebook } = useChatStore()
  const { settings, updateSettings } = useSettingsStore()
  const [presets, setPresets] = useState<Preset[]>([])
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])

  useEffect(() => {
    window.api.preset.list().then(setPresets)
    window.api.lorebook.list().then(setLorebooks)
  }, [open])

  const profile = useSettingsStore.getState().getActiveProfile()

  return (
    <>
      {/* 遮罩 */}
      {open && <div className="fixed inset-0 z-30" onClick={onClose} />}

      {/* 面板 */}
      <div className={cn(
        'fixed right-0 top-0 bottom-full w-80 bg-tavern-bg-card border-l border-tavern-border z-40 transition-transform duration-300 overflow-y-auto',
        open ? 'translate-x-0' : 'translate-x-full'
      )} style={{ top: 0, height: '100vh' }}>
        <div className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft sticky top-0 bg-tavern-bg-card z-10">
          <h3 className="font-display font-bold flex items-center gap-2">
            <Sliders className="w-4 h-4 text-tavern-accent" />
            快捷设置
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-tavern-bg-hover">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* 预设选择 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5" />
              预设
            </label>
            <select
              className="input"
              value={activePresetId ?? ''}
              onChange={(e) => setActivePreset(e.target.value || null)}
            >
              <option value="">默认预设</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {activePresetId && (
              <div className="mt-2 text-xs text-tavern-text-muted space-y-1">
                {(() => {
                  const p = presets.find((x) => x.id === activePresetId)
                  return p ? (
                    <>
                      <div>温度: {p.temperature}</div>
                      <div>TopP: {p.topP}</div>
                      <div>最大Token: {p.maxTokens}</div>
                    </>
                  ) : null
                })()}
              </div>
            )}
          </div>

          {/* 世界书 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              世界书
            </label>
            <select
              className="input"
              value={activeLorebookId ?? ''}
              onChange={(e) => setActiveLorebook(e.target.value || null)}
            >
              <option value="">无</option>
              {lorebooks.map((lb) => (
                <option key={lb.id} value={lb.id}>{lb.name}</option>
              ))}
            </select>
          </div>

          {/* 模型 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5" />
              当前模型
            </label>
            <input
              type="text"
              className="input"
              value={settings.activeModel}
              onChange={(e) => updateSettings({ activeModel: e.target.value })}
              placeholder="模型名称"
            />
            <p className="text-xs text-tavern-text-muted mt-1">{profile?.baseUrl ?? '—'}</p>
          </div>

          {/* 快速参数 */}
          <div>
            <label className="label">温度 (Temperature)</label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              defaultValue="0.8"
              className="w-full accent-tavern-accent"
            />
          </div>

          {/* 显示选项 */}
          <div>
            <label className="label">显示选项</label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.showTokenCount}
                  onChange={(e) => updateSettings({ showTokenCount: e.target.checked })}
                  className="accent-tavern-accent"
                />
                <span className="text-sm">显示 Token 计数</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.htmlRendering}
                  onChange={(e) => updateSettings({ htmlRendering: e.target.checked })}
                  className="accent-tavern-accent"
                />
                <span className="text-sm">HTML 渲染</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.streamOutput}
                  onChange={(e) => updateSettings({ streamOutput: e.target.checked })}
                  className="accent-tavern-accent"
                />
                <span className="text-sm">流式输出</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
