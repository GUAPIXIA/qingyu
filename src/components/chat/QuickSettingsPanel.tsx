import { useState, useEffect, useMemo } from 'react'
import { X, Sliders, BookOpen, Cpu, Thermometer, Hash, Sparkles, Search, ChevronDown, Wand2, Lock, RefreshCw, Info } from 'lucide-react'
import type { Preset, Lorebook } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { lorebookCache, getEffectiveLorebookIds } from '../../utils/lorebook'
import { cn } from '../../lib/utils'
import { logError } from '../../lib/logger'

interface QuickSettingsPanelProps {
  open: boolean
  onClose: () => void
}

const IMAGE_GEN_SIZES = [
  '512x512', '768x768', '1024x1024',
  '512x768', '768x512',
]

export function QuickSettingsPanel({ open, onClose }: QuickSettingsPanelProps) {
  const { activePresetId, activeLorebookIds, setActivePreset, setActiveLorebooks, saveLorebookBinding } = useChatStore()
  const { settings, updateSettings } = useSettingsStore()
  const currentCharacter = useCharacterStore(s => s.currentCharacter)
  const currentCharId = currentCharacter?.id
  const [presets, setPresets] = useState<Preset[]>([])
  const [lorebooks, setLorebooks] = useState<Lorebook[]>([])
  const [lorebookExpanded, setLorebookExpanded] = useState(false)
  const [lorebookSearch, setLorebookSearch] = useState('')
  // 模型列表
  const [modelList, setModelList] = useState<string[]>([])
  const [modelListLoading, setModelListLoading] = useState(false)
  const [modelListError, setModelListError] = useState(false)
  const [modelExpanded, setModelExpanded] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  /** 示例对话说明提示：ⓘ 点击弹出 */
  const [showExampleHint, setShowExampleHint] = useState(false)

  // 计算角色绑定的世界书 ID 列表
  const boundLorebookIds = useMemo(() => {
    return getEffectiveLorebookIds(currentCharacter)
  }, [currentCharacter?.boundLorebookIds, currentCharacter?.lorebookId])

  // 区分绑定和手动选择的世界书
  const manualLorebookIds = useMemo(
    () => activeLorebookIds.filter(id => !boundLorebookIds.includes(id)),
    [activeLorebookIds, boundLorebookIds],
  )

  // 组件挂载时预加载世界书（确保绑定芯片始终有名称）
  useEffect(() => {
    window.api.lorebook.list().then((lbs) => {
      setLorebooks(lbs)
      for (const lb of lbs) { lorebookCache.set(lb.id, lb) }
    }).catch((e) => logError('QuickSettings:loadModels', e))
  }, [])

  // 面板打开时刷新预设和世界书（获取最新数据）
  useEffect(() => {
    if (!open) return
    window.api.preset.list().then(setPresets)
    window.api.lorebook.list().then((lbs) => {
      setLorebooks(lbs)
      for (const lb of lbs) { lorebookCache.set(lb.id, lb) }
      // 移除已禁用的世界书从激活列表
      const disabledIds = lbs.filter(lb => !lb.enabled).map(lb => lb.id)
      if (disabledIds.some(id => activeLorebookIds.includes(id))) {
        setActiveLorebooks(activeLorebookIds.filter(id => !disabledIds.includes(id)), currentCharId)
      }
    })
  }, [open])

  // 面板打开时获取模型列表
  useEffect(() => {
    if (!open) return
    const p = useSettingsStore.getState().getActiveProfile()
    if (!p) {
      setModelListError(true)
      setModelList([])
      return
    }
    setModelListLoading(true)
    setModelListError(false)
    window.api.ai.listModels(p.provider, p.baseUrl, p.apiKey)
      .then((res) => {
        if (res.success && res.models && res.models.length > 0) {
          setModelList(res.models)
          setModelListError(false)
        } else {
          setModelListError(true)
          setModelList([])
        }
      })
      .catch(() => {
        setModelListError(true)
        setModelList([])
      })
      .finally(() => setModelListLoading(false))
  }, [open])

  // 从 API 获取模型列表的手动刷新
  const refreshModels = () => {
    const p = useSettingsStore.getState().getActiveProfile()
    if (!p) return
    setModelListLoading(true)
    setModelListError(false)
    window.api.ai.listModels(p.provider, p.baseUrl, p.apiKey)
      .then((res) => {
        if (res.success && res.models && res.models.length > 0) {
          setModelList(res.models)
        } else {
          setModelListError(true)
        }
      })
      .catch(() => setModelListError(true))
      .finally(() => setModelListLoading(false))
  }

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
            {/* API 模型下拉框 */}
            {!modelListError && modelList.length > 0 ? (
              <div className="space-y-1.5">
                {/* 已选中 + 展开按钮 */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setModelExpanded(!modelExpanded)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 rounded-md text-xs bg-tavern-bg-soft border border-tavern-border-soft hover:border-tavern-border transition-colors text-left"
                  >
                    <span className="truncate flex-1">{settings.activeModel || '选择模型'}</span>
                    <ChevronDown className={cn('w-3 h-3 shrink-0 text-tavern-text-muted transition-transform', modelExpanded && 'rotate-180')} />
                  </button>
                  <button
                    onClick={refreshModels}
                    disabled={modelListLoading}
                    className="p-1 rounded-md hover:bg-tavern-bg-hover text-tavern-text-muted transition-colors shrink-0"
                    title="刷新模型列表"
                  >
                    <RefreshCw className={cn('w-3.5 h-3.5', modelListLoading && 'animate-spin')} />
                  </button>
                </div>
                {/* 展开的搜索+列表 */}
                {modelExpanded && (
                  <div className="space-y-1 animate-fade-in">
                    {modelList.length > 8 && (
                      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-tavern-bg-soft border border-tavern-border-soft">
                        <Search className="w-3 h-3 text-tavern-text-muted shrink-0" />
                        <input
                          className="bg-transparent text-xs flex-1 outline-none placeholder:text-tavern-text-muted"
                          placeholder="搜索模型..."
                          value={modelSearch}
                          onChange={e => setModelSearch(e.target.value)}
                        />
                        {modelSearch && (
                          <button className="text-tavern-text-muted hover:text-tavern-text" onClick={() => setModelSearch('')}>
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                    <div className="max-h-40 overflow-y-auto -mx-0.5 px-0.5 space-y-0.5">
                      {modelList
                        .filter(m => !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase()))
                        .map((m) => {
                          const isActive = (settings.activeModel || profile?.model) === m
                          return (
                            <button
                              key={m}
                              onClick={() => {
                                updateSettings({ activeModel: m })
                                setModelExpanded(false)
                                setModelSearch('')
                              }}
                              className={cn(
                                'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors truncate',
                                isActive
                                  ? 'bg-tavern-accent-soft text-tavern-accent'
                                  : 'hover:bg-tavern-bg-hover text-tavern-text-soft'
                              )}
                            >
                              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isActive ? 'bg-tavern-accent' : 'bg-tavern-border')} />
                              <span className="truncate">{m}</span>
                              {isActive && <span className="ml-auto text-[11px] text-tavern-accent/70 shrink-0">当前</span>}
                            </button>
                          )
                        })}
                    </div>
                  </div>
                )}
              </div>
            ) : modelListLoading ? (
              <div className="flex items-center gap-2 py-1.5 text-xs text-tavern-text-muted">
                <RefreshCw className="w-3 h-3 animate-spin" />
                获取模型列表...
              </div>
            ) : (
              /* 兜底：无可用模型列表时显示文本输入 */
              <input
                type="text"
                className="input text-xs"
                value={settings.activeModel}
                onChange={(e) => updateSettings({ activeModel: e.target.value })}
                placeholder="输入模型名称"
              />
            )}
            {profile?.baseUrl && (
              <p className="text-xs text-tavern-text-muted mt-1.5 truncate">{profile.baseUrl}</p>
            )}
          </Section>

          {/* ===== 预设 ===== */}
          <Section icon={Sparkles} title="预设">
            <select
              className="input text-xs"
              value={activePresetId ?? ''}
              onChange={(e) => setActivePreset(e.target.value || null, currentCharId)}
            >
              <option value="">默认</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {activePreset && (
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-xs text-tavern-text-muted">
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
              <div className="space-y-1.5">
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
                          'px-2 py-0.5 rounded text-xs border transition-colors',
                          !activePreset && 'opacity-50 cursor-not-allowed',
                          (activePreset?.maxTokens ?? 1024) === n
                            ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                        )}
                      >
                        {n >= 1024 ? `${n / 1024}k` : n}
                      </button>
                    ))}
                    <input
                      type="number"
                      min={1}
                      disabled={!activePreset}
                      value={activePreset?.maxTokens ?? 1024}
                      onChange={async (e) => {
                        if (!activePreset) return
                        const val = Number(e.target.value) || 1
                        const updated = { ...activePreset, maxTokens: val }
                        setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                      }}
                      onBlur={async (e) => {
                        if (!activePreset) return
                        const val = Number(e.target.value) || 1
                        const updated = { ...activePreset, maxTokens: val }
                        await window.api.preset.save(updated)
                        setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                      }}
                      className="w-16 px-1.5 py-0.5 rounded text-xs border border-tavern-border-soft bg-tavern-bg text-tavern-text text-center focus:outline-none focus:border-tavern-accent/40 disabled:opacity-50"
                      title="自定义 Token 数"
                    />
                  </div>
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
                  {/* 角色绑定的世界书 - 始终显示，不受 activeLorebookIds 影响 */}
                  {boundLorebookIds.map(id => {
                    const lb = lorebooks.find(l => l.id === id)
                    if (!lb) return null
                    const isActive = activeLorebookIds.includes(id)
                    return (
                      <span
                        key={id}
                        className={cn(
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs border transition-colors',
                          isActive
                            ? 'bg-tavern-accent-soft text-tavern-accent border-tavern-accent/20'
                            : 'bg-tavern-bg-soft text-tavern-text-muted border-tavern-border-soft'
                        )}
                      >
                        <Lock className="w-2.5 h-2.5 shrink-0" />
                        <span className="max-w-[80px] truncate">{lb.name}</span>
                        {!isActive && (
                          <button
                            className="text-tavern-text-muted hover:text-tavern-accent transition-colors"
                            onClick={() => setActiveLorebooks([...activeLorebookIds, id], currentCharId)}
                            title="激活此世界书"
                          >
                            <ChevronDown className="w-2.5 h-2.5 rotate-[-90deg]" />
                          </button>
                        )}
                      </span>
                    )
                  })}
                  {/* 手动选择的世界书 */}
                  {manualLorebookIds.map(id => {
                    const lb = lorebooks.find(l => l.id === id)
                    return lb ? (
                      <span key={id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs bg-tavern-bg-soft text-tavern-text-soft border border-tavern-border-soft">
                        {lb.name}
                        <button
                          className="hover:text-tavern-danger transition-colors"
                          onClick={() => setActiveLorebooks(activeLorebookIds.filter(i => i !== id), currentCharId)}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ) : null
                  })}
                  <button
                    onClick={() => setLorebookExpanded(!lorebookExpanded)}
                    className="text-xs text-tavern-text-muted hover:text-tavern-text transition-colors ml-0.5"
                  >
                    {lorebookExpanded ? '收起' : `选择世界书${activeLorebookIds.length > 0 ? ` (+${lorebooks.filter(lb => lb.enabled).length - activeLorebookIds.length})` : ` (${lorebooks.filter(lb => lb.enabled).length})`}`}
                    <ChevronDown className={cn('w-3 h-3 ml-0.5 inline transition-transform', lorebookExpanded && 'rotate-180')} />
                  </button>
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
                      {lorebooks.filter(lb => lb.enabled && (!lorebookSearch || lb.name.toLowerCase().includes(lorebookSearch.toLowerCase()))).map(lb => {
                        const checked = activeLorebookIds.includes(lb.id)
                        const isBound = boundLorebookIds.includes(lb.id)
                        return (
                          <button
                            key={lb.id}
                            onClick={() => {
                              if (checked) {
                                setActiveLorebooks(activeLorebookIds.filter(id2 => id2 !== lb.id), currentCharId)
                              } else {
                                setActiveLorebooks([...activeLorebookIds, lb.id], currentCharId)
                              }
                            }}
                            className={cn(
                              'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors',
                              checked ? 'bg-tavern-accent-soft text-tavern-accent' : 'hover:bg-tavern-bg-hover text-tavern-text-soft'
                            )}
                          >
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', checked ? 'bg-tavern-accent' : 'bg-tavern-border')} />
                            <span className="truncate flex-1">{lb.name}</span>
                            {isBound && <Lock className="w-2.5 h-2.5 text-tavern-accent/60 shrink-0" />}
                            <span className="text-[11px] text-tavern-text-muted shrink-0 tabular-nums">{lb.entries.length}条</span>
                          </button>
                        )
                      })}
                    </div>
                    {boundLorebookIds.length > 0 && (
                      <p className="text-[11px] text-tavern-text-muted flex items-center gap-1 pt-0.5">
                        <Lock className="w-2.5 h-2.5 shrink-0" />
                        标注锁图标的为角色绑定的世界书，切换角色时自动激活
                      </p>
                    )}
                    {activeLorebookIds.length > 0 && (
                      <button
                        className="text-xs text-tavern-text-muted hover:text-tavern-danger transition-colors"
                        onClick={() => setActiveLorebooks([], currentCharId)}
                      >
                        清除全部 ({activeLorebookIds.length})
                      </button>
                    )}
                    {/* 当前选择与角色默认不同时，显示"保存为默认"按钮 */}
                    {currentCharId && activeLorebookIds.length > 0 && (() => {
                      const boundSet = new Set(boundLorebookIds)
                      const activeSet = new Set(activeLorebookIds)
                      const differs = boundSet.size !== activeSet.size || [...boundSet].some(id => !activeSet.has(id))
                      return differs ? (
                        <button
                          className="text-xs text-tavern-accent hover:text-tavern-accent-hover transition-colors ml-2"
                          onClick={() => saveLorebookBinding(currentCharId, activeLorebookIds)}
                        >
                          保存为默认 ({activeLorebookIds.length})
                        </button>
                      ) : null
                    })()}
                  </div>
                )}
              </>
            )}
            {/* 世界书 token 预算占比 */}
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-tavern-border-soft">
              <span
                className="text-xs text-tavern-text-muted"
                title="世界书注入内容占上下文预算的最大比例，超出部分按 order 优先级丢弃"
              >
                Token 预算占比
              </span>
              <div className="flex items-center gap-1">
                {([['20%', 0.2], ['30%', 0.3], ['50%', 0.5], ['不限', 1]] as const).map(([label, r]) => (
                  <button
                    key={label}
                    onClick={() => updateSettings({ lorebookRatio: r })}
                    className={cn(
                      'px-2 py-0.5 rounded text-xs border transition-colors',
                      (settings.lorebookRatio ?? 0.3) === r
                        ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                        : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
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
                  <p className="text-xs text-tavern-text-muted truncate">
                    模型: {imgProfile.name} ({imgProfile.provider})
                  </p>
                ) : (
                  <p className="text-xs text-tavern-text-muted">
                    未配置生图模型，前往 设置 -&gt; API -&gt; 生图
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
                        'px-2 py-0.5 rounded text-xs border transition-colors',
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
                显示字符计数
              </ToggleRow>
              <ToggleRow checked={settings.htmlRendering} onChange={(v) => updateSettings({ htmlRendering: v })}>
                HTML 渲染
              </ToggleRow>
              <ToggleRow checked={settings.streamOutput} onChange={(v) => updateSettings({ streamOutput: v })}>
                流式输出
              </ToggleRow>
              {/* 对话示例发送模式 */}
              <div className="flex items-center justify-between gap-2 py-0.5">
                <span
                  className="text-xs text-tavern-text-soft select-none"
                  title="仅首轮/关闭可节省每轮固定 token 成本"
                >
                  对话示例发送
                </span>
                <select
                  value={settings.exampleDialogMode ?? 'always'}
                  onChange={(e) => updateSettings({ exampleDialogMode: e.target.value as 'always' | 'first_turn' | 'off' })}
                  className="input text-xs py-1 px-2 w-24"
                >
                  <option value="always">每轮</option>
                  <option value="first_turn">仅首轮</option>
                  <option value="off">关闭</option>
                </select>
                {/* 示例对话作用提示：ⓘ 点击弹出 */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowExampleHint((v) => !v)}
                    className="p-0.5 rounded text-tavern-text-muted hover:text-tavern-accent transition-colors"
                    title="示例对话是什么？"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>
                  {showExampleHint && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setShowExampleHint(false)} />
                      <div className="absolute right-0 top-full mt-1 w-56 p-2.5 rounded-lg bg-tavern-bg-card border border-tavern-border shadow-xl z-30 text-[10px] leading-relaxed text-tavern-text-muted">
                        <p>
                          角色卡「对话示例」会作为<strong className="text-tavern-text-soft">风格示范</strong>注入上下文，
                          帮助 AI 模仿角色的语气、口癖与格式（few-shot）。
                        </p>
                        <p className="mt-1.5 pt-1.5 border-t border-tavern-border-soft">
                          仅首轮 / 关闭可节省每轮固定的 token 开销。
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>

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
      <div className="text-[11px] uppercase tracking-wide opacity-60">{label}</div>
      <div className="font-mono font-medium text-xs">{value ?? '-'}</div>
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
