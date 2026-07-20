import { useState } from 'react'
import { useSettingsStore } from '../store/useSettingsStore'
import { PROVIDER_INFO } from '../utils/defaults'
import { cn } from '../lib/utils'
import type { ProviderType, ConnectionProfile } from '../../shared/types'
import {
  Plug,
  Loader2,
  Check,
  X,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Circle,
  Zap,
  Volume2,
  Image,
  EyeIcon,
} from 'lucide-react'
import { TTSModelsSection } from '../components/api/TTSModelsSection'
import { ImageGenModelsSection } from '../components/api/ImageGenModelsSection'
import { VisionModelsSection } from '../components/api/VisionModelsSection'

const PROVIDERS: ProviderType[] = ['openai', 'claude', 'gemini', 'ollama']

/** 快速配置预设 */
const QUICK_PRESETS: Record<string, { name: string; provider: ProviderType; baseUrl: string; desc: string }> = {
  deepseek: { name: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', desc: '高性价比' },
  kimi: { name: 'Kimi', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', desc: '长上下文' },
  zhipu: { name: '智谱', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', desc: '清华系' },
  siliconflow: { name: '硅基流动', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', desc: '多模型' },
  dashscope: { name: '阿里百炼', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', desc: '通义千问' },
  openai: { name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', desc: 'GPT 系列' },
  ollama: { name: 'Ollama', provider: 'ollama', baseUrl: 'http://localhost:11434', desc: '本地运行' },
} as const

type PresetKey = keyof typeof QUICK_PRESETS

const TABS = [
  { key: 'chat', label: '对话 API', icon: Plug },
  { key: 'tts', label: 'TTS', icon: Volume2 },
  { key: 'image', label: '生图', icon: Image },
  { key: 'vision', label: '识图', icon: EyeIcon },
] as const

type TabKey = (typeof TABS)[number]['key']

/** 解析上下文长度输入，支持 128k/128K/1m/1M 简写 */
function parseContextInput(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/i)
  if (!match) return Number(trimmed) || 0
  const num = parseFloat(match[1])
  const unit = match[2]?.toLowerCase()
  if (unit === 'k') return Math.round(num * 1000)
  if (unit === 'm') return Math.round(num * 1000000)
  return num
}

/** 格式化上下文长度为可读字符串 */
function formatContextLength(n: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1000000) {
    const v = n / 1000000
    return v % 1 === 0 ? `${v}M` : `${v.toFixed(1)}M`
  }
  if (n >= 1000) {
    const v = n / 1000
    return v % 1 === 0 ? `${v}K` : `${v.toFixed(1)}K`
  }
  return String(n)
}

export function ApiPage() {
  const {
    settings,
    addProfile,
    updateProfile,
    deleteProfile,
    setActiveProfileId,
    getActiveProfile,
  } = useSettingsStore()

  const [tab, setTab] = useState<TabKey>('chat')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [contextRawInput, setContextRawInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { success: boolean; models?: string[]; error?: string } | null
  >(null)

  // 编辑表单临时状态
  const [editForm, setEditForm] = useState<ConnectionProfile>({
    id: '',
    name: '',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    apiKey: '',
    maxContext: 131072,
  })

  const activeProfile = getActiveProfile()
  const isConnected = activeProfile !== null && (activeProfile.provider === 'ollama' || !!activeProfile.apiKey)

  const resetForm = () => {
    setEditForm({ id: '', name: '', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', maxContext: 131072 })
    setContextRawInput('')
    setShowKey(false)
    setTestResult(null)
  }

  const openEdit = (p: ConnectionProfile) => {
    setEditForm({ ...p })
    setContextRawInput(formatContextLength(p.maxContext))
    setEditingId(p.id)
    setShowAdd(false)
    setShowKey(false)
    setTestResult(null)
  }

  const openAdd = () => {
    resetForm()
    setEditingId(null)
    setShowAdd(true)
  }

  const handleSave = () => {
    if (!editForm.name.trim()) return
    if (editingId) {
      updateProfile(editingId, editForm)
      setEditingId(null)
    } else {
      addProfile(editForm)
      setShowAdd(false)
    }
    resetForm()
  }

  const handleDelete = (id: string) => {
    deleteProfile(id)
    if (editingId === id) {
      setEditingId(null)
      resetForm()
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.ai.testConnection({
        type: editForm.provider,
        apiKey: editForm.apiKey,
        baseUrl: editForm.baseUrl,
        model: editForm.model || 'gpt-4o-mini',
      })
      setTestResult(res)
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : '未知错误' })
    } finally {
      setTesting(false)
    }
  }

  const applyPreset = (key: PresetKey) => {
    const preset = QUICK_PRESETS[key]
    setEditForm((f) => ({
      ...f,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
    }))
    setTestResult(null)
  }

  const providerLabel = (p: ProviderType) => PROVIDER_INFO[p].name

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <header className="flex items-center justify-between px-4 h-14 border-b border-tavern-border-soft bg-tavern-bg-soft shrink-0">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-tavern-accent" />
          <h1 className="font-display text-lg font-bold">API 设置</h1>
        </div>
        {/* 当前活跃状态 */}
        <div className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-tavern-success animate-pulse-soft' : 'bg-tavern-danger'
            )}
          />
          <span className="text-tavern-text-soft">
            {isConnected && activeProfile
              ? `${activeProfile.model || '未选模型'}`
              : '未连接'}
          </span>
        </div>
      </header>

      {/* Tab 导航 */}
      <div className="flex px-4 pt-2 gap-1 border-b border-tavern-border-soft bg-tavern-bg-soft">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-sm font-medium transition-colors -mb-px',
                tab === t.key
                  ? 'border border-b-0 border-tavern-border-soft bg-tavern-bg text-tavern-accent'
                  : 'text-tavern-text-muted hover:text-tavern-text hover:bg-tavern-bg-hover/50'
              )}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'chat' && (
          <div className="space-y-3">{renderChatProfiles()}</div>
        )}
        {tab === 'tts' && (
          <div>
            <h3 className="font-display text-sm font-semibold mb-3 text-tavern-text-soft flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-tavern-accent" />TTS 语音合成模型
            </h3>
            <TTSModelsSection />
          </div>
        )}
        {tab === 'image' && (
          <div>
            <h3 className="font-display text-sm font-semibold mb-3 text-tavern-text-soft flex items-center gap-2">
              <Image className="w-4 h-4 text-tavern-accent" />文本生图模型
            </h3>
            <ImageGenModelsSection />
          </div>
        )}
        {tab === 'vision' && (
          <div>
            <h3 className="font-display text-sm font-semibold mb-3 text-tavern-text-soft flex items-center gap-2">
              <EyeIcon className="w-4 h-4 text-tavern-accent" />识图模型
            </h3>
            <VisionModelsSection />
          </div>
        )}
      </div>
    </div>
  )

  function renderChatProfiles() {
    return (
      <>
        {settings.connectionProfiles.length === 0 && !showAdd ? (
          <div className="text-center py-12">
            <Plug className="w-12 h-12 text-tavern-text-muted mx-auto mb-3 opacity-30" />
            <p className="text-tavern-text-muted mb-3">还没有连接配置</p>
            <button onClick={openAdd} className="btn-primary inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" />
              添加连接
            </button>
          </div>
        ) : (
          <>
            {settings.connectionProfiles.map((p) => (
              <div
                key={p.id}
                className={cn(
                  'rounded-xl border transition-colors',
                  p.id === settings.activeProfileId
                    ? 'border-tavern-accent bg-tavern-accent-soft/30'
                    : 'border-tavern-border-soft bg-tavern-bg-card'
                )}
              >
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-tavern-bg-hover/50 rounded-t-xl"
                  onClick={() => {
                    if (editingId === p.id) {
                      setEditingId(null)
                      resetForm()
                    } else {
                      openEdit(p)
                    }
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Circle
                      className={cn(
                        'w-3 h-3 shrink-0',
                        p.id === settings.activeProfileId
                          ? 'text-tavern-success fill-current'
                          : 'text-tavern-text-muted'
                      )}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-tavern-text truncate">{p.name}</div>
                      <div className="text-xs text-tavern-text-muted">
                        {providerLabel(p.provider)}{p.model ? ` · ${p.model}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {p.id === settings.activeProfileId ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-tavern-accent-soft text-tavern-accent font-medium">
                        使用中
                      </span>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setActiveProfileId(p.id)
                        }}
                        className="text-xs px-2 py-0.5 rounded border border-tavern-border-soft text-tavern-text-muted hover:text-tavern-accent hover:border-tavern-accent transition-colors"
                      >
                        启用
                      </button>
                    )}
                  </div>
                </div>

                {editingId === p.id && (
                  <div className="px-4 pb-4 pt-1 border-t border-tavern-border-soft">
                    <div className="space-y-3 mt-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="input text-sm flex-1"
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          placeholder="连接名称（如：我的DeepSeek）"
                        />
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="p-2 rounded-lg text-tavern-text-muted hover:text-tavern-danger hover:bg-tavern-danger/10 transition-colors shrink-0"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div>
                        <label className="label">协议类型</label>
                        <div className="flex flex-wrap gap-1.5">
                          {PROVIDERS.map((pr) => (
                            <button
                              key={pr}
                              onClick={() => setEditForm((f) => ({ ...f, provider: pr }))}
                              className={cn(
                                'px-2.5 py-1 rounded text-xs border transition-colors',
                                editForm.provider === pr
                                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                                  : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
                              )}
                            >
                              {providerLabel(pr)}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="p-2.5 rounded-lg bg-tavern-bg border border-tavern-border-soft">
                        <div className="flex items-center gap-1 mb-1.5">
                          <Zap className="w-3 h-3 text-tavern-warning" />
                          <span className="text-xs text-tavern-text-soft">快速填入</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(Object.keys(QUICK_PRESETS) as PresetKey[]).map((key) => (
                            <button
                              key={key}
                              onClick={() => applyPreset(key)}
                              className={cn(
                                'px-2 py-0.5 rounded text-xs border transition-colors',
                                editForm.baseUrl === QUICK_PRESETS[key].baseUrl
                                  ? 'border-tavern-accent/50 bg-tavern-accent-soft text-tavern-accent'
                                  : 'border-tavern-border-soft hover:border-tavern-border text-tavern-text-soft bg-tavern-bg-soft'
                              )}
                            >
                              {QUICK_PRESETS[key].name}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label">Base URL</label>
                          <input
                            type="text"
                            className="input text-xs font-mono"
                            value={editForm.baseUrl}
                            onChange={(e) => setEditForm((f) => ({ ...f, baseUrl: e.target.value }))}
                          />
                        </div>
                        <div>
                          <label className="label">{PROVIDER_INFO[editForm.provider].keyLabel}</label>
                          <div className="relative">
                            <input
                              type={showKey ? 'text' : 'password'}
                              className="input text-xs pr-10"
                              value={editForm.apiKey}
                              onChange={(e) => setEditForm((f) => ({ ...f, apiKey: e.target.value }))}
                              placeholder={PROVIDER_INFO[editForm.provider].placeholder}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <button
                              type="button"
                              onClick={() => setShowKey((v) => !v)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-tavern-text-muted hover:text-tavern-text"
                            >
                              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="label">模型名称</label>
                        <input
                          type="text"
                          className="input text-sm"
                          value={editForm.model}
                          onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))}
                          placeholder="例如 gpt-4o-mini"
                        />
                      </div>

                      <div>
                        <label className="label">上下文长度 (Token)</label>
                        <input
                          type="text"
                          className="input text-sm"
                          value={contextRawInput || formatContextLength(editForm.maxContext)}
                          onChange={(e) => setContextRawInput(e.target.value)}
                          onBlur={() => {
                            if (contextRawInput.trim()) {
                              setEditForm((f) => ({ ...f, maxContext: parseContextInput(contextRawInput) }))
                              setContextRawInput(formatContextLength(parseContextInput(contextRawInput)))
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              (e.target as HTMLInputElement).blur()
                            }
                          }}
                          placeholder="例如 128K、200K、1M"
                        />
                        <p className="text-xs text-tavern-text-muted mt-1">
                          支持 128K / 1M 简写。GPT-4o-mini: 128K, Claude: 200K, Gemini Flash: 1M
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button onClick={handleTest} disabled={testing} className="btn-secondary text-xs">
                          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                          测试连接
                        </button>
                        <button onClick={handleSave} className="btn-primary text-xs">
                          <Check className="w-3.5 h-3.5" />
                          保存
                        </button>
                        <button
                          onClick={() => { setEditingId(null); resetForm() }}
                          className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
                        >
                          取消
                        </button>

                        {testResult && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded',
                              testResult.success
                                ? 'text-tavern-success bg-tavern-success/10'
                                : 'text-tavern-danger bg-tavern-danger/10'
                            )}
                          >
                            {testResult.success ? (
                              <><Check className="w-3 h-3" />成功</>
                            ) : (
                              <><X className="w-3 h-3" />失败</>
                            )}
                          </span>
                        )}
                      </div>

                      {testResult && !testResult.success && testResult.error && (
                        <p className="text-xs text-tavern-danger break-all bg-tavern-danger/5 rounded px-2 py-1.5">{testResult.error}</p>
                      )}

                      {testResult?.success && testResult.models && testResult.models.length > 0 && (
                        <div>
                          <p className="text-xs text-tavern-text-muted mb-1.5">可用模型（{testResult.models.length}）：</p>
                          <div className="flex flex-wrap gap-1">
                            {testResult.models.map((m) => (
                              <button
                                key={m}
                                onClick={() => setEditForm((f) => ({ ...f, model: m }))}
                                className={cn(
                                  'px-2 py-0.5 rounded text-xs font-mono border transition-colors',
                                  editForm.model === m
                                    ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                                    : 'border-tavern-border-soft bg-tavern-bg-soft hover:border-tavern-border text-tavern-text-soft'
                                )}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {showAdd ? (
              <div className="rounded-xl border border-tavern-accent bg-tavern-accent-soft/20">
                <div className="px-4 py-3 border-b border-tavern-border-soft flex items-center gap-2 text-sm font-medium text-tavern-accent">
                  <Plus className="w-4 h-4" />
                  新建连接
                </div>

                <div className="px-4 pb-4 pt-1">
                  <div className="space-y-3 mt-3">
                    <input
                      type="text"
                      className="input text-sm"
                      value={editForm.name}
                      onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="连接名称（如：我的DeepSeek）"
                      autoFocus
                    />

                    <div>
                      <label className="label">协议类型</label>
                      <div className="flex flex-wrap gap-1.5">
                        {PROVIDERS.map((pr) => (
                          <button
                            key={pr}
                            onClick={() => setEditForm((f) => ({ ...f, provider: pr }))}
                            className={cn(
                              'px-2.5 py-1 rounded text-xs border transition-colors',
                              editForm.provider === pr
                                ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                                : 'border-tavern-border-soft bg-tavern-bg-soft text-tavern-text-soft hover:border-tavern-border'
                            )}
                          >
                            {providerLabel(pr)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-tavern-bg border border-tavern-border-soft">
                      <div className="flex items-center gap-1 mb-1.5">
                        <Zap className="w-3 h-3 text-tavern-warning" />
                        <span className="text-xs text-tavern-text-soft">快速填入</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(Object.keys(QUICK_PRESETS) as PresetKey[]).map((key) => (
                          <button
                            key={key}
                            onClick={() => applyPreset(key)}
                            className={cn(
                              'px-2 py-0.5 rounded text-xs border transition-colors',
                              editForm.baseUrl === QUICK_PRESETS[key].baseUrl
                                ? 'border-tavern-accent/50 bg-tavern-accent-soft text-tavern-accent'
                                : 'border-tavern-border-soft hover:border-tavern-border text-tavern-text-soft bg-tavern-bg-soft'
                            )}
                          >
                            {QUICK_PRESETS[key].name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="label">Base URL</label>
                        <input
                          type="text"
                          className="input text-xs font-mono"
                          value={editForm.baseUrl}
                          onChange={(e) => setEditForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="label">{PROVIDER_INFO[editForm.provider].keyLabel}</label>
                        <div className="relative">
                          <input
                            type={showKey ? 'text' : 'password'}
                            className="input text-xs pr-10"
                            value={editForm.apiKey}
                            onChange={(e) => setEditForm((f) => ({ ...f, apiKey: e.target.value }))}
                            placeholder={PROVIDER_INFO[editForm.provider].placeholder}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            onClick={() => setShowKey((v) => !v)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-tavern-text-muted hover:text-tavern-text"
                          >
                            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="label">模型名称</label>
                      <input
                        type="text"
                        className="input text-sm"
                        value={editForm.model}
                        onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))}
                        placeholder="例如 gpt-4o-mini"
                      />
                    </div>

                    <div>
                      <label className="label">上下文长度 (Token)</label>
                      <input
                        type="text"
                        className="input text-sm"
                        value={contextRawInput || formatContextLength(editForm.maxContext)}
                        onChange={(e) => setContextRawInput(e.target.value)}
                        onBlur={() => {
                          if (contextRawInput.trim()) {
                            setEditForm((f) => ({ ...f, maxContext: parseContextInput(contextRawInput) }))
                            setContextRawInput(formatContextLength(parseContextInput(contextRawInput)))
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur()
                          }
                        }}
                        placeholder="例如 128K、200K、1M"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button onClick={handleTest} disabled={testing} className="btn-secondary text-xs">
                        {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                        测试连接
                      </button>
                      <button onClick={handleSave} disabled={!editForm.name.trim()} className="btn-primary text-xs">
                        <Check className="w-3.5 h-3.5" />
                        保存
                      </button>
                      <button
                        onClick={() => { setShowAdd(false); resetForm() }}
                        className="px-3 py-1.5 text-xs text-tavern-text-muted hover:text-tavern-text"
                      >
                        取消
                      </button>

                      {testResult && (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded',
                            testResult.success ? 'text-tavern-success bg-tavern-success/10' : 'text-tavern-danger bg-tavern-danger/10'
                          )}
                        >
                          {testResult.success ? (<><Check className="w-3 h-3" />成功</>) : (<><X className="w-3 h-3" />失败</>)}
                        </span>
                      )}
                    </div>

                    {testResult && !testResult.success && testResult.error && (
                      <p className="text-xs text-tavern-danger break-all bg-tavern-danger/5 rounded px-2 py-1.5">{testResult.error}</p>
                    )}

                    {testResult?.success && testResult.models && testResult.models.length > 0 && (
                      <div>
                        <p className="text-xs text-tavern-text-muted mb-1.5">可用模型（{testResult.models.length}）：</p>
                        <div className="flex flex-wrap gap-1">
                          {testResult.models.map((m) => (
                            <button
                              key={m}
                              onClick={() => setEditForm((f) => ({ ...f, model: m }))}
                              className={cn(
                                'px-2 py-0.5 rounded text-xs font-mono border transition-colors',
                                editForm.model === m
                                  ? 'border-tavern-accent bg-tavern-accent-soft text-tavern-accent'
                                  : 'border-tavern-border-soft bg-tavern-bg-soft hover:border-tavern-border text-tavern-text-soft'
                              )}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={openAdd}
                className="w-full flex items-center justify-center gap-1.5 py-3 rounded-xl border-2 border-dashed border-tavern-border-soft text-tavern-text-muted hover:border-tavern-accent hover:text-tavern-accent transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span className="text-sm">添加连接</span>
              </button>
            )}
          </>
        )}
      </>
    )
  }
}
