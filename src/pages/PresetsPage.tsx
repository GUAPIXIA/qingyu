import { useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { Modal } from '../components/common/Modal'
import { EmptyState } from '../components/common/EmptyState'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { Sliders, Plus, Upload, Trash2, Shield, Copy, Download, ChevronDown, ChevronRight, Sparkles, Play, Loader2, Wand2, X } from 'lucide-react'
import { BUILTIN_TEMPLATE_NAMES } from '../utils/chatTemplates'
import { cn } from '../lib/utils'
import { estimateTokens } from '../utils/tokenCounter'
import { parsePresetGeneration } from '../utils/presetGen'
import { useSettingsStore } from '../store/useSettingsStore'
import { useCharacterStore } from '../store/useCharacterStore'
import { syncBuildData } from '../context/rendererContextProvider'
import { buildChatParamsFromData, buildContextMessagesFromData } from '../context/contextBuilder'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import type { ChatParams, Message, Preset } from '../../shared/types'

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
    maxTokens: 1024,
    frequencyPenalty: 0,
    presencePenalty: 0,
    isBuiltin: false,
    contextTemplate: '',
    group: '',
    enableThoughtFormat: undefined,
  }
}

/** 分组键：空 group 归入「未分组」 */
function groupKey(preset: Preset): string {
  return preset.group?.trim() || '未分组'
}

