import { useState, useEffect, useMemo, useRef } from 'react'
import { X, Sliders, BookOpen, Cpu, Thermometer, Hash, Sparkles, Search, ChevronDown, Lock, RefreshCw, Info, Plug, Loader2, CheckCircle2, XCircle, MessageSquare, ArrowDownToLine, Eye, Image as ImageIcon, Images, Download, Trash2, Users } from 'lucide-react'
import type { Preset, Lorebook, GroupChat } from '../../../shared/types'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { lorebookCache, getEffectiveLorebookIds } from '../../utils/lorebook'
import { cn } from '../../lib/utils'
import { logError } from '../../lib/logger'
import { getDefaultMaxContext } from '../../utils/tokenCounter'
import { resolveResponsePolicy } from '../../../shared/responsePolicy'
import {
  formatRequestBudgetRisk,
  resolveRequestBudget,
  resolveUserHardCap,
} from '../../../shared/modelOutputProfile'
import {
  DEFAULT_LOREBOOK_RATIO,
  DEFAULT_RESERVED_OUTPUT,
  LOREBOOK_PRIORITY_BUDGET,
  TOKEN_BUDGET_SAFETY,
} from '../../store/chatConstants'

interface QuickSettingsPanelProps {
  open: boolean
  onClose: () => void
  messages: Array<{ images?: string[] }>
  onShowContextViewer: () => void
  onShowBgPanel: () => void
  onExport: () => void
  onClearConfirm: () => void
  /** 传入时切换为群聊模式，复用单聊快捷设置并写回群聊级预设/世界书/节奏。 */
  group?: GroupChat
  onSaveGroup?: (group: GroupChat) => void | Promise<void>
  /** 会话级“下一步方向”开关（单聊/群聊由页面注入当前值与 setter）。 */
  dialogueDirectionsEnabled?: boolean
  onSetDialogueDirections?: (enabled: boolean) => void | Promise<void>
}

const QUICK_BUTTON_ICON_CLASS = 'w-3.5 h-3.5 shrink-0'
const QUICK_BUTTON_ICON_BADGE_CLASS = 'grid h-7 w-7 place-items-center rounded-lg border shrink-0'

