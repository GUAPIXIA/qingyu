import { useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { Sliders, SlidersHorizontal, Plus, Upload, Trash2, Shield, Copy, Download, Sparkles, Play, Loader2, Wand2, X, ChevronDown, ChevronRight } from 'lucide-react'
import { BUILTIN_TEMPLATE_NAMES } from '../../shared/chat-core/chatTemplates'
import { cn } from '../lib/utils'
import { parsePresetGeneration } from '../utils/presetGen'
import { EditorAssistant } from '../store/editorAssistant'
import { EditorSuggestions } from '../components/common/EditorSuggestions'
import { useSettingsStore } from '../store/useSettingsStore'
import { useToastStore } from '../store/useToastStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { syncBuildData } from '../context/rendererContextProvider'
import { buildChatParamsFromData, buildContextMessagesFromData } from '../../shared/chat-core/contextBuilder'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { RESPONSE_LENGTH_LABELS, resolveResponsePolicy } from '../../shared/responsePolicy'
import { formatRequestBudgetRisk } from '../../shared/modelOutputProfile'
import type { ChatParams, Message, Preset, ResponseLengthMode } from '../../shared/types'
import { resolveRendererGenerationTaskBudget } from '../store/generationTaskBudget'
import { resolveGenerationTaskBudget, type GenerationTask } from '../../shared/generationTaskBudget'

/** 模板名 → 展示标签 */
const TEMPLATE_LABELS: Record<string, string> = {
  chatml: 'ChatML（Qwen/DeepSeek）',
  qwen: 'Qwen（ChatML）',
  deepseek: 'DeepSeek（ChatML）',
  llama2: 'Llama 2',
  llama3: 'Llama 3',
  mistral: 'Mistral',
  phi3: 'Phi-3',
  alpaca: 'Alpaca',
  gemma: 'Gemma',
  'command-r': 'Command R',
}

/** 提示词体量用人话描述，避免默认路径暴露 Token 估算 */
function describePromptBulk(preset: Pick<Preset, 'systemPrompt' | 'jailbreak'>): string {
  const chars = (preset.systemPrompt?.length ?? 0) + (preset.jailbreak?.length ?? 0)
  if (chars === 0) return '空白'
  if (chars < 400) return '简短'
  if (chars < 1200) return '适中'
  return '偏长'
}

function createPreset(): Preset {
  return {
    id: nanoid(),
    name: '新建预设',
    description: '',
    systemPrompt: '',
    jailbreak: '',
    maxContext: 0, // 0 = 跟随模型默认
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 0, // 0 = 自动计算；正数 = 用户明确硬上限
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
    contextTemplate: '',
    group: '',
    enableThoughtFormat: undefined,
  }
}

export function PresetsPage() {
  const liveSettings = useSettingsStore((state) => state.settings)
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingPreset, setEditingPresetState] = useState<Preset | null>(null)
  const editorRef = useRef<EditorAssistant | null>(null)
  if (!editorRef.current) editorRef.current = new EditorAssistant('preset', '')
  const editor = editorRef.current
  const editingRef = useRef<Preset | null>(null)
  const setEditingPreset = (value: Preset | null | ((prev: Preset | null) => Preset | null)) => {
    const next = typeof value === 'function' ? value(editingRef.current) : value
    editor.syncObject(next?.id ?? ''); editor.touch()
    editingRef.current = next; setEditingPresetState(next)
  }
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [busyMsg, setBusyMsg] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<{ message: string; error: boolean } | null>(null)
  const importNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // AI 生成预设
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [presetAdvancedOpen, setPresetAdvancedOpen] = useState(false)
  const [aiGenDesc, setAiGenDesc] = useState('')
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const [aiGenError, setAiGenError] = useState<string | null>(null)
  // 预设测试器
  const [testInput, setTestInput] = useState('*轻轻推开门* 你终于来了，我等了好久。')
  const [testOutput, setTestOutput] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const testRequestRef = useRef<string | null>(null)
  const presetBudgetPreview = useMemo(() => {
    if (!editingPreset) return null
    const profile = liveSettings.connectionProfiles.find(
      (item) => item.id === liveSettings.activeProfileId,
    )
    const model = liveSettings.activeModel || profile?.model || 'gpt-4o-mini'
    const responsePolicy = resolveResponsePolicy({ presetHint: editingPreset.responseLengthHint })
    const requestBudget = resolveGenerationTaskBudget({
      task: 'main',
      model,
      expectedBodyChars: responsePolicy.hardMaxChars,
      userHardCap: editingPreset.maxTokens,
    })
    return {
      requestBudget,
      riskMessage: formatRequestBudgetRisk(requestBudget),
    }
  }, [editingPreset, liveSettings.activeModel, liveSettings.activeProfileId, liveSettings.connectionProfiles])

  const loadPresets = () => {
    window.api.preset.list().then(setPresets)
  }

  useEffect(() => {
    editor.activate()
    loadPresets()
    return () => {
      if (importNoticeTimerRef.current) clearTimeout(importNoticeTimerRef.current)
      editor.dispose()
    }
  }, [editor])

  const showImportNotice = (message: string, error = false) => {
    setImportNotice({ message, error })
    if (importNoticeTimerRef.current) clearTimeout(importNoticeTimerRef.current)
    importNoticeTimerRef.current = setTimeout(() => setImportNotice(null), error ? 6000 : 8000)
  }

  const handleNew = () => {
    setEditingPreset(createPreset())
  }

  const handleImport = async () => {
    try {
      const imported = await window.api.preset.importJson()
      if (!imported) {
        // UEX-P0-03：取消导入给出明确提示（对齐 QuickRepliesPage 的「已取消导入」）
        showImportNotice('已取消导入')
        return
      }
      loadPresets()
      const compatibilityLabel = imported.sourceFormat === 'standard' ? '（已转换标准格式）' : ''
      const unsupported = imported.unsupportedFields.length > 0
        ? `；未支持并已跳过：${imported.unsupportedFields.join('、')}`
        : ''
      showImportNotice(`已导入「${imported.preset.name}」${compatibilityLabel}${unsupported}`)
    } catch (error) {
      showImportNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  /** 一键复制：基于任意预设（含内置）创建可编辑副本 */
  const handleDuplicate = async (preset: Preset) => {
    const copy: Preset = {
      ...preset,
      id: nanoid(),
      name: `${preset.name} (副本)`,
      isBuiltin: false,
    }
    await window.api.preset.save(copy)
    loadPresets()
  }

  /** 导出单个预设 JSON */
  const handleExport = async (preset: Preset) => {
    setBusyMsg(`正在导出「${preset.name}」...`)
    try {
      const r = await window.api.preset.exportJson(preset.id)
      if (r.error) {
        useToastStore.getState().push({ variant: 'error', title: `导出失败：${r.error}`, requestId: 'preset-export' })
      } else {
        useToastStore.getState().push({ variant: 'success', title: `已导出「${preset.name}」`, requestId: 'preset-export' })
      }
    } catch (e) {
      useToastStore.getState().push({ variant: 'error', title: `导出失败：${(e as Error).message}`, requestId: 'preset-export' })
    } finally {
      setBusyMsg(null)
    }
  }

  /** 流式调用辅助：注册 onChunk/onDone/onError，返回清理函数 */
  const streamCall = async (opts: {
    requestId: string
    messages: ChatParams['messages']
    onResult: (text: string) => void
    onError: (msg: string) => void
    task?: GenerationTask
    inputChars?: number
    expectedBodyChars?: number
    extra?: Partial<Pick<ChatParams,
      'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty' | 'presencePenalty' | 'instructTemplate'>>
  }) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) return
    const ticket = editor.begin(opts.task ?? 'generic', [editingRef.current, opts.messages])
    try {
      const model = profile.model
      const plan = opts.extra?.maxTokens == null
        ? await resolveRendererGenerationTaskBudget({ profile, model, task: opts.task ?? 'generic', inputChars: opts.inputChars, expectedBodyChars: opts.expectedBodyChars })
        : null
      const result = await editor.request(ticket, {
        requestId: opts.requestId, messages: opts.messages,
        provider: profile.provider, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model,
        temperature: opts.extra?.temperature ?? 0.7, topP: opts.extra?.topP ?? 0.95,
        maxTokens: opts.extra?.maxTokens ?? plan!.requestMaxTokens,
        frequencyPenalty: opts.extra?.frequencyPenalty ?? 0, presencePenalty: opts.extra?.presencePenalty ?? 0,
        stream: true, instructTemplate: opts.extra?.instructTemplate,
        ...(plan ? { reasoningGate: plan.reasoningGate } : {}),
        observability: { source: 'aux', taskType: opts.task ?? 'generic' },
      })
      if (editor.current(ticket)) opts.onResult(result)
      else if (editor.owns(ticket)) editor.keep(ticket, result, opts.task === 'preset_draft' ? '预设生成' : '预设测试')
    } catch (error) {
      if (editor.owns(ticket)) opts.onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (editor.owns(ticket)) { setAiGenBusy(false); setTestBusy(false) }
      editor.finish(ticket)
    }
  }

  /** AI 生成预设：描述需求 → 生成 systemPrompt/jailbreak/参数建议 */
  const handleAiGenerate = async () => {
    if (!editingPreset || !aiGenDesc.trim() || aiGenBusy) return
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setAiGenError('请先在“模型”页面配置连接')
      return
    }
    setAiGenBusy(true)
    setAiGenError(null)
    const requestId = `preset-gen-${Date.now()}`
    await streamCall({
      requestId,
      task: 'preset_draft',
      inputChars: aiGenDesc.trim().length,
      messages: [
        {
          role: 'system',
          content: `你是一个角色扮演预设配置生成器。根据用户的需求描述，生成中文预设。

严格按以下格式输出：
【SystemPrompt】
200 字内的系统提示词（含角色扮演要求、回复风格、语气、长度控制）

【Jailbreak】
可选的越狱/创作提示词；不需要时写“无”

【参数建议】
温度: <0-2>
TopP: <0-1>

只输出上述格式内容。`,
        },
        { role: 'user', content: aiGenDesc.trim().slice(0, 500) },
      ],
      onResult: (result) => {
        setAiGenBusy(false)
        const parsed = parsePresetGeneration(result)
        if (parsed.systemPrompt) {
          updateField('systemPrompt', parsed.systemPrompt)
          updateField('jailbreak', parsed.jailbreak)
          if (parsed.temperature !== undefined) updateField('temperature', parsed.temperature)
          if (parsed.topP !== undefined) updateField('topP', parsed.topP)
          setAiGenOpen(false)
          setAiGenDesc('')
        } else {
          setAiGenError('生成失败：未能解析输出')
        }
      },
      onError: (msg) => {
        setAiGenBusy(false)
        setAiGenError(`生成失败：${msg}`)
      },
    })
  }

  /** 预设测试器：用当前预设参数对样例输入跑一次真实生成 */
  const handleTestGenerate = async () => {
    if (!editingPreset || !testInput.trim() || testBusy) return
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setTestOutput('⚠ 请先在“模型”页面配置连接')
      return
    }
    if (presetBudgetPreview?.riskMessage) {
      setTestOutput(`⚠ ${presetBudgetPreview.riskMessage}`)
      return
    }
    setTestBusy(true)
    setTestOutput('')
    const requestId = `preset-test-${Date.now()}`
    testRequestRef.current = requestId
    let messages: ChatParams['messages'] = [
      {
        role: 'system',
        content: [editingPreset.systemPrompt, editingPreset.jailbreak].filter(Boolean).join('\n\n')
          || '你是一个角色扮演助手。',
      },
      { role: 'user', content: testInput.slice(0, 2000) },
    ]
    let effectiveParams: Partial<Pick<ChatParams,
      'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty' | 'presencePenalty' | 'instructTemplate'>> = {
      temperature: editingPreset.temperature,
      topP: editingPreset.topP,
      maxTokens: presetBudgetPreview?.requestBudget.requestMaxTokens ?? editingPreset.maxTokens,
      frequencyPenalty: editingPreset.frequencyPenalty,
      presencePenalty: editingPreset.presencePenalty,
    }

    // 有当前角色时复用正式对话的完整上下文构建器，使测试结果包含角色卡、
    // 人设、世界书、示例对话、心理描写与上下文模板。
    const settings = useSettingsStore.getState().settings
    const activeCharacter = useCharacterStore.getState().characters
      .find((character) => character.id === settings.activeCharacterId)
    if (activeCharacter) {
      const data = syncBuildData(activeCharacter, editingPreset)
      const testMessage: Message = {
        id: `preset-test-message-${Date.now()}`,
        sessionId: data.chat.currentSessionId ?? 'preset-test',
        characterId: activeCharacter.id,
        role: 'user',
        content: testInput.slice(0, 2000),
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      }
      data.chat = { ...data.chat, messages: [...data.chat.messages, testMessage] }
      const built = buildContextMessagesFromData(data)
      const budgetRisk = formatRequestBudgetRisk(built.requestBudget)
      if (budgetRisk) {
        setTestBusy(false)
        setTestOutput(`⚠ ${budgetRisk}`)
        return
      }
      const params = buildChatParamsFromData(data, built.messages, {
        requestMaxTokens: built.requestMaxTokens,
        // 预设测试生成按辅助调用记录观测，不进入主对话基线
        source: 'aux',
      })
      messages = params.messages
      effectiveParams = {
        temperature: params.temperature,
        topP: params.topP,
        maxTokens: params.maxTokens,
        frequencyPenalty: params.frequencyPenalty,
        presencePenalty: params.presencePenalty,
        instructTemplate: params.instructTemplate,
      }
    }
    await streamCall({
      requestId,
      messages,
      onResult: (result) => {
        if (testRequestRef.current !== requestId) return
        setTestBusy(false)
        setTestOutput(result.trim())
      },
      onError: (msg) => {
        if (testRequestRef.current !== requestId) return
        setTestBusy(false)
        setTestOutput(`⚠ ${msg}`)
      },
      extra: effectiveParams,
    })
  }

  const handleTestStop = () => {
    editor.cancel()
    if (testRequestRef.current) {
      window.api.ai.cancelChat(testRequestRef.current).catch(() => {})
      testRequestRef.current = null
      setTestBusy(false)
    }
  }

  const handleEdit = (preset: Preset) => {
    setAiGenBusy(false); setTestBusy(false); setTestOutput(''); setAiGenError(null)
    setEditingPreset({ ...preset })
  }

  const handleSave = async () => {
    if (!editingPreset) return
    // 内置预设保存时后端会自动创建副本并返回新 preset
    const saved = await window.api.preset.save(editingPreset)
    setEditingPreset(saved)
    loadPresets()
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await window.api.preset.delete(deleteId)
    setDeleteId(null)
    loadPresets()
  }

  const updateField = <K extends keyof Preset>(key: K, value: Preset[K]) => {
    setEditingPreset((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <h1 className="font-display text-lg font-bold">预设</h1>
        <div className="flex items-center gap-2">
          <button onClick={handleNew} className="btn-primary">
            <Plus className="w-4 h-4" />
            新建
          </button>
          <button onClick={handleImport} className="btn-secondary">
            <Upload className="w-4 h-4" />
            导入
          </button>
        </div>
      </header>

      {/* 预设列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {presets.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Sliders className="w-8 h-8" />}
            title="还没有预设"
            description="创建你的第一个预设，配置 AI 的生成参数和提示词"
            action={
              <div className="flex gap-2">
                <button className="btn-primary" onClick={handleNew}>
                  <Plus className="w-4 h-4" />
                  新建预设
                </button>
                <button className="btn-secondary" onClick={handleImport}>
                  <Upload className="w-4 h-4" />
                  导入预设
                </button>
              </div>
            }
          />
        ) : (
          <div className="max-w-5xl mx-auto space-y-4">
            {busyMsg && <div className="text-sm text-tavern-text-muted">{busyMsg}</div>}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {presets.map((preset) => (
                        <div
                          key={preset.id}
                          onClick={() => handleEdit(preset)}
                          className="card p-4 cursor-pointer hover:bg-tavern-bg-hover transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Sliders className="w-4 h-4 text-tavern-accent shrink-0" />
                              <h3 className="font-medium text-tavern-text truncate">{preset.name}</h3>
                              {preset.isBuiltin && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent text-xs shrink-0">
                                  <Shield className="w-3 h-3" />
                                  内置
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {/* 复制 */}
                              <button
                                className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDuplicate(preset)
                                }}
                                title="复制为新预设"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              {/* 导出 */}
                              <button
                                className="btn-ghost p-1.5 text-tavern-text-muted hover:text-tavern-accent shrink-0"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleExport(preset)
                                }}
                                title="导出 JSON"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              {!preset.isBuiltin && (
                                <button
                                  className="btn-ghost p-1.5 text-tavern-danger shrink-0"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setDeleteId(preset.id)
                                  }}
                                  title="删除"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-tavern-text-muted line-clamp-2 mb-3 min-h-[2rem]">
                            {preset.description || '无描述'}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                              篇幅 {RESPONSE_LENGTH_LABELS[preset.responseLengthHint ?? 'auto']}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                              {preset.temperature >= 1 ? '偏创意' : preset.temperature <= 0.6 ? '偏稳定' : '平衡'}
                            </span>
                          </div>
                        </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 编辑 Modal */}
      <Modal
        open={!!editingPreset}
        onClose={() => setEditingPreset(null)}
        title={editingPreset?.isBuiltin ? '查看预设（保存后创建副本）' : '编辑预设'}
        width="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditingPreset(null)}>
              关闭
            </button>
            <button className="btn-primary" onClick={handleSave}>
              保存
            </button>
          </>
        }
      >
        {editingPreset && (
          <div className="space-y-4">
            {editingPreset.isBuiltin && (
              <div className="px-3 py-2 rounded-lg bg-tavern-accent-soft text-tavern-accent text-xs flex items-center gap-2">
                <Shield className="w-4 h-4" />
                这是内置预设，保存后将自动创建一个可编辑的副本。
              </div>
            )}

            <EditorSuggestions suggestions={editor.suggestions} objectId={editingPreset.id} />
            {/* AI 生成预设（第三批） */}
            <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/60">
              <button
                type="button"
                onClick={() => setAiGenOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-tavern-text-soft hover:text-tavern-accent transition-colors"
              >
                <Wand2 className="w-3.5 h-3.5 text-tavern-accent" />
                AI 生成预设
                {aiGenOpen ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
              </button>
              {aiGenOpen && (
                <div className="px-3 pb-3 space-y-2">
                  <textarea
                    className="textarea min-h-[60px]"
                    placeholder="描述你想要的预设风格，如：冷傲女王系，回复简短带刺，偶尔毒舌，喜欢用*动作描写*"
                    value={aiGenDesc}
                    onChange={(e) => { editor.touch(); setAiGenDesc(e.target.value) }}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAiGenerate}
                      disabled={aiGenBusy || !aiGenDesc.trim()}
                      className="btn-primary text-xs"
                    >
                      {aiGenBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {aiGenBusy ? '生成中...' : '生成预设'}
                    </button>
                    {aiGenError && <span className="text-xs text-tavern-danger">{aiGenError}</span>}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">名称</label>
                <input
                  className="input"
                  value={editingPreset.name}
                  onChange={(e) => updateField('name', e.target.value)}
                />
              </div>
              <div>
                <label className="label">描述</label>
                <input
                  className="input"
                  value={editingPreset.description}
                  onChange={(e) => updateField('description', e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="label">System Prompt</label>
              <textarea
                className="textarea h-28"
                placeholder="系统提示词..."
                value={editingPreset.systemPrompt}
                onChange={(e) => updateField('systemPrompt', e.target.value)}
              />
            </div>

            <div>
              <label className="label">Jailbreak</label>
              <textarea
                className="textarea h-20"
                placeholder="越狱提示词（可选）..."
                value={editingPreset.jailbreak}
                onChange={(e) => updateField('jailbreak', e.target.value)}
              />
            </div>

            {/* 提示词体量：默认路径用「简短/适中/偏长」，不暴露 Token */}
            <div className="px-3 py-2 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft text-xs flex items-center gap-3 flex-wrap">
              <span className="text-tavern-text-muted">提示词体量：</span>
              <span className="text-tavern-accent font-medium">{describePromptBulk(editingPreset)}</span>
              <span className="text-tavern-text-muted/70">不含角色设定与世界书，仅作参考</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">上下文模板（Ollama 本地模型用）</label>
                <select
                  className="select"
                  value={editingPreset.contextTemplate || ''}
                  onChange={(e) => updateField('contextTemplate', e.target.value || undefined)}
                >
                  <option value="">不启用（消息数组直发）</option>
                  {BUILTIN_TEMPLATE_NAMES.map((name) => (
                    <option key={name} value={name}>{TEMPLATE_LABELS[name] ?? name}</option>
                  ))}
                </select>
                <p className="text-xs text-tavern-text-muted mt-1">启用后 Ollama 改用纯文本接口 + 模板包装，适合 chat template 缺失/异常的本地模型；Qwen / DeepSeek 选 ChatML</p>
              </div>
              <div>
                <label className="label">示例对话发送（覆盖全局设置）</label>
                <select
                  className="select"
                  value={editingPreset.exampleDialogMode ?? ''}
                  onChange={(e) => updateField('exampleDialogMode', (e.target.value || undefined) as 'always' | 'first_turn' | 'off' | undefined)}
                >
                  <option value="">跟随全局设置</option>
                  <option value="always">每轮</option>
                  <option value="first_turn">仅首轮</option>
                  <option value="off">关闭</option>
                </select>
                <p className="text-xs text-tavern-text-muted mt-1">控制角色卡「对话示例」的注入时机（few-shot 风格示范）</p>
              </div>
              <div>
                <label className="label">心理描写格式（覆盖全局设置）</label>
                <select
                  className="select"
                  value={editingPreset.enableThoughtFormat === undefined ? '' : String(editingPreset.enableThoughtFormat)}
                  onChange={(e) => updateField(
                    'enableThoughtFormat',
                    e.target.value === '' ? undefined : e.target.value === 'true',
                  )}
                >
                  <option value="">跟随全局设置</option>
                  <option value="true">开启 &lt;thought&gt; 心理描写</option>
                  <option value="false">关闭（适合短对话/短信体）</option>
                </select>
                <p className="text-xs text-tavern-text-muted mt-1">关闭后不会向模型追加心理活动输出要求</p>
              </div>
            </div>

            {/* 回复与采样：默认只给「人话」控件 */}
            <div>
              <label className="label">回复篇幅</label>
              <select
                className="input"
                value={editingPreset.responseLengthHint ?? 'auto'}
                onChange={(e) => updateField('responseLengthHint', e.target.value as ResponseLengthMode)}
              >
                {(Object.keys(RESPONSE_LENGTH_LABELS) as ResponseLengthMode[]).map((mode) => (
                  <option key={mode} value={mode}>{RESPONSE_LENGTH_LABELS[mode]}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-tavern-text-muted">系统会按篇幅自动安排输出，无需填写 Token。</p>
            </div>

            <div>
              <label className="label">文风手感</label>
              <div className="flex gap-2">
                {[
                  { name: '创意', temp: 1.1, topP: 0.98, fp: 0.3, pp: 0.3, desc: '高随机，剧情发散' },
                  { name: '平衡', temp: 0.8, topP: 0.95, fp: 0, pp: 0, desc: '通用默认' },
                  { name: '稳定', temp: 0.5, topP: 0.9, fp: 0, pp: 0, desc: '低随机，信息密集' },
                ].map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    title={tpl.desc}
                    onClick={() => {
                      updateField('temperature', tpl.temp)
                      updateField('topP', tpl.topP)
                      updateField('frequencyPenalty', tpl.fp)
                      updateField('presencePenalty', tpl.pp)
                    }}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs border transition-colors',
                      editingPreset.temperature === tpl.temp && editingPreset.topP === tpl.topP
                        ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                        : 'border-tavern-border-soft text-tavern-text-muted hover:border-tavern-border hover:text-tavern-text'
                    )}
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 高级采样与上限：默认折叠，日常路径不要求理解 Token */}
            <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/40">
              <button
                type="button"
                onClick={() => setPresetAdvancedOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-medium text-tavern-text-soft hover:text-tavern-accent transition-colors"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                高级参数
                <span className="ml-auto text-[11px] text-tavern-text-muted font-normal">
                  {presetAdvancedOpen ? '收起' : '温度、上限等'}
                </span>
                {presetAdvancedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
              {presetAdvancedOpen && (
                <div className="px-3 pb-3 grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">温度：{editingPreset.temperature}</label>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={editingPreset.temperature}
                      onChange={(e) => updateField('temperature', Number(e.target.value))}
                      className="w-full accent-tavern-accent"
                    />
                  </div>
                  <div>
                    <label className="label">Top P：{editingPreset.topP}</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={editingPreset.topP}
                      onChange={(e) => updateField('topP', Number(e.target.value))}
                      className="w-full accent-tavern-accent"
                    />
                  </div>
                  <div>
                    <label className="label">模型输出硬上限（0 = 自动）</label>
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={editingPreset.maxTokens}
                      onChange={(e) => updateField('maxTokens', Math.max(0, Number(e.target.value) || 0))}
                    />
                    {presetBudgetPreview?.riskMessage && (
                      <p className="mt-1 text-xs text-amber-500">{presetBudgetPreview.riskMessage}</p>
                    )}
                  </div>
                  <div>
                    <label className="label">上下文长度（0 = 跟随模型）</label>
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={editingPreset.maxContext}
                      onChange={(e) => updateField('maxContext', Number(e.target.value) || 0)}
                    />
                  </div>
                  <div>
                    <label className="label">频率惩罚：{editingPreset.frequencyPenalty}</label>
                    <input
                      type="range"
                      min={-2}
                      max={2}
                      step={0.1}
                      value={editingPreset.frequencyPenalty}
                      onChange={(e) => updateField('frequencyPenalty', Number(e.target.value))}
                      className="w-full accent-tavern-accent"
                    />
                  </div>
                  <div>
                    <label className="label">存在惩罚：{editingPreset.presencePenalty}</label>
                    <input
                      type="range"
                      min={-2}
                      max={2}
                      step={0.1}
                      value={editingPreset.presencePenalty}
                      onChange={(e) => updateField('presencePenalty', Number(e.target.value))}
                      className="w-full accent-tavern-accent"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 预设测试器（第三批） */}
            <div className="rounded-lg border border-tavern-border-soft bg-tavern-bg-soft/60 p-3 space-y-2">
              <label className="label flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-tavern-accent" />
                预设测试器
                <span className="text-xs text-tavern-text-muted font-normal">复用当前角色与完整上下文，不保存到对话</span>
              </label>
              <div className="flex gap-1.5">
                <textarea
                  className="textarea min-h-[48px] flex-1"
                  placeholder="输入测试消息..."
                  value={testInput}
                  onChange={(e) => { editor.touch(); setTestInput(e.target.value) }}
                />
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={handleTestGenerate}
                    disabled={testBusy || !testInput.trim()}
                    className="btn-primary text-xs"
                    title="用当前 System Prompt + Jailbreak + 采样参数生成"
                  >
                    {testBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {testBusy ? '生成中' : '测试'}
                  </button>
                  {testBusy && (
                    <button onClick={handleTestStop} className="btn-ghost text-xs text-tavern-danger">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              {testOutput && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-tavern-text-muted">
                      参数：温度 {editingPreset.temperature} · TopP {editingPreset.topP} · 篇幅 {RESPONSE_LENGTH_LABELS[editingPreset.responseLengthHint ?? 'auto']}
                    </span>
                    <button
                      onClick={() => navigator.clipboard.writeText(testOutput)}
                      className="text-xs text-tavern-text-muted hover:text-tavern-accent flex items-center gap-0.5"
                    >
                      <Copy className="w-3 h-3" /> 复制
                    </button>
                  </div>
                  <div className="p-3 rounded-lg bg-tavern-bg-card border border-tavern-border-soft text-sm whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {testOutput}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="删除预设"
        message="确定要删除这个预设吗？此操作不可撤销。"
        confirmText="删除"
        danger
      />

      {importNotice && (
        <div
          role="status"
          className={cn(
            'fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-[min(42rem,calc(100vw-2rem))] px-4 py-2.5 rounded-lg border shadow-xl text-sm animate-in fade-in slide-in-from-top-2',
            importNotice.error
              ? 'bg-tavern-bg-soft border-tavern-danger text-tavern-danger'
              : 'bg-tavern-bg-soft border-tavern-border text-tavern-text',
          )}
        >
          {importNotice.message}
        </div>
      )}
    </div>
  )
}