export function PresetsPage() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [busyMsg, setBusyMsg] = useState<string | null>(null)
  // AI 生成预设
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [aiGenDesc, setAiGenDesc] = useState('')
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const [aiGenError, setAiGenError] = useState<string | null>(null)
  // 预设测试器
  const [testInput, setTestInput] = useState('*轻轻推开门* 你终于来了，我等了好久。')
  const [testOutput, setTestOutput] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const testRequestRef = useRef<string | null>(null)

  const loadPresets = () => {
    window.api.preset.list().then(setPresets)
  }

  useEffect(() => {
    loadPresets()
  }, [])

  /** 按分组聚合（保留组出现顺序） */
  const grouped = useMemo(() => {
    const map = new Map<string, Preset[]>()
    for (const preset of presets) {
      const key = groupKey(preset)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(preset)
    }
    return [...map.entries()]
  }, [presets])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleNew = () => {
    setEditingPreset(createPreset())
  }

  const handleImport = async () => {
    const imported = await window.api.preset.importJson()
    if (imported) loadPresets()
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
      if (r.error) setBusyMsg(`导出失败：${r.error}`)
      else setBusyMsg(null)
    } finally {
      setBusyMsg(null)
    }
  }

  /** 流式调用辅助：注册 onChunk/onDone/onError，返回清理函数 */
  const streamCall = (opts: {
    requestId: string
    messages: ChatParams['messages']
    onResult: (text: string) => void
    onError: (msg: string) => void
    extra?: Partial<Pick<ChatParams,
      'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty' | 'presencePenalty' | 'instructTemplate'>>
  }) => {
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) return
    let result = ''
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== opts.requestId) return
      result += data.text
      // 流式实时展示（仅测试器用）
      if (opts.extra?.maxTokens === undefined) {
        // 默认非实时
      }
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== opts.requestId) return
      cleanup()
      opts.onResult(result)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== opts.requestId) return
      cleanup()
      opts.onError(data.error)
    })
    const cleanup = () => {
      unbindChunk(); unbindDone(); unbindError()
    }
    const settings = useSettingsStore.getState().settings
    window.api.ai.chat({
      requestId: opts.requestId,
      messages: opts.messages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: opts.extra?.temperature ?? 0.7,
      topP: opts.extra?.topP ?? 0.95,
      maxTokens: opts.extra?.maxTokens ?? 1024,
      frequencyPenalty: opts.extra?.frequencyPenalty ?? 0,
      presencePenalty: opts.extra?.presencePenalty ?? 0,
      stream: true,
      instructTemplate: opts.extra?.instructTemplate,
    }).catch(() => {
      cleanup()
    })
  }

  /** AI 生成预设：描述需求 → 生成 systemPrompt/jailbreak/参数建议 */
  const handleAiGenerate = async () => {
    if (!editingPreset || !aiGenDesc.trim() || aiGenBusy) return
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setAiGenError('请先在 API 设置中配置连接')
      return
    }
    setAiGenBusy(true)
    setAiGenError(null)
    const requestId = `preset-gen-${Date.now()}`
    streamCall({
      requestId,
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
      extra: { maxTokens: 1200 },
    })
  }

  /** 预设测试器：用当前预设参数对样例输入跑一次真实生成 */
  const handleTestGenerate = async () => {
    if (!editingPreset || !testInput.trim() || testBusy) return
    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setTestOutput('⚠ 请先在 API 设置中配置连接')
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
      maxTokens: editingPreset.maxTokens,
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
      const params = buildChatParamsFromData(data, built.messages)
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
    streamCall({
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
    if (testRequestRef.current) {
      window.api.ai.cancelChat(testRequestRef.current).catch(() => {})
      testRequestRef.current = null
      setTestBusy(false)
    }
  }

  const handleEdit = (preset: Preset) => {
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
            {grouped.map(([group, groupPresets]) => {
              const collapsed = collapsedGroups.has(group)
              return (
                <div key={group}>
                  <button
                    onClick={() => toggleGroup(group)}
                    className="flex items-center gap-1.5 text-sm font-medium text-tavern-text-muted hover:text-tavern-text w-full mb-2"
                  >
                    {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    <span>{group}</span>
                    <span className="text-xs text-tavern-text-muted/60">（{groupPresets.length} 个）</span>
                  </button>
                  {!collapsed && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {groupPresets.map((preset) => (
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
                              温度 {preset.temperature}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                              TopP {preset.topP}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                              Token {preset.maxTokens}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-tavern-bg-hover text-tavern-text-soft text-xs">
                              上下文 {preset.maxContext > 0 ? preset.maxContext : '跟随模型'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
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
                    onChange={(e) => setAiGenDesc(e.target.value)}
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
                <label className="label">分组</label>
                <input
                  className="input"
                  list="preset-groups"
                  value={editingPreset.group ?? ''}
                  onChange={(e) => updateField('group', e.target.value)}
                  placeholder="如：通用 / 越狱 / 风格特化"
                />
                <datalist id="preset-groups">
                  {grouped.map(([g]) => <option key={g} value={g} />)}
                </datalist>
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

            {/* Token 预算预览（第二批）：提示词体量直观可见 */}
            <div className="px-3 py-2 rounded-lg bg-tavern-bg-soft border border-tavern-border-soft text-xs flex items-center gap-3 flex-wrap">
              <span className="text-tavern-text-muted">提示词占用（估算）：</span>
              <span className="text-tavern-text-soft">System Prompt ≈ {estimateTokens(editingPreset.systemPrompt || '')} tok</span>
              <span className="text-tavern-text-soft">Jailbreak ≈ {estimateTokens(editingPreset.jailbreak || '')} tok</span>
              <span className="text-tavern-accent font-medium">合计 ≈ {estimateTokens((editingPreset.systemPrompt || '') + '\n\n' + (editingPreset.jailbreak || ''))} tok</span>
              <span className="text-tavern-text-muted/70">不含角色设定与世界书，实际以模型为准</span>
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

            {/* 采样参数快捷模板 */}
            <div>
              <label className="label">采样参数</label>
              <div className="flex gap-2 mb-3">
                {[
                  { name: '创意', temp: 1.1, topP: 0.98, fp: 0.3, pp: 0.3, desc: '高随机，剧情发散' },
                  { name: '平衡', temp: 0.8, topP: 0.95, fp: 0, pp: 0, desc: '通用默认' },
                  { name: '稳定', temp: 0.5, topP: 0.9, fp: 0, pp: 0, desc: '低随机，信息密集' },
                ].map((tpl) => (
                  <button
                    key={tpl.name}
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
              <div className="grid grid-cols-2 gap-4">
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
                <label className="label">最大 Token</label>
                <input
                  type="number"
                  min={1}
                  className="input"
                  value={editingPreset.maxTokens}
                  onChange={(e) => updateField('maxTokens', Number(e.target.value) || 1)}
                />
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
                  onChange={(e) => setTestInput(e.target.value)}
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
                      参数：温度 {editingPreset.temperature} · TopP {editingPreset.topP} · 最大 {editingPreset.maxTokens} tok
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
    </div>
  )
}