export function QuickSettingsPanel({
  open,
  onClose,
  messages,
  onShowContextViewer,
  onShowBgPanel,
  onExport,
  onClearConfirm,
  group,
  onSaveGroup,
  dialogueDirectionsEnabled,
  onSetDialogueDirections,
}: QuickSettingsPanelProps) {
  // P-6 修复：字段级选择器订阅
  const chatActivePresetId = useChatStore((s) => s.activePresetId)
  const chatActiveLorebookIds = useChatStore((s) => s.activeLorebookIds)
  const setActivePreset = useChatStore((s) => s.setActivePreset)
  const setActiveLorebooks = useChatStore((s) => s.setActiveLorebooks)
  const saveLorebookBinding = useChatStore((s) => s.saveLorebookBinding)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const currentCharacter = useCharacterStore(s => s.currentCharacter)
  const characters = useCharacterStore(s => s.characters)
  const currentCharId = currentCharacter?.id
  const isGroup = !!group
  const activePresetId = group ? group.presetId : chatActivePresetId
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
  // 连接测试
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const activePreset = presets.find((p) => p.id === activePresetId)
  const outputBudgetPreview = useMemo(() => {
    const profile = settings.connectionProfiles.find((item) => item.id === settings.activeProfileId)
    const model = settings.activeModel || profile?.model || 'gpt-4o-mini'
    if ((settings.generationPipeline ?? 'unified') === 'legacy') {
      return {
        requestMaxTokens: resolveUserHardCap(activePreset?.maxTokens) ?? DEFAULT_RESERVED_OUTPUT,
        riskMessage: null,
      }
    }
    const responsePolicy = resolveResponsePolicy({ presetHint: activePreset?.responseLengthHint })
    const budget = resolveRequestBudget({
      model,
      hardMaxChars: responsePolicy.hardMaxChars,
      userHardCap: activePreset?.maxTokens,
    })
    return {
      requestMaxTokens: budget.requestMaxTokens,
      riskMessage: formatRequestBudgetRisk(budget),
    }
  }, [activePreset, settings.activeModel, settings.activeProfileId, settings.connectionProfiles, settings.generationPipeline])
  const generatedImages = useMemo(
    () => messages.flatMap((message) => message.images ?? []).slice(-12).reverse(),
    [messages],
  )
  const lorebookBudgetPreview = useMemo(() => {
    const profile = settings.connectionProfiles.find((item) => item.id === settings.activeProfileId)
    const model = settings.activeModel || profile?.model || 'gpt-4o-mini'
    const maxContext = profile?.maxContext || getDefaultMaxContext(model)
    const reservedOutput = outputBudgetPreview.requestMaxTokens
    const budgetBase = Math.max(0, Math.floor((maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY))
    const total = Math.floor(budgetBase * (settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO))
    return {
      total,
      always: Math.floor(total * LOREBOOK_PRIORITY_BUDGET.always),
      conditional: Math.floor(total * LOREBOOK_PRIORITY_BUDGET.alwaysPlusConditional),
    }
  }, [outputBudgetPreview.requestMaxTokens, settings.activeModel, settings.activeProfileId, settings.connectionProfiles, settings.lorebookRatio])

  // 计算角色绑定的世界书 ID 列表
  const boundLorebookIds = useMemo(() => {
    if (group) {
      return [...new Set(group.memberIds.flatMap((memberId) => {
        const member = characters.find((character) => character.id === memberId)
        return getEffectiveLorebookIds(member)
      }))]
    }
    return getEffectiveLorebookIds(currentCharacter)
  }, [characters, currentCharacter, group])

  const activeLorebookIds = useMemo(
    () => group
      ? [...new Set([...boundLorebookIds, ...group.lorebookIds])]
      : chatActiveLorebookIds,
    [boundLorebookIds, chatActiveLorebookIds, group],
  )

  // 区分绑定和手动选择的世界书
  const manualLorebookIds = useMemo(
    () => group
      ? group.lorebookIds.filter(id => !boundLorebookIds.includes(id))
      : activeLorebookIds.filter(id => !boundLorebookIds.includes(id)),
    [activeLorebookIds, boundLorebookIds, group],
  )

  const changeActivePreset = (presetId: string | null) => {
    if (group && onSaveGroup) {
      void onSaveGroup({ ...group, presetId })
      return
    }
    setActivePreset(presetId, currentCharId)
  }

  const changeActiveLorebooks = (ids: string[]) => {
    if (group && onSaveGroup) {
      const memberBound = new Set(boundLorebookIds)
      void onSaveGroup({ ...group, lorebookIds: [...new Set(ids.filter((id) => !memberBound.has(id)))] })
      return
    }
    setActiveLorebooks(ids, currentCharId)
  }

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
        changeActiveLorebooks(activeLorebookIds.filter(id => !disabledIds.includes(id)))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** 测试当前 API 连接 */
  const handleTestConnection = async () => {
    const p = useSettingsStore.getState().getActiveProfile()
    if (!p) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.ai.testConnection({
        type: p.provider,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model || settings.activeModel || 'gpt-4o-mini',
      })
      setTestResult({
        success: res.success,
        message: res.success
          ? (res.models && res.models.length > 0 ? `连接成功，${res.models.length} 个模型可用` : '连接成功')
          : (res.error ?? '连接失败'),
      })
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const profile = useSettingsStore.getState().getActiveProfile()
  const openConversationTool = (action: () => void) => {
    onClose()
    action()
  }

  /** 保存参数修改；内置预设会由后端创建副本，并立即切换到新副本。 */
  const persistPresetUpdate = async (updated: Preset) => {
    try {
      const saved = await window.api.preset.save(updated)
      setPresets((prev) => {
        const exists = prev.some((preset) => preset.id === saved.id)
        return exists
          ? prev.map((preset) => preset.id === saved.id ? saved : preset)
          : [...prev, saved]
      })
      if (saved.id !== updated.id) changeActivePreset(saved.id)
    } catch (error) {
      logError('QuickSettings:savePreset', error)
    }
  }

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
            {isGroup ? '群聊快捷设置' : '快捷设置'}
          </h3>
          <QuickIconButton label="关闭快捷设置" onClick={onClose}>
            <X className={QUICK_BUTTON_ICON_CLASS} />
          </QuickIconButton>
        </div>

        <div className="p-4 space-y-5">

          {/* ===== 对话操作 ===== */}
          <Section icon={MessageSquare} title="对话操作">
            <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-2.5 space-y-2.5">
              <div className="flex items-center gap-2 pb-2 border-b border-tavern-border-soft">
                <span className={cn(QUICK_BUTTON_ICON_BADGE_CLASS, 'border-tavern-accent/15 bg-tavern-accent-soft text-tavern-accent')}>
                  <ArrowDownToLine className={QUICK_BUTTON_ICON_CLASS} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-tavern-text-soft">自动滚动</p>
                  <p className="text-[10px] text-tavern-text-muted">生成时跟随最新消息</p>
                </div>
                <ToggleSwitch
                  label="自动滚动"
                  checked={settings.autoScroll}
                  onChange={(value) => updateSettings({ autoScroll: value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <ActionButton icon={Eye} label="查看上下文" onClick={() => openConversationTool(onShowContextViewer)} />
                <ActionButton icon={isGroup ? Users : ImageIcon} label={isGroup ? '群聊管理' : '聊天背景'} onClick={() => openConversationTool(onShowBgPanel)} />
                <ActionButton icon={Download} label="导出对话" onClick={() => openConversationTool(onExport)} />
                <ActionButton danger icon={Trash2} label="清空对话" onClick={() => openConversationTool(onClearConfirm)} />
              </div>

              <div className="pt-2 border-t border-tavern-border-soft">
                <div className="flex items-center justify-between mb-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-tavern-text-soft">
                    <Images className="w-3.5 h-3.5 text-tavern-text-muted" />
                    生图历史
                  </span>
                  {generatedImages.length > 0 && (
                    <span className="text-[10px] tabular-nums text-tavern-text-muted">最近 {generatedImages.length} 张</span>
                  )}
                </div>
                {generatedImages.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-tavern-border-soft px-3 py-4 text-center text-[11px] text-tavern-text-muted">
                    暂无生图记录
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {generatedImages.map((image, index) => (
                      <button
                        key={`${image.slice(0, 32)}-${index}`}
                        type="button"
                        aria-label={`复制生图数据 ${index + 1}`}
                        title="复制图片数据（base64）"
                        onClick={() => navigator.clipboard.writeText(image).catch(() => useChatStore.setState({ error: '复制图片数据失败：无法访问剪贴板' }))}
                        className="aspect-square rounded-lg overflow-hidden bg-tavern-bg-hover border border-transparent hover:border-tavern-accent hover:shadow-sm transition-all"
                      >
                        <img src={image} className="w-full h-full object-cover" alt="" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Section>

          {/* ===== 对话交互 ===== */}
          <Section icon={Sparkles} title="对话交互">
            <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-tavern-text-soft">下一步方向</p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-tavern-text-muted">
                    AI 回复后生成 3 个可选方向
                  </p>
                </div>
                <ToggleSwitch
                  label="下一步方向"
                  checked={!!dialogueDirectionsEnabled}
                  onChange={(value) => void onSetDialogueDirections?.(value)}
                />
              </div>
            </div>
          </Section>

          {group && onSaveGroup && (
            <Section icon={Users} title="接力设置">
              <div className="rounded-xl border border-tavern-border-soft bg-tavern-bg-soft/60 p-2.5 space-y-3">
                <p className="text-[10px] leading-relaxed text-tavern-text-muted">
                  回复规则在输入区切换；这里仅配置“按顺序”模式的连续接力。
                </p>
                {group.chatMode === 'polling' ? (
                  <>
                  <div className="flex items-center justify-between border-t border-tavern-border-soft pt-2">
                    <span className="min-w-0">
                      <span className="block text-xs text-tavern-text-soft">自动接力</span>
                      <span className="block text-[10px] text-tavern-text-muted">角色回复后自动轮到下一位</span>
                    </span>
                    <ToggleSwitch
                      label="群聊自动接力"
                      checked={group.autoMode}
                      onChange={(autoMode) => void onSaveGroup({ ...group, autoMode })}
                    />
                  </div>
                  {group.autoMode && (
                    <div className="grid grid-cols-2 gap-2 border-t border-tavern-border-soft pt-2">
                      <label className="space-y-1 text-[10px] text-tavern-text-muted">
                        <span>最大轮数</span>
                        <input
                          aria-label="连续接力最大轮数"
                          type="number"
                          min={1}
                          max={20}
                          value={group.maxRounds}
                          onChange={(event) => void onSaveGroup({ ...group, maxRounds: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })}
                          className="w-full rounded-lg border border-tavern-border-soft bg-tavern-bg-card px-2 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                        />
                      </label>
                      <label className="space-y-1 text-[10px] text-tavern-text-muted">
                        <span>回复间隔</span>
                        <select
                          aria-label="连续接力回复间隔"
                          value={group.speakerInterval}
                          onChange={(event) => void onSaveGroup({ ...group, speakerInterval: Number(event.target.value) })}
                          className="w-full rounded-lg border border-tavern-border-soft bg-tavern-bg-card px-2 py-1.5 text-xs text-tavern-text outline-none focus:border-tavern-accent"
                        >
                          <option value={500}>0.5 秒</option>
                          <option value={1000}>1 秒</option>
                          <option value={2000}>2 秒</option>
                          <option value={3000}>3 秒</option>
                          <option value={5000}>5 秒</option>
                        </select>
                      </label>
                    </div>
                  )}
                  </>
                ) : (
                  <p className="border-t border-tavern-border-soft pt-2 text-[10px] text-tavern-text-muted">
                    当前回复规则不使用连续接力。
                  </p>
                )}
              </div>
            </Section>
          )}

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
                  <QuickIconButton
                    onClick={refreshModels}
                    disabled={modelListLoading}
                    label="刷新模型列表"
                  >
                    <RefreshCw className={cn(QUICK_BUTTON_ICON_CLASS, modelListLoading && 'animate-spin')} />
                  </QuickIconButton>
                  <QuickIconButton
                    onClick={handleTestConnection}
                    disabled={testing || !profile}
                    label="测试连接"
                  >
                    {testing ? <Loader2 className={cn(QUICK_BUTTON_ICON_CLASS, 'animate-spin')} /> : <Plug className={QUICK_BUTTON_ICON_CLASS} />}
                  </QuickIconButton>
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
                          <QuickIconButton compact label="清除模型搜索" onClick={() => setModelSearch('')}>
                            <X className="w-3 h-3" />
                          </QuickIconButton>
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
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  className="input text-xs flex-1 min-w-0"
                  value={settings.activeModel}
                  onChange={(e) => updateSettings({ activeModel: e.target.value })}
                  placeholder="输入模型名称"
                />
                <QuickIconButton
                  onClick={handleTestConnection}
                  disabled={testing || !profile}
                  label="测试连接"
                >
                  {testing ? <Loader2 className={cn(QUICK_BUTTON_ICON_CLASS, 'animate-spin')} /> : <Plug className={QUICK_BUTTON_ICON_CLASS} />}
                </QuickIconButton>
              </div>
            )}
            {profile?.baseUrl && (
              <p className="text-xs text-tavern-text-muted mt-1.5 truncate">{profile.baseUrl}</p>
            )}
            {testResult && (
              <p className={cn('text-xs mt-1.5 flex items-start gap-1', testResult.success ? 'text-tavern-success' : 'text-tavern-danger')}>
                {testResult.success ? <CheckCircle2 className="w-3 h-3 shrink-0 mt-px" /> : <XCircle className="w-3 h-3 shrink-0 mt-px" />}
                <span className="break-all">{testResult.message}</span>
              </p>
            )}
          </Section>

          {/* ===== 预设 ===== */}
          <Section icon={Sparkles} title="预设">
            <select
              aria-label={isGroup ? '群聊预设' : '对话预设'}
              className="input text-xs"
              value={activePresetId ?? ''}
              onChange={(e) => changeActivePreset(e.target.value || null)}
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
                <ParamChip label="最大Token" value={activePreset.maxTokens === 0 ? '自动' : activePreset.maxTokens} />
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
                hint={
                  <>
                    <p>控制输出的<strong className="text-tavern-text-soft">随机性 / 创造性</strong>：</p>
                    <ul className="mt-1 list-disc pl-3 space-y-0.5">
                      <li>低（0.2~0.5）：稳定、严谨、可预测，适合事实性回复</li>
                      <li>高（1.0+）：发散、有创意、更“活”，但可能偏离设定</li>
                      <li>角色扮演常用 0.7~1.0</li>
                    </ul>
                  </>
                }
              />
              <SliderRow
                label="Top P"
                value={activePreset?.topP ?? 0.95}
                min={0} max={1} step={0.05}
                disabled
                hint={
                  <>
                    <p><strong className="text-tavern-text-soft">核采样</strong>：只从累计概率达到 P 的高概率 token 中采样。</p>
                    <p className="mt-1.5">与温度配合使用，一般保持 0.9~1.0。微调时与温度二选一即可，不必同时反复调。</p>
                  </>
                }
              />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs text-tavern-text-muted shrink-0">最大Token</label>
                  <div className="flex items-center gap-1.5">
                    {[0, 1024, 2048, 4096].map((n) => (
                      <button
                        key={n}
                        disabled={!activePreset}
                        onClick={async () => {
                          if (!activePreset) return
                          const updated = { ...activePreset, maxTokens: n }
                          await persistPresetUpdate(updated)
                        }}
                        className={cn(
                          'px-2 py-0.5 rounded text-xs border transition-colors',
                          !activePreset && 'opacity-50 cursor-not-allowed',
                          (activePreset?.maxTokens ?? 0) === n
                            ? 'border-tavern-accent/40 bg-tavern-accent-soft text-tavern-accent'
                            : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                        )}
                      >
                        {n === 0 ? '自动' : `${n / 1024}k`}
                      </button>
                    ))}
                    <input
                      type="number"
                      min={0}
                      disabled={!activePreset}
                      value={activePreset?.maxTokens ?? 0}
                      onChange={async (e) => {
                        if (!activePreset) return
                        const val = Math.max(0, Number(e.target.value) || 0)
                        const updated = { ...activePreset, maxTokens: val }
                        setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                      }}
                      onBlur={async (e) => {
                        if (!activePreset) return
                        const val = Math.max(0, Number(e.target.value) || 0)
                        const updated = { ...activePreset, maxTokens: val }
                        await persistPresetUpdate(updated)
                      }}
                      className="w-16 px-1.5 py-0.5 rounded text-xs border border-tavern-border-soft bg-tavern-bg text-tavern-text text-center focus:outline-none focus:border-tavern-accent/40 disabled:opacity-50"
                      title="自定义 Token 数"
                    />
                  </div>
                </div>
                {outputBudgetPreview.riskMessage && (
                  <p className="text-xs text-amber-500">{outputBudgetPreview.riskMessage}</p>
                )}
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
                          <QuickIconButton
                            compact
                            onClick={() => changeActiveLorebooks([...activeLorebookIds, id])}
                            label={`激活世界书 ${lb.name}`}
                          >
                            <ChevronDown className="w-3 h-3 rotate-[-90deg]" />
                          </QuickIconButton>
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
                        <QuickIconButton
                          compact
                          danger
                          onClick={() => changeActiveLorebooks(activeLorebookIds.filter(i => i !== id))}
                          label={`移除世界书 ${lb.name}`}
                        >
                          <X className="w-3 h-3" />
                        </QuickIconButton>
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
                          <QuickIconButton compact label="清除世界书搜索" onClick={() => setLorebookSearch('')}>
                            <X className="w-3 h-3" />
                          </QuickIconButton>
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
                            disabled={isGroup && isBound}
                            onClick={() => {
                              if (isGroup && isBound) return
                              if (checked) {
                                changeActiveLorebooks(activeLorebookIds.filter(id2 => id2 !== lb.id))
                              } else {
                                changeActiveLorebooks([...activeLorebookIds, lb.id])
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
                        标注锁图标的为{isGroup ? '成员绑定' : '角色绑定'}世界书，{isGroup ? '在群聊中始终生效' : '切换角色时自动激活'}
                      </p>
                    )}
                    {activeLorebookIds.length > 0 && (
                      <button
                        className="text-xs text-tavern-text-muted hover:text-tavern-danger transition-colors"
                        onClick={() => changeActiveLorebooks(boundLorebookIds)}
                      >
                        清除全部 ({activeLorebookIds.length})
                      </button>
                    )}
                    {/* 当前选择与角色默认不同时，显示"保存为默认"按钮 */}
                    {!isGroup && currentCharId && activeLorebookIds.length > 0 && (() => {
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
            <div className="mt-3 space-y-2 border-t border-tavern-border-soft pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-0.5 text-xs text-tavern-text-muted">
                  Token 预算占比
                  <HintIcon
                    hint={
                      <>
                        <p>
                          世界书注入最多占上下文预算的比例（默认 30%），超出部分按优先级与相关度裁剪。
                        </p>
                        <p className="mt-1.5">
                          它是<strong className="text-tavern-text-soft">天花板而非预扣</strong>：世界书实际用多少算多少，
                          剩余预算全部留给历史消息，不会“锁死 70%”。
                        </p>
                        <p className="mt-1.5 pt-1.5 border-t border-tavern-border-soft">
                          大上下文（如 1M）下 30% ≈ 30 万 token，通常远用不满，保持默认即可；
                          仅在拥有超大世界书时考虑调大。
                        </p>
                      </>
                    }
                  />
                </span>
                <div
                  role="radiogroup"
                  aria-label="Token 预算占比"
                  className="flex shrink-0 items-center gap-0.5 rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/60 p-0.5"
                >
                  {([['20%', 0.2], ['30%', 0.3], ['50%', 0.5], ['不限', 1]] as const).map(([label, r]) => {
                    const selected = (settings.lorebookRatio ?? 0.3) === r
                    return (
                      <button
                        key={label}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => updateSettings({ lorebookRatio: r })}
                        className={cn(
                          'h-6 rounded-md px-2 text-[11px] font-medium transition-all',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tavern-accent/40',
                          selected
                            ? 'bg-tavern-accent-soft text-tavern-accent shadow-sm ring-1 ring-inset ring-tavern-accent/35'
                            : 'text-tavern-text-muted hover:bg-tavern-bg-hover hover:text-tavern-text'
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/40 px-2.5 py-2 space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-medium text-tavern-text-soft">预算预览</span>
                  <span className="font-mono text-xs text-tavern-text tabular-nums">
                    ~{lorebookBudgetPreview.total.toLocaleString()}
                    <span className="ml-0.5 text-[10px] text-tavern-text-muted">token</span>
                  </span>
                </div>
                {/* 瀑布分桶示意：常驻 40% → 条件累计至 90% → 细节用剩余 */}
                <div
                  className="flex h-1.5 overflow-hidden rounded-full bg-tavern-bg-hover"
                  aria-hidden
                  title="世界书预算瀑布分桶"
                >
                  <div className="h-full bg-tavern-accent/65" style={{ width: '40%' }} />
                  <div className="h-full bg-tavern-accent/30" style={{ width: '50%' }} />
                  <div className="h-full bg-tavern-border" style={{ width: '10%' }} />
                </div>
                <dl className="space-y-0.5 text-[10px] text-tavern-text-muted">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-tavern-accent/65" />
                      常驻上限 40%
                    </dt>
                    <dd className="font-mono tabular-nums">~{lorebookBudgetPreview.always.toLocaleString()}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-tavern-accent/30" />
                      常驻+条件累计 90%
                    </dt>
                    <dd className="font-mono tabular-nums">~{lorebookBudgetPreview.conditional.toLocaleString()}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-tavern-border" />
                      细节
                    </dt>
                    <dd>使用剩余额度</dd>
                  </div>
                </dl>
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
                <HintIcon
                  align="right"
                  hint={
                    <>
                      <p>
                        角色卡「对话示例」会作为<strong className="text-tavern-text-soft">风格示范</strong>注入上下文，
                        帮助 AI 模仿角色的语气、口癖与格式（few-shot）。
                      </p>
                      <p className="mt-1.5 pt-1.5 border-t border-tavern-border-soft">
                        仅首轮 / 关闭可节省每轮固定的 token 开销。
                      </p>
                    </>
                  }
                />
              </div>
            </div>
          </Section>

        </div>
      </div>
    </>
  )
}

/* ===== 子组件 ===== */

function QuickIconButton({
  label,
  onClick,
  children,
  disabled = false,
  compact = false,
  danger = false,
  className,
}: {
  label: string
  onClick: React.MouseEventHandler<HTMLButtonElement>
  children: React.ReactNode
  disabled?: boolean
  compact?: boolean
  danger?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border border-transparent text-tavern-text-muted transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-tavern-accent/60',
        'disabled:cursor-not-allowed disabled:opacity-40',
        compact ? 'h-5 w-5 rounded-md' : 'h-7 w-7 rounded-lg',
        danger
          ? 'hover:border-tavern-danger/15 hover:bg-tavern-danger/10 hover:text-tavern-danger'
          : 'hover:border-tavern-border-soft hover:bg-tavern-bg-hover hover:text-tavern-accent',
        className,
      )}
    >
      {children}
    </button>
  )
}

function ActionButton({ icon: Icon, label, onClick, danger = false }: {
  icon: React.ElementType
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 min-w-0 px-2.5 py-2 rounded-lg border text-left text-xs transition-colors',
        danger
          ? 'border-tavern-danger/20 text-tavern-danger hover:bg-tavern-danger/10'
          : 'border-tavern-border-soft bg-tavern-bg-card text-tavern-text-soft hover:border-tavern-accent/40 hover:text-tavern-accent',
      )}
    >
      <span className={cn(
        QUICK_BUTTON_ICON_BADGE_CLASS,
        danger
          ? 'border-tavern-danger/15 bg-tavern-danger/10 text-tavern-danger'
          : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-muted',
      )}>
        <Icon className={QUICK_BUTTON_ICON_CLASS} />
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function ToggleSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-tavern-accent',
        checked ? 'bg-tavern-accent' : 'bg-tavern-bg-hover',
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-4' : 'translate-x-0',
      )} />
    </button>
  )
}

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

function ParamChip({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="px-2 py-1 rounded-md bg-tavern-bg-soft border border-tavern-border-soft text-center">
      <div className="text-[11px] uppercase tracking-wide opacity-60">{label}</div>
      <div className="font-mono font-medium text-xs">{value ?? '-'}</div>
    </div>
  )
}

function SliderRow({ label, value, min, max, step, disabled, hint }: {
  label: string; value: number; min: number; max: number; step: number; disabled?: boolean; hint?: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="flex items-center gap-0.5 text-xs text-tavern-text-muted">
          <span>{label}</span>
          {hint && <HintIcon hint={hint} />}
        </label>
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

/** ⓘ 点击弹出提示（说明气泡）
 * 关闭机制：document 级点击监听（不依赖 fixed 遮罩，规避面板 transform 导致 fixed 定位失效的问题）
 */
function HintIcon({ hint, align = 'left' }: { hint: React.ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // 捕获阶段监听，确保先于面板其他点击处理
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      <QuickIconButton
        compact
        label="查看说明"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      >
        <Info className="w-3 h-3" />
      </QuickIconButton>
      {open && (
        <div className={cn(
          'absolute top-full mt-1 w-56 p-2.5 rounded-lg bg-tavern-bg-card border border-tavern-border shadow-xl z-50 text-[10px] leading-relaxed text-tavern-text-muted',
          align === 'right' ? 'right-0' : 'left-0',
        )}>
          {hint}
        </div>
      )}
    </span>
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
