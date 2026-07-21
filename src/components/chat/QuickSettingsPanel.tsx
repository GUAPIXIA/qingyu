import { useState, useEffect } from 'react'
import { X, Sliders, BookOpen, Cpu, Thermometer, Hash, Sparkles, Search, ChevronDown, Wand2 } from 'lucide-react'
import type { Preset, Lorebook } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cn } from '../../lib/utils'

interface QuickSettingsPanelProps {
  open: boolean
  onClose: () => void
}

const IMAGE_GEN_SIZES = [
  '512x512', '768x768', '1024x1024',
  '512x768', '768x512',
]

export function QuickSettingsPanel({ open, onClose }: QuickSettingsPanelProps) {
  const { activePresetId, activeLorebookIds, setActivePreset, setActiveLorebooks } = useChatStore()
  const { settings, updateSettings } = useSettingsStore()
  const [presets, setPresets] = useState<Preset[]>([])
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const [lorebookExpanded, setLorebookExpanded] = useState(false)
  const [lorebookSearch, setLorebookSearch] = useState('')

  useEffect(() => {
    window.api.preset.list().then(setPresets)
    window.api.lorebook.list().then(setLorebooks)
  }, [open])

  const profile = useSettingsStore.getState().getActiveProfile()
  const activePreset = presets.find((p) => p.id === activePresetId)

  return (
    <>
      {/* 遮罩 */}
      {open && <div className="fixed inset-0 z-30" onClick={onClose} />}

      {/* 面板 */}
      <div className={cn(
        'fixed right-0 top-0 w-80 bg-tavern-bg-card border-l border-tavern-border z-40 transition-transform duration-300 overflow-y-auto',
        open ? 'translate-x-0' : 'translate-x-full'
      )} style={{ top: 0, height: '100vh' }}>
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft sticky top-0 bg-tavern-bg-card/95 backdrop-blur z-10">
          <h3 className="font-display font-bold flex items-center gap-2 text-sm">
            <Sliders className="w-4 h-4 text-tavern-accent" />
            快捷设置
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-tavern-bg-hover transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">

          {/* ===== 模型 ===== */}
          <Section icon={Cpu} title="模型">
            <input
              type="text"
              className="input text-xs"
              value={settings.activeModel}
              onChange={(e) => updateSettings({ activeModel: e.target.value })}
              placeholder="输入模型名称"
            />
            {profile?.baseUrl && (
              <p className="text-[11px] text-tavern-text-muted mt-1.5 truncate">{profile.baseUrl}</p>
            )}
          </Section>

          {/* ===== 预设 ===== */}
          <Section icon={Sparkles} title="预设">
            <select
              className="input text-xs"
              value={activePresetId ?? ''}
              onChange={(e) => setActivePreset(e.target.value || null)}
            >
              <option value="">默认</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {activePreset && (
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px] text-tavern-text-muted">
                <ParamChip label="温度" value={activePreset.temperature} />
                <ParamChip label="Top P" value={activePreset.topP} />
                <ParamChip label="最大Token" value={activePreset.maxTokens} />
              </div>
            )}
          </Section>

          {/* ===== 采样参数 ===== */}
          <Section icon={Thermometer} title="采样参数">
            <div className="space-y-3">
              <SliderRow
                label="温度"
                value={activePreset?.temperature ?? 0.8}
                min={0} max={2} step={0.1}
                disabled
              />
              <SliderRow
                label="Top P"
                value={activePreset?.topP ?? 0.95}
                min={0} max={1} step={0.05}
                disabled
              />
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs text-tavern-text-muted shrink-0">最大Token</label>
                <div className="flex items-center gap-1.5">
                  {[512, 1024, 2048, 4096].map((n) => (
                    <button
                      key={n}
                      disabled={!activePreset}
                      onClick={async () => {
                        if (!activePreset) return
                        const updated = { ...activePreset, maxTokens: n }
                        await window.api.preset.save(updated)
                        setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                      }}
                      className={cn(
                        'px-2 py-0.5 rounded text-[11px] border transition-colors',
                        !activePreset && 'opacity-50 cursor-not-allowed',
                        (activePreset?.maxTokens ?? 1024) === n
                          ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                          : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                      )}
                    >
                      {n >= 1024 ? `${n / 1024}k` : n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          {/* ===== 世界书 ===== */}
          <Section icon={BookOpen} title="世界书">
            {lorebooks.length === 0 ? (
              <p className="text-xs text-tavern-text-muted py-1">暂无世界书</p>
            ) : (
              <>
                {/* 已选中芯片 + 展开按钮 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeLorebookIds.length === 0 ? (
                    <button
                      onClick={() => setLorebookExpanded(!lorebookExpanded)}
                      className="text-xs text-tavern-text-muted hover:text-tavern-text transition-colors"
                    >
                      选择世界书 ({lorebooks.length})
                      <ChevronDown className={cn('w-3 h-3 ml-0.5 inline transition-transform', lorebookExpanded && 'rotate-180')} />
                    </button>
                  ) : (
                    <>
                      {activeLorebookIds.map(id => {
                        const lb = lorebooks.find(l => l.id === id)
                        return lb ? (
                          <span key={id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] bg-tavern-accent-soft text-tavern-accent border border-tavern-accent/20">
                            {lb.name}
                            <button
                              className="hover:text-tavern-danger transition-colors"
                              onClick={() => setActiveLorebooks(activeLorebookIds.filter(i => i !== id))}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ) : null
                      })}
                      <button
                        onClick={() => setLorebookExpanded(!lorebookExpanded)}
                        className="text-[11px] text-tavern-text-muted hover:text-tavern-text transition-colors ml-0.5"
                      >
                        {lorebookExpanded ? '收起' : `+${lorebooks.length - activeLorebookIds.length}`}
                      </button>
                    </>
                  )}
                </div>

                {/* 展开的搜索+列表 */}
                {lorebookExpanded && (
                  <div className="mt-2 space-y-1.5 animate-fade-in">
                    {lorebooks.length > 6 && (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-tavern-bg-soft border border-tavern-border-soft">
                        <Search className="w-3 h-3 text-tavern-text-muted shrink-0" />
                        <input
                          className="bg-transparent text-xs flex-1 outline-none placeholder:text-tavern-text-muted"
                          placeholder="搜索..."
                          value={lorebookSearch}
                          onChange={e => setLorebookSearch(e.target.value)}
                        />
                        {lorebookSearch && (
                          <button className="text-tavern-text-muted hover:text-tavern-text" onClick={() => setLorebookSearch('')}>
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                    <div className="max-h-40 overflow-y-auto -mx-0.5 px-0.5 space-y-0.5">
                      {lorebooks.filter(lb => !lorebookSearch || lb.name.toLowerCase().includes(lorebookSearch.toLowerCase())).map(lb => {
                        const checked = activeLorebookIds.includes(lb.id)
                        return (
                          <button
                            key={lb.id}
                            onClick={() => {
                              if (checked) {
                                setActiveLorebooks(activeLorebookIds.filter(id => id !== lb.id))
                              } else {
                                setActiveLorebooks([...activeLorebookIds, lb.id])
                              }
                            }}
                            className={cn(
                              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors',
                              checked ? 'bg-tavern-accent-soft text-tavern-accent' : 'hover:bg-tavern-bg-hover text-tavern-text-soft'
                            )}
                          >
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', checked ? 'bg-tavern-accent' : 'bg-tavern-border')} />
                            <span className="truncate flex-1">{lb.name}</span>
                            <span className="text-[10px] text-tavern-text-muted shrink-0 tabular-nums">{lb.entries.length}条</span>
                          </button>
                        )
                      })}
                    </div>
                    {activeLorebookIds.length > 0 && (
                      <button
                        className="text-[11px] text-tavern-text-muted hover:text-tavern-danger transition-colors"
                        onClick={() => setActiveLorebooks([])}
                      >
                        清除全部 ({activeLorebookIds.length})
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </Section>

          {/* ===== AI 生图 ===== */}
          <Section icon={Wand2} title="AI 生图">
            <div className="space-y-3">
              <ToggleRow
                checked={settings.imageGenAutoEnabled ?? false}
                onChange={(v) => updateSettings({ imageGenAutoEnabled: v })}
              >
                自动生图（回复中 [image: ...] 标记）
              </ToggleRow>

              {(() => {
                const imgProfile = useSettingsStore.getState().getActiveImageGen()
                return imgProfile ? (
                  <p className="text-[11px] text-tavern-text-muted truncate">
                    模型: {imgProfile.name} ({imgProfile.provider})
                  </p>
                ) : (
                  <p className="text-[11px] text-tavern-text-muted">
                    未配置生图模型，前往 设置 → API → 生图
                  </p>
                )
              })()}

              {/* 尺寸选择按钮组 */}
              <div>
                <label className="text-xs text-tavern-text-muted shrink-0 block mb-1.5">尺寸</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {IMAGE_GEN_SIZES.map((s) => (
                    <button
                      key={s}
                      onClick={() => updateSettings({ imageGenSize: s })}
                      className={cn(
                        'px-2 py-0.5 rounded text-[11px] border transition-colors',
                        (settings.imageGenSize ?? '512x512') === s
                          ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                          : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          {/* ===== 显示选项 ===== */}
          <Section icon={Hash} title="显示">
            <div className="space-y-2">
              <ToggleRow checked={settings.showTokenCount} onChange={(v) => updateSettings({ showTokenCount: v })}>
                显示 Token 计数
              </ToggleRow>
              <ToggleRow checked={settings.htmlRendering} onChange={(v) => updateSettings({ htmlRendering: v })}>
                HTML 渲染
              </ToggleRow>
              <ToggleRow checked={settings.streamOutput} onChange={(v) => updateSettings({ streamOutput: v })}>
                流式输出
              </ToggleRow>
            </div>
          </Section>

        </div>
      </div>
    </>
  )
}

/* ===== 子组件 ===== */

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="w-3.5 h-3.5 text-tavern-text-muted" />
        <span className="text-xs font-semibold text-tavern-text-soft uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  )
}

function ParamChip({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="px-2 py-1 rounded-md bg-tavern-bg-soft border border-tavern-border-soft text-center">
      <div className="text-[9px] uppercase tracking-wide opacity-60">{label}</div>
      <div className="font-mono font-medium">{value ?? '—'}</div>
    </div>
  )
}

function SliderRow({ label, value, min, max, step, disabled }: {
  label: string; value: number; min: number; max: number; step: number; disabled?: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-tavern-text-muted">{label}</label>
        <span className="text-xs font-mono text-tavern-text-soft tabular-nums">{value}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        readOnly={disabled}
        className={cn(
          'w-full h-1.5 rounded-full appearance-none cursor-pointer',
          'bg-tavern-bg-hover',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-tavern-accent [&::-webkit-slider-thumb]:shadow-sm',
          disabled && 'opacity-60 cursor-not-allowed [&::-webkit-slider-thumb]:cursor-not-allowed'
        )}
      />
    </div>
  )
}

function ToggleRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer py-0.5">
      <span className="text-xs text-tavern-text-soft select-none">{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-tavern-accent',
          checked ? 'bg-tavern-accent' : 'bg-tavern-bg-hover'
        )}
      >
        <span className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )} />
      </button>
    </label>
  )
}
